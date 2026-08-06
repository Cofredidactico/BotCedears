// Carga de universe.json compatible con ESM en cualquier versión de Node: el
// import estático de JSON (import x from './y.json') exige el atributo
// `with { type: 'json' }` bajo ESM (package.json type:module) y crashea sin él
// (ERR_IMPORT_ATTRIBUTE_MISSING → FUNCTION_INVOCATION_FAILED en Vercel).
// createRequire evita el atributo y Vercel/nft traza el require estático para
// incluir el JSON en el bundle de la función.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const universe = require('../universe.json');

const FINNHUB = 'https://finnhub.io/api/v1';
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart';

// Algunos sitios filtran requests sin un User-Agent de navegador desde IPs de
// datacenter (como las de Vercel) — se manda uno genérico por las dudas.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Compañías argentinas cuyo ticker de ADR (el que usa Finnhub/el resto del
// sitio) no coincide con el ticker de la acción local en BYMA.
const AR_LOCAL_SYMBOL = { YPF: 'YPFD', PAM: 'PAMP', TGS: 'TGSU2', IRS: 'IRSA', CRESY: 'CRES', TEO: 'TECO2' };

// Cache best-effort en memoria del proceso: sobrevive entre invocaciones si
// Vercel reutiliza la misma instancia "tibia" (común entre requests
// seguidos), y si no, simplemente se vuelve a pedir — no rompe nada.
let realPriceCache = null; // { at, map: { symbol -> último precio ARS } }
let cclCache = null; // { at, value } — CCL de referencia para ratio implícito / estimaciones

// Ratios estándar que usa BYMA — el ratio implícito medido se ajusta al más
// cercano de esta lista SOLO si coincide a ≤5%; si no, se respeta el estático.
const STD_RATIOS = [0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 9, 10, 12, 15, 16, 18, 20, 24, 25, 29, 30, 36, 40, 46, 50, 60, 72, 80, 90, 100, 120, 150, 180, 200];

async function getCclRef() {
  const now = Date.now();
  if (cclCache && now - cclCache.at < 55_000) return cclCache.value;
  try {
    const d = await (await fetch('https://dolarapi.com/v1/dolares/contadoconliqui', { headers: { 'User-Agent': BROWSER_UA } })).json();
    const value = (d.venta + d.compra) / 2 || d.venta;
    if (value > 0) { cclCache = { at: now, value }; return value; }
  } catch (_) {}
  return cclCache?.value ?? 1554.65;
}

// Respaldo de precio del subyacente vía Yahoo Finance (gratis, sin API key,
// cubre acciones Y ETFs — donde el free tier de Finnhub falla o no tiene
// cobertura). Usa el chart diario: regularMarketPrice + cierre previo → % día.
async function yahooUsdQuote(symbol) {
  // range=1d → chartPreviousClose es el cierre de AYER (cambio diario correcto).
  // Con rangos más largos ese campo apunta a varios días atrás y da un % inflado.
  const url = `${YF}/${encodeURIComponent(symbol)}?interval=1d&range=1d`;
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const d = await r.json();
  const meta = d?.chart?.result?.[0]?.meta;
  const price = meta?.regularMarketPrice;
  const prev = meta?.chartPreviousClose ?? meta?.previousClose ?? null;
  if (!(price > 0)) throw new Error('yahoo: sin precio válido para ' + symbol);
  const changePct = prev > 0 ? (price / prev - 1) * 100 : 0;
  return { usd: price, changePct };
}

async function getRealArsPriceMap() {
  const now = Date.now();
  if (realPriceCache && now - realPriceCache.at < 55_000) return realPriceCache.map;
  try {
    const [cedears, stocks] = await Promise.all([
      fetch('https://data912.com/live/arg_cedears', { headers: { 'User-Agent': BROWSER_UA } }).then(r => r.json()),
      fetch('https://data912.com/live/arg_stocks', { headers: { 'User-Agent': BROWSER_UA } }).then(r => r.json()),
    ]);
    const map = {};
    for (const x of [...cedears, ...stocks]) {
      if (x?.symbol && x.c != null) map[x.symbol] = x.c;
    }
    realPriceCache = { at: now, map };
    return map;
  } catch (_) {
    return realPriceCache?.map ?? null; // si falla, usar lo último conocido antes que nada
  }
}

export default async function handler(req, res) {
  // Sub-ruta de pre-market: /api/quote?premarket=1&symbols=A,B,C. Se fusionó acá
  // (en vez de una función aparte) para no pasar el límite de 12 serverless
  // functions del plan gratuito de Vercel. Ver handlePreMarket más abajo.
  if (req.query.premarket || req.query.symbols) return handlePreMarket(req, res);

  const symbol = String(req.query.symbol || '').toUpperCase();

  const asset = universe.find(a => a.ticker === symbol);
  if (!asset) return res.status(404).json({ error: 'symbol desconocido', universeLen: universe.length });

  try {
    const [fq, realPriceMap] = await Promise.all([
      fetch(`${FINNHUB}/quote?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`).then(r => r.json()).catch(() => ({})),
      asset.ratio != null ? getRealArsPriceMap() : Promise.resolve(null),
    ]);
    // Finnhub a veces devuelve 200 con un cuerpo sin el campo `c` (precio):
    // bajo carga (rate limit del free tier), o SIN COBERTURA (el free tier de
    // Finnhub dejó afuera muchos ETFs y algunos papeles). Antes eso tiraba el
    // símbolo a "demo". Ahora, si Finnhub no trae precio, se cae a Yahoo
    // Finance (gratis, sin key, cubre acciones y ETFs) — así KO, los ETFs y
    // demás dejan de figurar como demostración cuando en realidad hay dato real.
    let usd, changePct, priceSource;
    if (typeof fq.c === 'number' && fq.c > 0) {
      usd = fq.c; changePct = fq.dp ?? 0; priceSource = 'finnhub';
    } else {
      const y = await yahooUsdQuote(symbol); // si esto también falla → catch → 502 → demo (correcto)
      usd = y.usd; changePct = y.changePct; priceSource = 'yahoo';
    }

    let cedearArs = null, cedearSource = null, ratio = asset.ratio, ratioSource = 'static', cclImplied = null, cclRef = null;
    if (asset.ratio != null) {
      const localSymbol = AR_LOCAL_SYMBOL[symbol] || symbol;
      const realPrice = realPriceMap?.[localSymbol];
      if (realPrice != null) {
        // Precio real operado hoy en BYMA — la fuente más confiable posible,
        // ya que el precio teórico (CCL) puede diferir del precio de mercado.
        cedearArs = realPrice;
        cedearSource = 'live';
        // Autocorrección de ratio: BYMA re-ratea CEDEARs cada tanto y el
        // ratio estático del universo queda viejo. Con USD + ARS + CCL en
        // vivo se mide el ratio implícito y, si coincide a ≤5% con un ratio
        // estándar distinto del guardado, se usa el medido. Si no coincide
        // con ninguno (dato raro, papel sin operar), se respeta el estático.
        cclRef = await getCclRef();
        const implied = (usd * cclRef) / realPrice;
        const snapped = STD_RATIOS.reduce((best, s) => Math.abs(implied / s - 1) < Math.abs(implied / best - 1) ? s : best, STD_RATIOS[0]);
        if (Math.abs(implied / snapped - 1) <= 0.05) {
          if (snapped !== asset.ratio) ratioSource = 'implied';
          ratio = snapped;
        }
        // Dólar implícito en ESTE CEDEAR: a cuánto está comprando dólar quien
        // paga este precio en pesos. La diferencia contra el CCL de referencia
        // marca si el papel está caro/barato en pesos hoy.
        cclImplied = (realPrice * ratio) / usd;
      } else {
        // Sin cotización real disponible para este símbolo: estimación
        // teórica vía CCL como respaldo.
        cclRef = await getCclRef();
        cedearArs = usd / asset.ratio * cclRef;
        cedearSource = 'estimated';
      }
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ usd, changePct, cedearArs, cedearSource, ratio, ratioSource, cclImplied, cclRef, volumeArsM: 0, priceSource });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}

/* ─────────────────────── pre-market (antes de la apertura) ───────────────────────
 * Precio del subyacente en EE.UU. antes de que abra el mercado, para uno o
 * varios símbolos. Fuente: Yahoo Finance chart con includePrePost=true (gratis,
 * sin API key, la misma vía que /api/dividends). El precio de pre-market se
 * calcula desde las velas de 1 minuto de la sesión previa a la apertura; el
 * estado del mercado se deriva de las franjas horarias del día (Yahoo no manda
 * marketState en el chart). Solo se devuelve `pre` en horario PRE/PREPRE. */
const PM_MAX_SYMBOLS = 40; // tope por request para no pasarse del timeout de la función
const PM_CONCURRENCY = 8;  // Yahoo es 1 símbolo por request → se piden de a tandas

async function pmOneSymbol(symbol) {
  try {
    const url = `${YF}/${encodeURIComponent(symbol)}?interval=1m&range=1d&includePrePost=true`;
    const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
    if (!r.ok) throw new Error('yahoo ' + r.status);
    const d = await r.json();
    const res = d?.chart?.result?.[0];
    if (!res) throw new Error('sin datos');
    const meta = res.meta || {};
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? null;
    const regular = meta.regularMarketPrice ?? null;
    const ctp = meta.currentTradingPeriod || {};
    const preStart = ctp.pre?.start, regStart = ctp.regular?.start, regEnd = ctp.regular?.end;
    const nowS = Date.now() / 1000;

    let state = meta.marketState || null;
    if (!state) {
      if (regStart && preStart && nowS >= preStart && nowS < regStart) state = 'PRE';
      else if (preStart && nowS < preStart) state = 'PREPRE';
      else if (regStart && regEnd && nowS >= regStart && nowS < regEnd) state = 'REGULAR';
      else if (regEnd && nowS >= regEnd) state = 'POST';
      else state = 'CLOSED';
    }

    let pre = null;
    const isPre = state === 'PRE' || state === 'PREPRE';
    if (isPre && preStart && regStart) {
      const ts = res.timestamp || [];
      const closes = res.indicators?.quote?.[0]?.close || [];
      for (let i = ts.length - 1; i >= 0; i--) {
        if (ts[i] >= preStart && ts[i] < regStart && closes[i] != null) { pre = closes[i]; break; }
      }
    }
    const prePct = (pre != null && prevClose > 0) ? (pre / prevClose - 1) * 100 : null;
    return { state, pre, prePct, prevClose, regular };
  } catch (_) {
    return { state: null, pre: null, prePct: null, prevClose: null, regular: null };
  }
}

async function pmMapPool(items, worker, concurrency) {
  const out = {};
  let idx = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (idx < items.length) { const i = idx++; out[items[i]] = await worker(items[i]); }
  });
  await Promise.all(runners);
  return out;
}

async function handlePreMarket(req, res) {
  const raw = String(req.query.symbols || req.query.symbol || '').toUpperCase();
  const symbols = [...new Set(raw.split(',').map(s => s.trim()).filter(Boolean))].slice(0, PM_MAX_SYMBOLS);
  if (!symbols.length) return res.status(400).json({ error: 'falta symbols' });
  try {
    const map = await pmMapPool(symbols, pmOneSymbol, PM_CONCURRENCY);
    res.setHeader('Cache-Control', 's-maxage=20, stale-while-revalidate=40');
    return res.status(200).json({ data: map });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
