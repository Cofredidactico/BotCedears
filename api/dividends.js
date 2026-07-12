/**
 * /api/dividends?symbol=X — historial real de dividendos pagados (Finnhub).
 * Se usa para el yield TTM y el último pago — nunca para predecir una fecha
 * futura de pago (Finnhub free tier no la garantiza confiable, así que no
 * se inventa una).
 */
const FINNHUB = 'https://finnhub.io/api/v1';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'falta symbol' });

  const from = new Date(); from.setFullYear(from.getFullYear() - 2);
  const to = new Date();
  const fmt = (d) => d.toISOString().slice(0, 10);

  try {
    const url = `${FINNHUB}/stock/dividend?symbol=${symbol}&from=${fmt(from)}&to=${fmt(to)}&token=${process.env.FINNHUB_KEY}`;
    const r = await fetch(url);
    const d = await r.json();
    // Símbolos sin cobertura de dividendos (ETFs sintéticos, cripto vía
    // universo, ADRs de baja cobertura) devuelven algo que no es un array —
    // no es un error del proveedor, es "no aplica": se responde vacío, no 502.
    const items = Array.isArray(d)
      ? d.map(x => ({ date: x.date, amount: x.amount })).filter(x => x.date && x.amount > 0).sort((a, b) => b.date.localeCompare(a.date))
      : [];
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
