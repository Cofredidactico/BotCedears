export default async function handler(req, res) {
  try {
    const r = await fetch('https://dolarapi.com/v1/dolares/contadoconliqui');
    const d = await r.json();
    const value = (d.venta + d.compra) / 2 || d.venta;
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ value, changePct: 0 });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
