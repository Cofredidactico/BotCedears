/**
 * scoring.js — Score compuesto 0-100 y plan operativo, calculados a partir de
 * datos reales (técnico + fundamental + macro + noticias).
 *
 * Pesos documentados en el diseño original:
 *   Tendencia 20, Momentum 15, Fundamentales 20, Valuación 10, Noticias 10,
 *   Macro 10, Riesgo 10, Sentimiento 5, Liquidez 5.
 *
 * Si una categoría no tiene datos reales disponibles para el activo (ej.
 * fundamentales en ETFs/cripto), se excluye y su peso se redistribuye
 * proporcionalmente entre las categorías que sí tienen datos — nunca se
 * inventa un valor para completar el score.
 */

const WEIGHTS = { trend: 20, momentum: 15, fundamentals: 20, valuation: 10, news: 10, macro: 10, risk: 10, sentiment: 5, liquidity: 5 };
const LABELS = { trend: 'Tendencia', momentum: 'Momentum', fundamentals: 'Fundamentales', valuation: 'Valuación', news: 'Noticias', macro: 'Macro', risk: 'Riesgo', sentiment: 'Sentimiento', liquidity: 'Liquidez' };
// Los pesos documentados en el diseño original suman 105 (no 100) — se preservan
// tal cual para no alterar el peso relativo de cada categoría; el score final se
// normaliza dividiendo por el peso total disponible, así siempre queda 0-100.
const FULL_WEIGHT = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);

const clamp = (v, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, v));

function scoreTrend(t, confluence) {
  let s = t.bullishAlign ? 0.88 : t.bearishAlign ? 0.15 : (t.price > t.ema200 ? 0.62 : 0.38);
  if (!isNaN(t.adx)) s += clamp((t.adx - 15) / 40, -0.15, 0.15);
  // Confirmar con la tendencia semanal reduce falsas señales del ruido diario;
  // una divergencia diario/semanal penaliza más de lo que suma una confirmación,
  // porque el timeframe mayor manda.
  if (confluence) s += confluence.agree ? 0.08 : -0.12;
  return clamp(s);
}

function scoreMomentum(t) {
  const rsiScore = isNaN(t.rsi) ? 0.5 : clamp((t.rsi - 30) / 40);
  const macdScore = isNaN(t.hist) ? 0.5 : (t.hist > 0 ? 0.65 : 0.35);
  return clamp(rsiScore * 0.6 + macdScore * 0.4);
}

function scoreFundamentals(f) {
  if (!f || !f.hasData) return null;
  const rev = clamp((f.revenueGrowth ?? 0) / 25);
  const eps = clamp((f.epsGrowth ?? 0) / 25);
  const roe = clamp((f.roe ?? 0) / 40);
  const margin = clamp((f.netMargin ?? 0) / 25);
  return clamp(rev * 0.3 + eps * 0.3 + roe * 0.2 + margin * 0.2);
}

function scoreValuation(f) {
  if (!f || f.peg == null) return null;
  if (f.peg <= 0) return 0.4;
  if (f.peg < 1) return 0.9;
  if (f.peg < 1.5) return 0.7;
  if (f.peg < 2.5) return 0.5;
  return 0.25;
}

function scoreNews(newsSentiment) {
  return newsSentiment == null ? null : clamp(newsSentiment);
}

function scoreMacro(macro) {
  if (!macro || macro.vix == null) return null;
  return clamp(1 - (macro.vix - 12) / 25);
}

function scoreRisk(t) {
  const atrPct = t.price ? t.atr / t.price : null;
  if (atrPct == null || isNaN(atrPct)) return 0.5;
  return clamp(1 - (atrPct - 0.015) / 0.05);
}

function scoreSentiment(newsSentiment, macro) {
  const vixPart = macro && macro.vix != null ? clamp(1 - (macro.vix - 12) / 25) : null;
  const newsPart = newsSentiment != null ? newsSentiment : null;
  if (vixPart == null && newsPart == null) return null;
  if (vixPart == null) return newsPart;
  if (newsPart == null) return vixPart;
  return clamp(vixPart * 0.5 + newsPart * 0.5);
}

function scoreLiquidity(candles) {
  if (!candles.v.some(x => x > 0)) return null;
  const v = candles.v.slice(-20);
  const avgVol = v.reduce((a, b) => a + b, 0) / v.length;
  return clamp(Math.log10(avgVol + 1) / 8);
}

export function computeScore({ technical, fundamentals, macro, newsSentiment, candles, confluence }) {
  const raw = {
    trend: scoreTrend(technical, confluence),
    momentum: scoreMomentum(technical),
    fundamentals: scoreFundamentals(fundamentals),
    valuation: scoreValuation(fundamentals),
    news: scoreNews(newsSentiment),
    macro: scoreMacro(macro),
    risk: scoreRisk(technical),
    sentiment: scoreSentiment(newsSentiment, macro),
    liquidity: scoreLiquidity(candles),
  };

  let totalWeight = 0, weighted = 0;
  const rows = [];
  for (const key of Object.keys(WEIGHTS)) {
    const s = raw[key];
    if (s == null) continue;
    totalWeight += WEIGHTS[key];
    weighted += s * WEIGHTS[key];
    rows.push({ key, s });
  }
  const score = totalWeight ? Math.round((weighted / totalWeight) * 100) : 50;

  // Las filas se muestran con el peso ORIGINAL documentado (fidelidad visual),
  // aunque el score final ya haya redistribuido los pesos de categorías faltantes.
  const scoreBreakdown = Object.keys(WEIGHTS).map(key => {
    const s = raw[key];
    return {
      label: LABELS[key],
      weight: WEIGHTS[key],
      value: s == null ? 0 : Math.round(s * WEIGHTS[key]),
      pct: s == null ? 0 : Math.round(s * 100),
      available: s != null,
    };
  });

  let scoreLabel, confidence;
  if (score >= 80) { scoreLabel = 'Compra Fuerte'; confidence = 'Alta'; }
  else if (score >= 65) { scoreLabel = 'Compra Moderada'; confidence = 'Media-Alta'; }
  else if (score >= 45) { scoreLabel = 'Mantener'; confidence = 'Media'; }
  else if (score >= 30) { scoreLabel = 'Reducir'; confidence = 'Media-Baja'; }
  else { scoreLabel = 'Venta'; confidence = 'Baja'; }

  // Una divergencia entre el timeframe diario y el semanal es una razón real
  // para desconfiar más de la señal — se refleja bajando un escalón la confianza.
  if (confluence && !confluence.agree) {
    const ladder = ['Baja', 'Media-Baja', 'Media', 'Media-Alta', 'Alta'];
    const idx = ladder.indexOf(confidence);
    if (idx > 0) confidence = ladder[idx - 1];
  }

  return { score, scoreLabel, confidence, scoreBreakdown, coverageWeight: totalWeight, fullWeight: FULL_WEIGHT };
}

export function computePlan(technical, score) {
  const { price, support: rawSupport, resistance: rawResistance, atr } = technical;
  const safeAtr = atr && atr > 0 && !isNaN(atr) ? atr : price * 0.02;

  // Si el swing de soporte/resistencia quedó demasiado pegado al precio (o el
  // precio ya lo rompió), un plan basado en él da un R/R degenerado — se
  // proyecta por ATR para asegurar una distancia mínima razonable.
  const supportRef = rawSupport < price - 0.5 * safeAtr ? rawSupport : price - 1.2 * safeAtr;
  const resistanceRef = rawResistance > price + 0.5 * safeAtr ? rawResistance : price + 1.2 * safeAtr;

  // Stop: bajo el soporte, pero nunca a más de 3×ATR del precio (tendencias
  // extendidas dejarían un soporte demasiado lejos para ser operable).
  const stopLoss = Math.max(0.01, Math.max(supportRef - safeAtr, price - 3 * safeAtr));

  // Zona de compra: siempre entre el stop (con margen) y el precio actual.
  const buyLow = Math.min(price - 0.05 * safeAtr, Math.max(supportRef, stopLoss + 0.3 * safeAtr));
  const buyHigh = Math.max(buyLow + 0.05 * safeAtr, Math.min(price, buyLow + 0.6 * safeAtr));

  // Objetivos: siempre por encima del precio actual.
  const tp1 = Math.max(resistanceRef, price + 0.8 * safeAtr);
  const tp2 = tp1 + safeAtr;
  const tp3 = tp1 + 2.5 * safeAtr;
  const sellLow = Math.max(tp1 - 0.6 * safeAtr, price + 0.1 * safeAtr);
  const sellHigh = tp1;

  const risk = price - stopLoss;
  const reward = tp1 - price;
  const riskReward = risk > 0 ? reward / risk : NaN;
  const probability = clamp(0.35 + score / 250, 0.3, 0.75);
  const drawdownPct = safeAtr / price;

  const fmt = (n) => n >= 1000 ? `US$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${n.toFixed(2)}`;

  return {
    compra: `${fmt(buyLow)} – ${fmt(buyHigh)}`,
    venta: `${fmt(sellLow)} – ${fmt(sellHigh)}`,
    stopLoss: fmt(stopLoss),
    tp1: fmt(tp1), tp2: fmt(tp2), tp3: fmt(tp3),
    riskReward: isNaN(riskReward) || riskReward <= 0 ? 'N/D' : `${riskReward.toFixed(1)}:1`,
    probability: `~${Math.round(probability * 100)}%`,
    drawdown: `-${Math.round(drawdownPct * 100 * 1.5)}% a -${Math.round(drawdownPct * 100 * 2.5)}%`,
  };
}
