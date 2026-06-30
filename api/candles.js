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
    const o = [], h = [], l = [], c = [], v = [];
    for (const k of rows) { o.push(+k.open); h.push(+k.high); l.push(+k.low); c.push(+k.close); v.push(+(k.volume || 0)); }
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=300');
    return res.status(200).json({ o, h, l, c, v });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
