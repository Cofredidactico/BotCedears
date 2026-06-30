/**
 * /api/quote — Vercel Serverless Function (Node).
 * Devuelve la cotización del subyacente en USD + precio del CEDEAR en ARS.
 *
 *   GET /api/quote?symbol=AAPL  ->  { usd, changePct, cedearArs, volumeArsM }
 *
 * Fuentes:
 *   - USD / variación: Finnhub  (free ~60 req/min, con CORS)   FINNHUB_KEY
 *   - CEDEAR ARS + volumen (BYMA): data912 (comunidad)         [verificar/ajustar]
 *   - CCL: dolarapi (para derivar ARS si no hay dato local)
 *
 * La API key NUNCA viaja al navegador: vive en las env vars de Vercel.
 */
import universe from '../universe.json' assert { type: 'json' };

const FINNHUB = 'https://finnhub.io/api/v1';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const asset = universe.find(a => a.ticker === symbol);
  if (!asset) return res.status(404).json({ error: 'symbol desconocido' });

  try {
    // 1) Subyacente en USD (Finnhub)
    const fr = await fetch(`${FINNHUB}/quote?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`);
    const fq = await fr.json();                  // { c, d, dp, h, l, o, pc }
    const usd = fq.c, changePct = fq.dp ?? 0;

    // 2) CEDEAR en ARS (BYMA). Si falla, derivar usd/ratio*CCL.
    let cedearArs = null, volumeArsM = null;
    try {
      const cr = await fetch('https://data912.com/live/arg_cedears');
      const list = await cr.json();              // [{ symbol, c, q_op, ... }]
      const row = list.find(x => (x.symbol || '').toUpperCase() === symbol);
      if (row) { cedearArs = row.c; volumeArsM = Math.round((row.v ?? row.q_op ?? 0) / 1e6); }
    } catch (_) {}

    if (cedearArs == null) {
      const ccl = await getCcl();
      cedearArs = usd / asset.ratio * ccl;
    }

    // Cache CDN 60s para respetar rate limits
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ usd, changePct, cedearArs, volumeArsM: volumeArsM ?? 0 });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}

async function getCcl() {
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/contadoconliqui');
    const d = await r.json();                    // { compra, venta, ... }
    return (d.venta + d.compra) / 2 || d.venta;
  } catch { return 1247.5; }
}
