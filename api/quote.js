import universe from '../universe.json';

const FINNHUB = 'https://finnhub.io/api/v1';

// Algunos sitios filtran requests sin un User-Agent de navegador desde IPs de
// datacenter (como las de Vercel) — se manda uno genérico por las dudas.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Compañías argentinas cuyo ticker de ADR (el que usa Finnhub/el resto del
// sitio) no coincide con el ticker de la acción local en BYMA.
const AR_LOCAL_SYMBOL = { YPF: 'YPFD', PAM: 'PAMP', TGS: 'TGSU2', IRS: 'IRSA', CRESY: 'CRES' };

// Cache best-effort en memoria del proceso: sobrevive entre invocaciones si
// Vercel reutiliza la misma instancia "tibia" (común entre requests
// seguidos), y si no, simplemente se vuelve a pedir — no rompe nada.
let realPriceCache = null; // { at, map: { symbol -> último precio ARS } }

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

    let cedearArs = null, cedearSource = null;
    if (asset.ratio != null) {
      const localSymbol = AR_LOCAL_SYMBOL[symbol] || symbol;
      const realPrice = realPriceMap?.[localSymbol];
      if (realPrice != null) {
        // Precio real operado hoy en BYMA — la fuente más confiable posible,
        // ya que el precio teórico (CCL) puede diferir del precio de mercado.
        cedearArs = realPrice;
        cedearSource = 'live';
      } else {
        // Sin cotización real disponible para este símbolo: estimación
        // teórica vía CCL como respaldo.
        let ccl = 1554.65;
        try {
          const d = await (await fetch('https://dolarapi.com/v1/dolares/contadoconliqui', { headers: { 'User-Agent': BROWSER_UA } })).json();
          ccl = (d.venta + d.compra) / 2 || d.venta;
        } catch (_) {}
        cedearArs = usd / asset.ratio * ccl;
        cedearSource = 'estimated';
      }
    }

    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ usd, changePct, cedearArs, cedearSource, volumeArsM: 0 });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
