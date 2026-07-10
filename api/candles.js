const TD = 'https://api.twelvedata.com';
export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const interval = String(req.query.interval || '1day');
  const outputsize = Math.min(parseInt(req.query.outputsize || '150', 10), 5000);
  try {
    const url = `${TD}/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${process.env.TWELVEDATA_KEY}`;
    const d = await (await fetch(url)).json();
    if (d.status === 'error' || !Array.isArray(d.values))
      return res.status(502).json({ error: d.message || 'sin datos' });
    const rows = d.values.slice().reverse();
    const o = [], h = [], l = [], c = [], v = [], t = [];
    for (const k of rows) { o.push(+k.open); h.push(+k.high); l.push(+k.low); c.push(+k.close); v.push(+(k.volume || 0)); t.push(k.datetime); }
    // Cache de borde de Vercel: absorbe pedidos repetidos del mismo símbolo
    // entre distintos visitantes, así no todos le pegan directo a Twelve Data
    // (free tier comparte ~8 req/min entre todo el sitio).
    const isIntraday = interval === '45min' || interval === '4h';
    res.setHeader('Cache-Control', isIntraday ? 's-maxage=90, stale-while-revalidate=180' : 's-maxage=240, stale-while-revalidate=600');
    return res.status(200).json({ o, h, l, c, v, t });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
