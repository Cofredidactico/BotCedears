/**
 * /api/bonds — precios reales de bonos soberanos argentinos (data912.com,
 * mismo proveedor ya usado para el precio real de CEDEARs en BYMA). Se
 * exponen precio, bid/ask y variación — NO se calcula TIR ni duration acá:
 * esos bonos tienen cronogramas de amortización parcial y cupón escalonado
 * que ya están parcialmente cumplidos, y modelarlos mal daría un número
 * que parece preciso pero podría estar mal — mejor no mostrarlo que
 * mostrar uno posiblemente incorrecto.
 */
export default async function handler(req, res) {
  try {
    const r = await fetch('https://data912.com/live/arg_bonds', {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
    });
    if (!r.ok) throw new Error('upstream ' + r.status);
    const d = await r.json();
    if (!Array.isArray(d)) throw new Error('formato inesperado');
    const items = d
      .filter(x => x?.symbol && x.c != null)
      .map(x => ({ symbol: x.symbol, price: x.c, bid: x.px_bid ?? null, ask: x.px_ask ?? null, pctChange: x.pct_change ?? null, volume: x.v ?? null }));
    res.setHeader('Cache-Control', 's-maxage=120, stale-while-revalidate=300');
    return res.status(200).json({ items });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
