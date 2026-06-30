const FINNHUB = 'https://finnhub.io/api/v1';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();

  // leer universe.json por HTTP desde el propio sitio
  let universe = [];
  try {
    const base = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '';
    universe = await (await fetch(`${base}/universe.json`)).json();
  } catch (e) {
    return res.status(500).json({ error: 'no pude leer universe.json', detail: String(e) });
  }

  const asset = universe.find(a => a.ticker === symbol);
  if (!asset) return res.status(404).json({ error: 'symbol desconocido', universeLen: universe.length });

  try {
    const fq = await (await fetch(`${FINNHUB}/quote?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`)).json();
    const usd = fq.c, changePct = fq.dp ?? 0;
    let ccl = 1554.65;
    try {
      const d = await (await fetch('https://dolarapi.com/v1/dolares/contadoconliqui')).json();
      ccl = (d.venta + d.compra) / 2 || d.venta;
    } catch (_) {}
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(200).json({ usd, changePct, cedearArs: usd / asset.ratio * ccl, volumeArsM: 0 });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
