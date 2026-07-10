/**
 * /api/earnings?symbol=X — próxima fecha de resultados (Finnhub calendar).
 * Operar justo antes de un reporte de balance es mucho más incierto que un
 * día normal — se usa para bajar la confianza del score y marcarlo como
 * riesgo, no para inventar una predicción de qué va a pasar en el reporte.
 */
const FINNHUB = 'https://finnhub.io/api/v1';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'falta symbol' });

  const from = new Date();
  const to = new Date(from.getTime() + 45 * 24 * 3600 * 1000);
  const fmt = (d) => d.toISOString().slice(0, 10);

  try {
    const url = `${FINNHUB}/calendar/earnings?from=${fmt(from)}&to=${fmt(to)}&symbol=${symbol}&token=${process.env.FINNHUB_KEY}`;
    const d = await (await fetch(url)).json();
    const items = Array.isArray(d.earningsCalendar) ? d.earningsCalendar : [];
    const next = items.slice().sort((a, b) => a.date.localeCompare(b.date))[0] ?? null;

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({ nextDate: next?.date ?? null, hour: next?.hour ?? null });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
