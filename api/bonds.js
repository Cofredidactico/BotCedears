/**
 * /api/bonds — precios reales de renta fija argentina (data912.com, mismo
 * proveedor ya usado para el precio real de CEDEARs en BYMA). Devuelve tres
 * listas: bonos soberanos (`items`), obligaciones negociables corporativas
 * (`ons`) y letras del Tesoro (`letras`) — todas con precio, bid/ask y
 * variación. NO se calcula TIR ni duration acá: esos instrumentos tienen
 * cronogramas de amortización parcial y cupón escalonado que ya están
 * parcialmente cumplidos, y modelarlos mal daría un número que parece preciso
 * pero podría estar mal — mejor no mostrarlo que mostrar uno posiblemente
 * incorrecto.
 *
 * ONs y letras son best-effort: si el proveedor no expone ese endpoint o falla,
 * se devuelve la lista vacía (el Asesor cae a una referencia curada) — nunca
 * rompe el apartado de Bonos, que solo necesita `items`.
 */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

async function fetchList(path) {
  try {
    const r = await fetch(`https://data912.com/live/${path}`, { headers: { 'User-Agent': UA } });
    if (!r.ok) return [];
    const d = await r.json();
    if (!Array.isArray(d)) return [];
    return d
      .filter(x => x?.symbol && x.c != null)
      .map(x => ({ symbol: x.symbol, price: x.c, bid: x.px_bid ?? null, ask: x.px_ask ?? null, pctChange: x.pct_change ?? null, volume: x.v ?? null }));
  } catch { return []; }
}

export default async function handler(req, res) {
  try {
    // Los soberanos (`items`) son obligatorios; ONs y letras, best-effort.
    const [items, ons, letras] = await Promise.all([
      fetchList('arg_bonds'),
      fetchList('arg_corp'),
      fetchList('arg_notes'),
    ]);
    if (!items.length && !ons.length && !letras.length) throw new Error('sin datos de renta fija');
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ items, ons, letras });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
