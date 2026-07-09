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
    const url = `${FINNHUB}/stock/metric?symbol=${symbol}&metric=all&token=${process.env.FINNHUB_KEY}`;
    const d = await (await fetch(url)).json();
    const m = d.metric || {};
    const has = (v) => typeof v === 'number' && !Number.isNaN(v);

    const revenueGrowth = has(m.revenueGrowthTTMYoy) ? m.revenueGrowthTTMYoy : (has(m.revenueGrowth3Y) ? m.revenueGrowth3Y : null);
    const epsGrowth = has(m.epsGrowthTTMYoy) ? m.epsGrowthTTMYoy : (has(m.epsGrowth3Y) ? m.epsGrowth3Y : null);
    const peTTM = has(m.peTTM) ? m.peTTM : (has(m.peAnnual) ? m.peAnnual : null);
    const peForward = has(m.forwardPE) ? m.forwardPE : null;
    const peg = has(m.pegRatio) ? m.pegRatio : null;
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

    const hasData = revenueGrowth != null || epsGrowth != null || peTTM != null || roe != null;

    res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
    return res.status(200).json({
      hasData, revenueGrowth, epsGrowth, peTTM, peForward, peg, pb, ps, evEbitda,
      roe, roi, grossMargin, netMargin, fcfPerShare, debtEquity, dividendYield,
    });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
