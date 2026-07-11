const TD = 'https://api.twelvedata.com';
export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const interval = String(req.query.interval || '1day');
  const outputsize = Math.min(parseInt(req.query.outputsize || '150', 10), 5000);
  const isIntraday = interval === '45min' || interval === '4h';
  try {
    const url = `${TD}/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${process.env.TWELVEDATA_KEY}`;
    const d = await (await fetch(url)).json();
    if (d.status === 'error' || !Array.isArray(d.values)) {
      // Cachear también el error un rato corto: si Twelve Data ya está sin
      // cupo, repetir el mismo pedido fallido enseguida por cada visitante
      // solo empeora las cosas — mejor devolver el mismo 502 cacheado y
      // dejar que el cupo se recupere en vez de seguir insistiendo.
      res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
      return res.status(502).json({ error: d.message || 'sin datos' });
    }
    const rows = d.values.slice().reverse();
    const o = [], h = [], l = [], c = [], v = [], t = [];
    for (const k of rows) { o.push(+k.open); h.push(+k.high); l.push(+k.low); c.push(+k.close); v.push(+(k.volume || 0)); t.push(k.datetime); }
    // Cache de borde de Vercel: absorbe pedidos repetidos del mismo símbolo
    // entre TODOS los visitantes del sitio (no solo el navegador de cada
    // uno), así no todos le pegan directo a Twelve Data — clave porque el
    // cupo gratuito es un total DIARIO compartido, no por visitante. Las
    // velas diarias/semanales cambian poco de una visita a otra dentro del
    // mismo día, así que se cachean bastante más tiempo que las intraday.
    res.setHeader('Cache-Control', isIntraday ? 's-maxage=300, stale-while-revalidate=600' : 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json({ o, h, l, c, v, t });
  } catch (e) {
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
