/**
 * /api/recommendations?symbol=X — consenso de analistas ("la calle") vía Finnhub
 * `stock/recommendation` (tendencia de recomendaciones, free tier) y, si está
 * disponible, `stock/price-target` (premium en algunos planes → se degrada a
 * null sin romper). Es una visión EXTERNA e independiente, para contrastar con
 * el score cuantitativo propio. Devuelve null en `latest` si el símbolo no tiene
 * cobertura (común en CEDEARs/ADRs de menor seguimiento) — nunca inventa.
 */
const FINNHUB = 'https://finnhub.io/api/v1';

// Ponderación estándar de una escala 1–5 (venta fuerte → compra fuerte) para
// resumir la distribución en un solo número comparable.
function summarize(row) {
  const strongBuy = Number(row.strongBuy) || 0;
  const buy = Number(row.buy) || 0;
  const hold = Number(row.hold) || 0;
  const sell = Number(row.sell) || 0;
  const strongSell = Number(row.strongSell) || 0;
  const total = strongBuy + buy + hold + sell + strongSell;
  if (!total) return null;
  const scored = (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell * 1) / total; // 1..5
  const bullishPct = Math.round(((strongBuy + buy) / total) * 100);
  const bearishPct = Math.round(((sell + strongSell) / total) * 100);
  const label = scored >= 4.5 ? 'Compra fuerte' : scored >= 3.5 ? 'Compra' : scored >= 2.5 ? 'Mantener' : scored >= 1.5 ? 'Venta' : 'Venta fuerte';
  return {
    period: row.period || null,
    strongBuy, buy, hold, sell, strongSell, total,
    scored: Math.round(scored * 100) / 100,
    scored100: Math.round(((scored - 1) / 4) * 100), // 0..100 para barras
    bullishPct, bearishPct, label,
  };
}

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'falta symbol' });

  try {
    const token = process.env.FINNHUB_KEY;
    const recUrl = `${FINNHUB}/stock/recommendation?symbol=${symbol}&token=${token}`;
    const ptUrl = `${FINNHUB}/stock/price-target?symbol=${symbol}&token=${token}`;
    const [recRaw, ptRaw] = await Promise.all([
      fetch(recUrl).then(r => r.json()).catch(() => null),
      fetch(ptUrl).then(r => r.json()).catch(() => null),
    ]);

    const rows = Array.isArray(recRaw) ? recRaw.slice() : [];
    // Finnhub las devuelve por período; ordenamos del más nuevo al más viejo.
    rows.sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
    const latest = rows.length ? summarize(rows[0]) : null;
    const prev = rows.length > 1 ? summarize(rows[1]) : null;
    // Tendencia del consenso: ¿mejoró o empeoró vs el período anterior?
    let trend = null;
    if (latest && prev) {
      const d = latest.scored - prev.scored;
      trend = Math.abs(d) < 0.05 ? 'estable' : d > 0 ? 'mejorando' : 'empeorando';
    }

    let priceTarget = null;
    const num = (v) => (typeof v === 'number' && !Number.isNaN(v) && v > 0 ? v : null);
    if (ptRaw && (num(ptRaw.targetMean) || num(ptRaw.targetMedian))) {
      priceTarget = {
        mean: num(ptRaw.targetMean), median: num(ptRaw.targetMedian),
        high: num(ptRaw.targetHigh), low: num(ptRaw.targetLow),
        lastUpdated: ptRaw.lastUpdated || null,
      };
    }

    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json({ hasData: latest != null, latest, prev, trend, priceTarget });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
