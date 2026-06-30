/**
 * /api/ccl — Vercel Serverless Function (Node).
 * Dólar Contado con Liquidación (clave para la veracidad de la señal en CEDEARs).
 *
 *   GET /api/ccl  ->  { value, changePct }
 *
 * Fuente: dolarapi.com (free, con CORS, sin key).
 */
export default async function handler(req, res) {
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/contadoconliqui');
    const d = await r.json();                 // { compra, venta, fechaActualizacion, ... }
    const value = (d.venta + d.compra) / 2 || d.venta;

    // changePct: dolarapi no da variación; si querés histórico, guardá el último
    // valor en un KV (Vercel KV / Upstash) y compará. Por ahora 0.
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ value, changePct: 0 });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
