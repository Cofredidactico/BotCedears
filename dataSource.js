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
const CACHE_TTL_MS = 60 * 1000;
const COINGECKO = 'https://api.coingecko.com/api/v3';

const _cache = new Map();
function cached(key, ttl, fn) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.t < ttl) return hit.p;
  const p = Promise.resolve().then(fn).catch(err => { _cache.delete(key); throw err; });
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
    return { usd, changePct, cedearArs: u.ratio ? usd / u.ratio * ccl : null, volumeArsM: Math.round(50 + r() * 1500), isReal: false };
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
    const scf = u.refPriceUsd / c[c.length - 1];
    for (const k of [o, h, l, c]) for (let i = 0; i < k.length; i++) k[i] *= scf;
    return { o, h, l, c, v, isReal: false };
  },
  async getFundamentals() { return { hasData: false, isReal: false }; },
  async getNews() { return { items: [], sentimentScore: null, isReal: false }; },
};

/* ═════════════════════════════ LIVE ═══════════════════════════════════ */
const Live = {
  async getCCL() {
    return cached('ccl', CACHE_TTL_MS, async () => {
      const r = await fetch(`${API_BASE}/ccl`); if (!r.ok) throw new Error('ccl ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getQuote(ticker) {
    return cached('q:' + ticker, CACHE_TTL_MS, async () => {
      const r = await fetch(`${API_BASE}/quote?symbol=${encodeURIComponent(ticker)}`);
      if (!r.ok) throw new Error('quote ' + r.status);
      const d = await r.json(); return { ...d, isReal: true };
    });
  },
  async getCandles(ticker, tf = '1day', n = 200) {
    return cached(`c:${ticker}:${tf}:${n}`, CACHE_TTL_MS, async () => {
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
};

/* ═══════════════════════ CoinGecko directo (cripto, sin key) ═══════════════ */
const Crypto = {
  async getQuote(ticker, coingeckoId) {
    return cached('cgq:' + ticker, CACHE_TTL_MS, async () => {
      const r = await fetch(`${COINGECKO}/simple/price?ids=${coingeckoId}&vs_currencies=usd&include_24hr_change=true`);
      if (!r.ok) throw new Error('coingecko quote ' + r.status);
      const d = await r.json();
      const entry = d[coingeckoId];
      if (!entry) throw new Error('coingecko: id desconocido');
      return { usd: entry.usd, changePct: entry.usd_24h_change ?? 0, cedearArs: null, volumeArsM: null, isReal: true };
    });
  },
  async getCandles(ticker, coingeckoId, days = 180) {
    return cached('cgc:' + ticker, CACHE_TTL_MS, async () => {
      const r = await fetch(`${COINGECKO}/coins/${coingeckoId}/ohlc?vs_currency=usd&days=${days}`);
      if (!r.ok) throw new Error('coingecko ohlc ' + r.status);
      const rows = await r.json(); // [ [time,o,h,l,c], ... ]
      const o = [], h = [], l = [], c = [], v = [];
      for (const row of rows) { o.push(row[1]); h.push(row[2]); l.push(row[3]); c.push(row[4]); v.push(0); }
      // CoinGecko OHLC gratuito no trae volumen — se documenta como no disponible,
      // liquidez/OBV/VWAP quedan en N/D para cripto en vez de inventarse.
      return { o, h, l, c, v, isReal: true };
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

export const isLive = () => MODE === 'live';
export const TF_MAP = { '5m': '5min', '15m': '15min', '1h': '1h', '4h': '4h', '1d': '1day', '1w': '1week', '1mo': '1month' };
