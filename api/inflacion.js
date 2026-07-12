/**
 * /api/inflacion — IPC mensual de Argentina (ArgentinaDatos, fuente pública
 * sin key). Se usa para mostrar retorno REAL (ajustado por inflación) al
 * lado del nominal — en Argentina un +40% nominal puede ser una pérdida
 * real, y ningún competidor gratuito lo muestra.
 */
const SOURCE = 'https://api.argentinadatos.com/v1/finanzas/indices/inflacion';

export default async function handler(req, res) {
  try {
    const r = await fetch(SOURCE);
    if (!r.ok) throw new Error('upstream ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error('formato inesperado');
    // Alcanza y sobra con los últimos ~10 años (120 meses) para cualquier
    // plazo de cartera o backtesting real — no hace falta mandar la serie
    // completa desde 1943.
    const items = d.slice(-120).map(x => ({ fecha: x.fecha, valorPct: x.valor }));
    res.setHeader('Cache-Control', 's-maxage=43200, stale-while-revalidate=86400'); // el dato es mensual
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
