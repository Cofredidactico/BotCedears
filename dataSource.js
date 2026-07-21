/**
 * dataSource.js — Capa de datos única de Investment Copilot AI.
 * ─────────────────────────────────────────────────────────────────────────────
 * Es la ÚNICA pieza que el front toca para obtener datos. El motor de
 * indicadores (indicators.js) y de score (scoring.js) NO saben de dónde
 * vienen los números — solo reciben OHLCV, cotización, fundamentales,
 * noticias y macro ya resueltos.
 *
 *   App (indicators.js + scoring.js)  ──►  dataSource  ──►  Live | Mock
 *                                              │
 *                                   /api/quote, /api/candles, /api/ccl,
 *                                   /api/fundamentals, /api/news  (serverless,
 *                                   la API key vive ahí — Finnhub + Twelve Data)
 *                                   + CoinGecko directo para cripto (sin key)
 *                                   + macro.json (snapshot manual, ver README)
 *
 * MODE por defecto es 'live'. Si una llamada real falla, cae a Mock para esa
 * pieza puntual y marca isReal=false, así una sola fuente caída no tira abajo
 * todo el reporte — pero connectionState refleja la degradación real.
 */

const urlMode = typeof window !== 'undefined' ? new URLSearchParams(window.location.search).get('mode') : null;
const MODE = urlMode || (typeof window !== 'undefined' && window.CEDEAR_MODE) || 'live'; // 'live' | 'mock' — probar local sin keys con ?mode=mock
const API_BASE = (typeof window !== 'undefined' && window.CEDEAR_API_BASE) || '/api';
// Twelve Data free tier comparte un cupo de créditos DIARIO entre todos los
// visitantes del sitio (no solo ~8 req/min) — quedarse sin cupo un día tira
// abajo el gráfico y el análisis técnico de todos hasta el día siguiente
// (ver fix de precio no coincidente en NVDA). El precio (Finnhub, cupo propio
// y más generoso) se refresca seguido para sentirse "vivo", pero las velas
// cambian poco de una visita a otra dentro del mismo día — cachearlas mucho
// más tiempo es la forma más segura de no repetir ese problema.
const QUOTE_TTL_MS = 60 * 1000;
const CANDLES_TTL_MS_INTRADAY = 10 * 60 * 1000; // 45min/4h: se agrega una vela nueva seguido
const CANDLES_TTL_MS_DAILY = 45 * 60 * 1000; // 1day/1week: alcanza y sobra para análisis técnico swing
function candlesTtlFor(tf) { return (tf === '45min' || tf === '4h') ? CANDLES_TTL_MS_INTRADAY : CANDLES_TTL_MS_DAILY; }
const COINGECKO = 'https://api.coingecko.com/api/v3';

/* Caché en memoria (por pestaña) + respaldo en localStorage (sobrevive a
 * recargas de página, que si no volverían a pedir todo de cero). */
const LS_PREFIX = 'icp_cache_';
function lsGet(key, ttl) {
  try {
    const raw = localStorage.getItem(LS_PREFIX + key);
    if (!raw) return undefined;
    const { t, v } = JSON.parse(raw);
    if (Date.now() - t > ttl) return undefined;
    return v;
  } catch { return undefined; }
}
function lsSet(key, value) {
  try { localStorage.setItem(LS_PREFIX + key, JSON.stringify({ t: Date.now(), v: value })); }
  catch { /* localStorage lleno o no disponible (modo privado, SSR, etc.) — no es crítico */ }
}

const _cache = new Map();
function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const fromDisk = lsGet(key, ttl);
  if (fromDisk !== undefined) {
    const p = Promise.resolve(fromDisk);
    _cache.set(key, { t: Date.now(), p });
    return p;
  }
  const p = Promise.resolve().then(fn).then(v => { lsSet(key, v); return v; }).catch(err => { _cache.delete(key); throw err; });
  _cache.set(key, { t: Date.now(), p });
  return p;
}

let _universe = null;
export async function getUniverse() {
  if (_universe) return _universe;
  const res = await fetch('./universe.json');
  _universe = await res.json();
  return _universe;
}

export async function getAsset(ticker) {
  const u = await getUniverse();
  return u.find(a => a.ticker === ticker) || null;
}

let _macro = null;
export async function getMacroSnapshot() {
  if (_macro) return _macro;
  const res = await fetch('./macro.json');
  _macro = await res.json();
  return _macro;
}

/* ═════════════════════════════ MOCK (fallback) ═══════════════════════════ */
function mulberry32(a) { return function () { a |= 0; a = a + 0x6D2B79F5 | 0; let t = Math.imul(a ^ a >>> 15, 1 | a); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
function hsh(s) { let h = 2166136261 >>> 0; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

const Mock = {
  async getCCL() { return { value: 1247.5, changePct: 0.34, isReal: false }; },
  async getQuote(ticker) {
    const u = (await getAsset(ticker)) || { refPriceUsd: 100, ratio: 10 };
    const r = mulberry32(hsh(ticker) ^ 0x55);
    const usd = u.refPriceUsd, changePct = (r() - 0.45) * 4;
    const ccl = (await this.getCCL()).value;
    return { usd, changePct, cedearArs: u.ratio ? usd / u.ratio * ccl : null, cedearSource: u.ratio ? 'estimated' : null, volumeArsM: Math.round(50 + r() * 1500), isReal: false };
  },
  async getCandles(ticker, tf = '1day', n = 200) {
    const u = (await getAsset(ticker)) || { refPriceUsd: 100 };
    const seed = hsh(ticker) ^ hsh(tf), rnd = mulberry32(seed);
    const vol = 0.012 + rnd() * 0.022, drift = (rnd() - 0.45) * 0.006;
    const o = [], h = [], l = [], c = [], v = []; let price = 100;
    for (let i = 0; i < n; i++) {
      const op = price, shock = (rnd() - 0.5) * 2 * vol + drift;
      let cp = op * (1 + shock); if (cp < 1) cp = 1;
      const wick = op * vol * (0.5 + rnd());
      o.push(op); h.push(Math.max(op, cp) + wick * rnd()); l.push(Math.min(op, cp) - wick * rnd()); c.push(cp); v.push(Math.round(500000 + rnd() * 4000000));
      price = cp;
    }
    // Hueco (gap) de apertura de demostración en la última rueda para ~35% de
    // los tickers, determinista por seed — así el Radar de Gaps tiene contenido
    // en modo demo (en producción, con velas reales, los gaps salen solos).
    if (n >= 2) {
      const gr = mulberry32(seed ^ 0x9e37);
      if (gr() < 0.35) {
        const gapPct = (gr() < 0.5 ? 1 : -1) * (0.012 + gr() * 0.03); // ±1.2%..±4.2%
        const prevC = c[n - 2];
        const newOpen = prevC * (1 + gapPct);
        const intraShock = (gr() - 0.45) * 2 * vol;
        let newClose = newOpen * (1 + intraShock); if (newClose < 1) newClose = 1;
        const wick = newOpen * vol * (0.5 + gr());
        o[n - 1] = newOpen;
        c[n - 1] = newClose;
        h[n - 1] = Math.max(newOpen, newClose) + wick * gr();
        l[n - 1] = Math.min(newOpen, newClose) - wick * gr();
      }
    }
    const scf = u.refPriceUsd / c[c.length - 1];
    for (const k of [o, h, l, c]) for (let i = 0; i < k.length; i++) k[i] *= scf;
    const t = [];
    for (let i = n - 1; i >= 0; i--) { const d = new Date(); d.setDate(d.getDate() - i); t.push(d.toISOString().slice(0, 10)); }
    return { o, h, l, c, v, t, isReal: false };
  },
  // Sin fundamentales reales en modo mock. Se sintetiza SOLO un flujo de
  // insiders de demostración (para poder ver la tarjeta "Flujo de Insiders"
  // en el modo demo) — en producción esto lo reemplaza Finnhub con las
  // operaciones reales de los formularios 3/4/5 de la SEC.
  async getFundamentals(ticker) {
    const seed = String(ticker || '').split('').reduce((a, c) => a + c.charCodeAt(0), 0);
    const bought = 20000 + (seed * 137 % 90000);
    const sold = 15000 + (seed * 91 % 70000);
    const insider = {
      windowDays: 183,
      boughtShares: bought, soldShares: sold,
      buyCount: 1 + seed % 4, sellCount: 1 + (seed * 3) % 5,
      distinctBuyers: 1 + seed % 3, distinctSellers: 1 + (seed * 2) % 3,
      netOpenMarket: bought - sold, netShares: bought - sold,
      bias: bought >= sold * 1.3 ? 'compra' : sold >= bought * 1.3 ? 'venta' : 'neutral',
      totalRecords: 6,
      transactions: [
        { name: 'Directivo (demo)', date: new Date(Date.now() - 6 * 86400e3).toISOString().slice(0, 10), change: Math.round(bought / 2), code: 'P', price: null },
        { name: 'Director (demo)', date: new Date(Date.now() - 20 * 86400e3).toISOString().slice(0, 10), change: -Math.round(sold / 2), code: 'S', price: null },
      ],
    };
    return { hasData: false, isReal: false, insider };
  },
  // Consenso de analistas de demostración (determinístico por ticker) para ver
  // la tarjeta en modo demo; en producción lo reemplaza Finnhub. Misma forma que
  // devuelve /api/recommendations.
  async getRecommendations(ticker) {
    const u = await getAsset(ticker);
    if (u && (u.category === 'Cripto' || u.category === 'ETF')) return { hasData: false, isReal: false };
    const rnd = mulberry32(hsh(ticker) ^ 0x9e3);
    const sum = (row) => {
      const total = row.strongBuy + row.buy + row.hold + row.sell + row.strongSell;
      const scored = (row.strongBuy * 5 + row.buy * 4 + row.hold * 3 + row.sell * 2 + row.strongSell) / total;
      return { ...row, total, scored: Math.round(scored * 100) / 100, scored100: Math.round(((scored - 1) / 4) * 100), bullishPct: Math.round((row.strongBuy + row.buy) / total * 100), bearishPct: Math.round((row.sell + row.strongSell) / total * 100), label: scored >= 4.5 ? 'Compra fuerte' : scored >= 3.5 ? 'Compra' : scored >= 2.5 ? 'Mantener' : scored >= 1.5 ? 'Venta' : 'Venta fuerte' };
    };
    const mk = (p) => ({ period: p, strongBuy: 3 + Math.round(rnd() * 8), buy: 5 + Math.round(rnd() * 10), hold: 3 + Math.round(rnd() * 7), sell: Math.round(rnd() * 3), strongSell: Math.round(rnd() * 1) });
    const latest = sum(mk('demo')), prev = sum(mk('demo-prev'));
    const trend = Math.abs(latest.scored - prev.scored) < 0.05 ? 'estable' : latest.scored > prev.scored ? 'mejorando' : 'empeorando';
    return { hasData: true, latest, prev, trend, priceTarget: null, isReal: false };
  },
  async getNews() { return { items: [], sentimentScore: null, isReal: false }; },
  async getGeneralNews() { return { items: [], sentimentScore: null, isReal: false }; },
  async getEarnings() { return { nextDate: null, isReal: false }; },
  // Sin dato real de inflación disponible en modo mock — se devuelve vacío
  // en vez de inventar meses de IPC (el retorno real necesita el número
  // verdadero, no uno simulado que no representaría nada).
  async getInflacion() { return { items: [], isReal: false }; },
  // Sin serie histórica real del CCL en modo mock — vacío en vez de inventar
  // cotizaciones pasadas (los benchmarks de cartera necesitan el dato real).
  async getCCLHistory() { return { items: [], isReal: false }; },
  // En modo demo se sintetiza un historial plausible de dividendos para los
  // pagadores conocidos (misma lógica de "datos de demostración" que las
  // velas/quotes mock, con badges "demo" en toda la UI). En producción esto lo
  // reemplaza Yahoo con las fechas ex-dividend reales.
  async getDividends(ticker) {
    const PROFILE = { // yield anual aprox + frecuencia por año
      KO: [3.0, 4], JNJ: [3.0, 4], PG: [2.4, 4], VZ: [6.5, 4], T: [5.0, 4], XOM: [3.3, 4],
      CVX: [4.2, 4], PFE: [6.0, 4], MO: [8.0, 4], PM: [5.0, 4], IBM: [4.0, 4], MMM: [5.5, 4],
      KO_: [3, 4], MSFT: [0.8, 4], AAPL: [0.5, 4], JPM: [2.2, 4], HD: [2.4, 4], MCD: [2.3, 4],
      PEP: [3.2, 4], KMB: [3.6, 4], GIS: [3.4, 4], O: [5.5, 12], MAIN: [6.5, 12],
      NVDA: [0.03, 4], AVGO: [1.2, 4], TXN: [2.9, 4], CSCO: [2.8, 4], BAC: [2.4, 4],
      WMT: [1.2, 4], GGAL: [1.5, 4], YPF: [0, 0], BMA: [3.0, 2],
    };
    const p = PROFILE[ticker];
    if (!p || p[1] === 0) return { items: [], frequency: null, ttm: 0, nextExDate: null, isReal: false };
    const [yld, perYear] = p;
    const u = (await getAsset(ticker)) || { refPriceUsd: 100 };
    const perPay = (u.refPriceUsd * yld / 100) / perYear;
    const intervalDays = Math.round(365 / perYear);
    const items = [];
    const today = new Date();
    for (let i = 0; i < perYear * 3; i++) {
      const d = new Date(today); d.setDate(d.getDate() - i * intervalDays - 10);
      // leve crecimiento del pago hacia el presente
      const amt = perPay * (1 - i * 0.008);
      items.push({ date: d.toISOString().slice(0, 10), amount: Math.round(amt * 1000) / 1000 });
    }
    const ttm = items.filter(x => (Date.now() - new Date(x.date).getTime()) < 365 * 86400000).reduce((s, x) => s + x.amount, 0);
    const next = new Date(items[0].date); next.setDate(next.getDate() + intervalDays);
    const freqLabel = perYear === 12 ? 'Mensual' : perYear === 4 ? 'Trimestral' : perYear === 2 ? 'Semestral' : 'Anual';
    return { items, frequency: freqLabel, perYear, medianIntervalDays: intervalDays, ttm, nextExDate: next.toISOString().slice(0, 10), nextExEstimated: true, lastAmount: items[0].amount, lastExDate: items[0].date, cagr3y: 2.4, isReal: false };
  },
  async getBonds() { return { items: [], isReal: false }; },
};

/* ═════════════════════════════ LIVE ═══════════════════════════════════ */
const Live = {
  async getCCL() {
    return cached('ccl', QUOTE_TTL_MS, async () => {
      const r = await fetch(`${API_BASE}/ccl`); if (!r.ok) throw new Error('ccl ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getQuote(ticker) {
    return cached('q:' + ticker, QUOTE_TTL_MS, async () => {
      const r = await fetch(`${API_BASE}/quote?symbol=${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('quote ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getCandles(ticker, tf = '1day', n = 200) {
    return cached(`c:${ticker}:${tf}:${n}`, candlesTtlFor(tf), async () => {
      const r = await fetch(`${API_BASE}/candles?symbol=${encodeURIComponent(ticker)}&interval=${tf}&outputsize=${n}`);
      if (!r.ok) throw new Error('candles ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getFundamentals(ticker) {
    return cached('f:' + ticker, 60 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/fundamentals?symbol=${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('fundamentals ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getNews(ticker) {
    return cached('n:' + ticker, 15 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/news?symbol=${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('news ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getRecommendations(ticker) {
    return cached('rec:' + ticker, 6 * 60 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/recommendations?symbol=${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('recommendations ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getGeneralNews() {
    return cached('n:general', 10 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/news?general=1`);
      if (!r.ok) throw new Error('news general ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getMacroLive() {
    return cached('macro-live', 5 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/macro`);
      if (!r.ok) throw new Error('macro ' + r.status);
      return r.json();
    });
  },
  async getEarnings(ticker) {
    return cached('e:' + ticker, 6 * 60 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/earnings?symbol=${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('earnings ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getInflacion() {
    return cached('inflacion', 12 * 60 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/inflacion`);
      if (!r.ok) throw new Error('inflacion ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getDividends(ticker) {
    return cached('div:' + ticker, 6 * 60 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/dividends?symbol=${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('dividends ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  // Serie histórica del CCL — directo a argentinadatos.com desde el browser
  // (permite CORS), sin pasar por una función de Vercel: el plan Hobby ya
  // está en el tope de 12 funciones y esta fuente no necesita API key.
  async getCCLHistory() {
    return cached('ccl-hist', 12 * 60 * 60 * 1000, async () => {
      const r = await fetch('https://api.argentinadatos.com/v1/cotizaciones/dolares/contadoconliqui');
      if (!r.ok) throw new Error('ccl history ' + r.status);
      const d = await r.json(); // [{casa, compra, venta, fecha}]
      const items = (Array.isArray(d) ? d : [])
        .filter(x => x?.fecha && x?.venta > 0)
        .map(x => ({ fecha: x.fecha, venta: x.venta }))
        .sort((a, b) => a.fecha.localeCompare(b.fecha));
      return { items, isReal: true };
    });
  },
  async getBonds() {
    return cached('bonds', 2 * 60 * 1000, async () => {
      const r = await fetch(`${API_BASE}/bonds`);
      if (!r.ok) throw new Error('bonds ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
};

/* ═══════════════════════ CoinGecko directo (cripto, sin key) ═══════════════ */
const Crypto = {
  async getQuote(ticker, coingeckoId) {
    return cached('cgq:' + ticker, QUOTE_TTL_MS, async () => {
      const r = await fetch(`${COINGECKO}/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_24hr_change=true`);
      if (!r.ok) throw new Error('coingecko quote ' + r.status);
      const d = await r.json();
      const entry = d[coingeckoId];
      if (!entry) throw new Error('coingecko: id desconocido');
      return { usd: entry.usd, changePct: entry.usd_24h_change ?? 0, cedearArs: null, volumeArsM: null, isReal: true };
    });
  },
  async getCandles(ticker, coingeckoId, days = 180) {
    return cached('cgc:' + ticker, CANDLES_TTL_MS_DAILY, async () => {
      const r = await fetch(`${COINGECKO}/coins/${coingeckoId}/ohlc?vs_currency=usd&days=${days}`);
      if (!r.ok) throw new Error('coingecko ohlc ' + r.status);
      const rows = await r.json(); // [ [time,o,h,l,c], ... ]
      const o = [], h = [], l = [], c = [], v = [], t = [];
      for (const row of rows) { o.push(row[1]); h.push(row[2]); l.push(row[3]); c.push(row[4]); v.push(0); t.push(new Date(row[0]).toISOString().slice(0, 10)); }
      // CoinGecko OHLC gratuito no trae volumen — se documenta como no disponible,
      // liquidez/OBV/VWAP quedan en N/D para cripto en vez de inventarse.
      return { o, h, l, c, v, t, isReal: true };
    });
  },
};

/* ═══════════════════ fachada con fallback seguro por pieza ═══════════════ */
async function withFallback(name, args, mockFn) {
  if (MODE === 'mock') return mockFn(...args);
  try { return await Live[name](...args); }
  catch (e) { console.warn(`[dataSource] live ${name} falló, usando mock:`, e.message); return mockFn(...args); }
}

export async function getCCL() { return withFallback('getCCL', [], Mock.getCCL.bind(Mock)); }

export async function getQuote(ticker) {
  const asset = await getAsset(ticker);
  if (MODE !== 'mock' && asset?.category === 'Cripto') {
    try { return await Crypto.getQuote(ticker, asset.coingeckoId); }
    catch (e) { console.warn('[dataSource] cripto quote falló, usando mock:', e.message); return Mock.getQuote(ticker); }
  }
  return withFallback('getQuote', [ticker], Mock.getQuote.bind(Mock));
}

export async function getCandles(ticker, tf = '1day', n = 200) {
  const asset = await getAsset(ticker);
  if (MODE !== 'mock' && asset?.category === 'Cripto') {
    try { return await Crypto.getCandles(ticker, asset.coingeckoId); }
    catch (e) { console.warn('[dataSource] cripto candles falló, usando mock:', e.message); return Mock.getCandles(ticker, tf, n); }
  }
  return withFallback('getCandles', [ticker, tf, n], Mock.getCandles.bind(Mock));
}

export async function getFundamentals(ticker) {
  const asset = await getAsset(ticker);
  if (asset?.category === 'Cripto' || asset?.category === 'ETF') return { hasData: false, isReal: true }; // no aplica, no es "sin conexión"
  return withFallback('getFundamentals', [ticker], Mock.getFundamentals.bind(Mock));
}

export async function getNews(ticker) {
  return withFallback('getNews', [ticker], Mock.getNews.bind(Mock));
}

export async function getGeneralNews() {
  return withFallback('getGeneralNews', [], Mock.getGeneralNews.bind(Mock));
}

export async function getRecommendations(ticker) {
  const asset = await getAsset(ticker);
  if (asset?.category === 'Cripto' || asset?.category === 'ETF') return { hasData: false, isReal: true };
  return withFallback('getRecommendations', [ticker], Mock.getRecommendations.bind(Mock));
}

export async function getEarnings(ticker) {
  const asset = await getAsset(ticker);
  if (asset?.category === 'Cripto' || asset?.category === 'ETF') return { nextDate: null, isReal: true }; // no aplica
  return withFallback('getEarnings', [ticker], Mock.getEarnings.bind(Mock));
}

export async function getInflacion() {
  return withFallback('getInflacion', [], Mock.getInflacion.bind(Mock));
}

export async function getDividends(ticker) {
  const asset = await getAsset(ticker);
  if (asset?.category === 'Cripto') return { items: [], isReal: true }; // no aplica
  return withFallback('getDividends', [ticker], Mock.getDividends.bind(Mock));
}

export async function getCCLHistory() {
  return withFallback('getCCLHistory', [], Mock.getCCLHistory.bind(Mock));
}

export async function getBonds() {
  return withFallback('getBonds', [], Mock.getBonds.bind(Mock));
}

/** Combina el snapshot manual (macro.json) con la fuente en vivo (/api/macro:
 *  riesgo país + dólares + Fear&Greed siempre; VIX/DXY solo si Twelve Data
 *  los pudo servir). Si /api/macro falla entero, cae 100% al snapshot manual. */
export async function getMacro() {
  const staticSnap = await getMacroSnapshot();
  if (MODE === 'mock') return { ...staticSnap, isReal: false };
  try {
    const live = await Live.getMacroLive();
    return {
      ...staticSnap,
      dxy: live.dxy ?? staticSnap.dxy,
      vix: live.vix ?? staticSnap.vix,
      riesgoPaisArg: live.riesgoPaisArg ?? staticSnap.riesgoPaisArg,
      riesgoPaisVariacion: live.riesgoPaisVariacion ?? null,
      dolares: live.dolares ?? null,
      fearGreed: live.fearGreed ?? null,
      liveFetchedAt: live.fetchedAt ?? null,
      isReal: true,
    };
  } catch (e) {
    console.warn('[dataSource] macro en vivo falló, usando snapshot manual:', e.message);
    return { ...staticSnap, isReal: false };
  }
}

export const isLive = () => MODE === 'live';
export const TF_MAP = { '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week', '1mo': '1month' };
