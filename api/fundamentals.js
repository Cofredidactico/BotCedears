/**
 * /api/fundamentals?symbol=X — fundamentales reales vía Finnhub `stock/metric`.
 * Devuelve null en cada campo que Finnhub no tenga cargado para ese ticker
 * (común en ADRs/CEDEARs de menor cobertura) en vez de inventar un valor.
 */
const FINNHUB = 'https://finnhub.io/api/v1';

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'falta symbol' });

  try {
    const token = process.env.FINNHUB_KEY;
    const metricUrl = `${FINNHUB}/stock/metric?symbol=${symbol}&metric=all&token=${token}`;
    // Transacciones de insiders (directivos/dueños) de los últimos ~6 meses —
    // free tier de Finnhub. Se pide en paralelo; si el endpoint está vacío o
    // es premium para este símbolo, se degrada a null sin romper nada.
    const since = new Date(Date.now() - 183 * 86400e3).toISOString().slice(0, 10);
    const insiderUrl = `${FINNHUB}/stock/insider-transactions?symbol=${symbol}&from=${since}&token=${token}`;
    // Consenso de analistas ("la calle") — se pide acá, dentro de fundamentals,
    // para NO agregar una función serverless nueva (el plan Hobby de Vercel topa
    // en 12). recommendation es free tier; price-target puede ser premium y se
    // degrada a null sin romper.
    const recUrl = `${FINNHUB}/stock/recommendation?symbol=${symbol}&token=${token}`;
    const ptUrl = `${FINNHUB}/stock/price-target?symbol=${symbol}&token=${token}`;
    const [d, insiderRaw, recRaw, ptRaw] = await Promise.all([
      fetch(metricUrl).then(r => r.json()).catch(() => ({})),
      fetch(insiderUrl).then(r => r.json()).catch(() => null),
      fetch(recUrl).then(r => r.json()).catch(() => null),
      fetch(ptUrl).then(r => r.json()).catch(() => null),
    ]);
    const m = d.metric || {};
    const has = (v) => typeof v === 'number' && !Number.isNaN(v);

    const revenueGrowth = has(m.revenueGrowthTTMYoy) ? m.revenueGrowthTTMYoy : (has(m.revenueGrowth3Y) ? m.revenueGrowth3Y : null);
    const epsGrowth = has(m.epsGrowthTTMYoy) ? m.epsGrowthTTMYoy : (has(m.epsGrowth3Y) ? m.epsGrowth3Y : null);
    const peTTM = has(m.peTTM) ? m.peTTM : (has(m.peAnnual) ? m.peAnnual : null);
    const peForward = has(m.forwardPE) ? m.forwardPE : null;
    let peg = has(m.pegRatio) ? m.pegRatio : null;
    let pegComputed = false;
    const pb = has(m.pbAnnual) ? m.pbAnnual : (has(m.pbQuarterly) ? m.pbQuarterly : null);
    const ps = has(m.psTTM) ? m.psTTM : (has(m.psAnnual) ? m.psAnnual : null);
    const evEbitda = has(m['evEbitdaTTM']) ? m['evEbitdaTTM'] : (has(m['evEbitdaAnnual']) ? m['evEbitdaAnnual'] : null);
    const roe = has(m.roeTTM) ? m.roeTTM : (has(m.roeRfy) ? m.roeRfy : null);
    const roi = has(m.roiTTM) ? m.roiTTM : (has(m.roiAnnual) ? m.roiAnnual : null);
    const grossMargin = has(m.grossMarginTTM) ? m.grossMarginTTM : (has(m.grossMarginAnnual) ? m.grossMarginAnnual : null);
    const netMargin = has(m.netProfitMarginTTM) ? m.netProfitMarginTTM : (has(m.netProfitMarginAnnual) ? m.netProfitMarginAnnual : null);
    const fcfPerShare = has(m.focfPerShareTTM) ? m.focfPerShareTTM : null;
    const debtEquity = has(m['totalDebt/totalEquityAnnual']) ? m['totalDebt/totalEquityAnnual'] : (has(m['totalDebt/totalEquityQuarterly']) ? m['totalDebt/totalEquityQuarterly'] : null);
    const dividendYield = has(m.dividendYieldIndicatedAnnual) ? m.dividendYieldIndicatedAnnual : (has(m.currentDividendYieldTTM) ? m.currentDividendYieldTTM : null);

    // PEG calculado como respaldo: el free tier de Finnhub no trae pegRatio,
    // pero PEG = PE / crecimiento de EPS es la definición estándar y ambos
    // insumos sí vienen. Se calcula solo con crecimiento positivo (un PEG
    // sobre EPS decreciente no tiene interpretación útil) y se marca como
    // derivado para no presentarlo como un dato de la fuente.
    if (peg == null && peTTM != null && has(epsGrowth) && epsGrowth > 0) {
      peg = peTTM / epsGrowth;
      pegComputed = true;
    }

    const hasData = revenueGrowth != null || epsGrowth != null || peTTM != null || roe != null;
    const insider = summarizeInsider(insiderRaw);
    const recommendations = summarizeRecommendations(recRaw, ptRaw);

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({
      hasData, revenueGrowth, epsGrowth, peTTM, peForward, peg, pegComputed, pb, ps, evEbitda,
      roe, roi, grossMargin, netMargin, fcfPerShare, debtEquity, dividendYield,
      insider, recommendations,
    });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}

/**
 * Consenso de analistas: resume la distribución de recomendaciones (escala 1–5)
 * y, si está disponible, el precio objetivo. Devuelve { hasData:false } si el
 * símbolo no tiene cobertura — nunca inventa.
 */
function summarizeRecommendations(recRaw, ptRaw) {
  const rows = Array.isArray(recRaw) ? recRaw.slice() : [];
  rows.sort((a, b) => String(b.period || '').localeCompare(String(a.period || '')));
  const sum = (row) => {
    if (!row) return null;
    const strongBuy = Number(row.strongBuy) || 0, buy = Number(row.buy) || 0, hold = Number(row.hold) || 0, sell = Number(row.sell) || 0, strongSell = Number(row.strongSell) || 0;
    const total = strongBuy + buy + hold + sell + strongSell;
    if (!total) return null;
    const scored = (strongBuy * 5 + buy * 4 + hold * 3 + sell * 2 + strongSell) / total;
    return {
      period: row.period || null, strongBuy, buy, hold, sell, strongSell, total,
      scored: Math.round(scored * 100) / 100, scored100: Math.round(((scored - 1) / 4) * 100),
      bullishPct: Math.round(((strongBuy + buy) / total) * 100), bearishPct: Math.round(((sell + strongSell) / total) * 100),
      label: scored >= 4.5 ? 'Compra fuerte' : scored >= 3.5 ? 'Compra' : scored >= 2.5 ? 'Mantener' : scored >= 1.5 ? 'Venta' : 'Venta fuerte',
    };
  };
  const latest = rows.length ? sum(rows[0]) : null;
  const prev = rows.length > 1 ? sum(rows[1]) : null;
  let trend = null;
  if (latest && prev) { const dd = latest.scored - prev.scored; trend = Math.abs(dd) < 0.05 ? 'estable' : dd > 0 ? 'mejorando' : 'empeorando'; }
  let priceTarget = null;
  const num = (v) => (typeof v === 'number' && !Number.isNaN(v) && v > 0 ? v : null);
  if (ptRaw && (num(ptRaw.targetMean) || num(ptRaw.targetMedian))) {
    priceTarget = { mean: num(ptRaw.targetMean), median: num(ptRaw.targetMedian), high: num(ptRaw.targetHigh), low: num(ptRaw.targetLow), lastUpdated: ptRaw.lastUpdated || null };
  }
  return { hasData: latest != null, latest, prev, trend, priceTarget };
}

/**
 * Resume las transacciones de insiders de Finnhub en flujo neto: acciones
 * compradas vs vendidas por directivos/dueños en los últimos ~6 meses.
 * Los códigos de transacción de la SEC importan: 'P' = compra en mercado
 * abierto (la señal más fuerte de convicción), 'S' = venta. 'M'/'A'/'G'/'F'
 * (ejercicio de opciones, grants, regalos, retención de impuestos) NO son
 * decisiones de mercado abierto y se excluyen del conteo de convicción, pero
 * sí se reflejan en el cambio neto de tenencia. Devuelve null si no hay datos
 * (símbolo sin cobertura o endpoint premium) — nunca inventa.
 */
function summarizeInsider(raw) {
  const data = Array.isArray(raw?.data) ? raw.data : null;
  if (!data || !data.length) return null;

  let netShares = 0;      // cambio neto de tenencia (todas las transacciones)
  let boughtShares = 0, soldShares = 0; // solo compras/ventas de mercado abierto (P/S)
  let buyCount = 0, sellCount = 0;
  const buyers = new Set(), sellers = new Set();
  const recent = [];

  for (const t of data) {
    const change = Number(t.change);
    if (!Number.isFinite(change) || change === 0) continue;
    const code = String(t.transactionCode || '').toUpperCase();
    netShares += change;
    const openMarket = code === 'P' || code === 'S';
    if (code === 'P' && change > 0) { boughtShares += change; buyCount++; buyers.add(t.name); }
    else if (code === 'S' && change < 0) { soldShares += -change; sellCount++; sellers.add(t.name); }
    if (openMarket) {
      recent.push({
        name: t.name || '—',
        date: t.transactionDate || t.filingDate || null,
        change,
        code,
        price: Number.isFinite(Number(t.transactionPrice)) && Number(t.transactionPrice) > 0 ? Number(t.transactionPrice) : null,
      });
    }
  }

  recent.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
  const netOpenMarket = boughtShares - soldShares;
  // Sesgo: solo lo consideramos claro si hay volumen y una dirección domina.
  let bias = 'neutral';
  const totalOM = boughtShares + soldShares;
  if (totalOM > 0) {
    const buyFrac = boughtShares / totalOM;
    if (buyFrac >= 0.65) bias = 'compra';
    else if (buyFrac <= 0.35) bias = 'venta';
  }

  return {
    windowDays: 183,
    netShares, netOpenMarket, boughtShares, soldShares,
    buyCount, sellCount, distinctBuyers: buyers.size, distinctSellers: sellers.size,
    bias,
    transactions: recent.slice(0, 8),
    totalRecords: data.length,
  };
}
