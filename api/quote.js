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
  const symbol = String(req.query.symbol || '').toUpperCase();

  const asset = universe.find(a => a.ticker === symbol);
  if (!asset) return res.status(404).json({ error: 'symbol desconocido', universeLen: universe.length });

  try {
    const [fq, realPriceMap] = await Promise.all([
      fetch(`${FINNHUB}/quote?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`).then(r => r.json()),
      asset.ratio != null ? getRealArsPriceMap() : Promise.resolve(null),
    ]);
    // Finnhub a veces devuelve 200 con un cuerpo sin el campo `c` (precio) —
    // bajo carga, símbolo sin cobertura, etc. Sin esta validación quedaba
    // `usd: undefined`, que el cliente mostraba como "N/D" sin avisar que la
    // fuente en vivo falló — mejor tratarlo como error explícito y dejar que
    // el cliente caiga al respaldo (que sí se marca como "demo" en la UI).
    if (typeof fq.c !== 'number' || !(fq.c > 0)) throw new Error('finnhub: respuesta sin precio válido para ' + symbol);
    const usd = fq.c, changePct = fq.dp ?? 0;

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
    return res.status(200).json({ usd, changePct, cedearArs, cedearSource, ratio, ratioSource, cclImplied, cclRef, volumeArsM: 0 });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
