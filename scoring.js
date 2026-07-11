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
  // Un movimiento de precio sin que el volumen (OBV) lo acompañe es la causa
  // más común de rupturas falsas — penaliza más de lo que suma confirmar.
  if (t.obvConfirms === true) s += 0.06;
  else if (t.obvConfirms === false) s -= 0.10;
  return clamp(s);
}

function scoreMomentum(t) {
  const rsiScore = isNaN(t.rsi) ? 0.5 : clamp((t.rsi - 30) / 40);
  const macdScore = isNaN(t.hist) ? 0.5 : (t.hist > 0 ? 0.65 : 0.35);
  let s = clamp(rsiScore * 0.6 + macdScore * 0.4);
  // Divergencia precio/RSI: señal de agotamiento de la tendencia actual —
  // penaliza el momentum en la dirección donde el mercado suele fallar.
  if (t.divergence?.type === 'bearish') s -= 0.15;
  if (t.divergence?.type === 'bullish') s += 0.10;
  return clamp(s);
}

function scoreFundamentals(f) {
  if (!f || !f.hasData) return null;
  const rev = clamp((f.revenueGrowth ?? 0) / 25);
  const eps = clamp((f.epsGrowth ?? 0) / 25);
  const roe = clamp((f.roe ?? 0) / 40);
  const margin = clamp((f.netMargin ?? 0) / 25);
  return clamp(rev * 0.3 + eps * 0.3 + roe * 0.2 + margin * 0.2);
}

// Rangos de PE "típicos" por sector, como referencia de mercado (no un feed
// en vivo de peers — evita sumar un request por activo solo para valuación).
// Sirven para juzgar si el múltiplo es caro/barato RELATIVO a su propio
// sector, no contra un umbral genérico único para toda la bolsa.
export const SECTOR_PE_RANGE = {
  'Tecnología': [22, 35], 'Semiconductores': [24, 38], 'Salud': [16, 26],
  'Consumo': [18, 26], 'Bancos': [8, 13], 'Energía': [7, 13],
  'Fintech': [20, 32], 'Comunicación': [14, 22], 'Industrial': [15, 22],
  'Automotriz': [10, 18], 'Materiales': [10, 16],
};

function scoreValuation(f, sector) {
  if (!f) return null;
  const range = SECTOR_PE_RANGE[sector];
  let peScore = null;
  if (range && f.peTTM != null && f.peTTM > 0) {
    const [lo, hi] = range;
    if (f.peTTM <= lo) peScore = 0.85;
    else if (f.peTTM <= (lo + hi) / 2) peScore = 0.7;
    else if (f.peTTM <= hi) peScore = 0.5;
    else if (f.peTTM <= hi * 1.3) peScore = 0.3;
    else peScore = 0.15;
  }
  let pegScore = null;
  if (f.peg != null) {
    if (f.peg <= 0) pegScore = 0.4;
    else if (f.peg < 1) pegScore = 0.9;
    else if (f.peg < 1.5) pegScore = 0.7;
    else if (f.peg < 2.5) pegScore = 0.5;
    else pegScore = 0.25;
  }
  if (peScore == null && pegScore == null) return null;
  if (peScore == null) return pegScore;
  if (pegScore == null) return peScore;
  return clamp(peScore * 0.5 + pegScore * 0.5);
}

function scoreNews(newsSentiment) {
  return newsSentiment == null ? null : clamp(newsSentiment);
}

// Riesgo país Argentina: ~400pb es un nivel "sano" reciente, ~1200pb es zona
// de crisis — la escala es una referencia relativa, no un umbral absoluto.
const riesgoPaisPart = (v) => v == null ? null : clamp(1 - (v - 400) / 800);

function scoreMacro(macro) {
  if (!macro) return null;
  const parts = [];
  if (macro.vix != null) parts.push(clamp(1 - (macro.vix - 12) / 25));
  const rp = riesgoPaisPart(macro.riesgoPaisArg);
  if (rp != null) parts.push(rp);
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

function scoreRisk(t) {
  const atrPct = t.price ? t.atr / t.price : null;
  if (atrPct == null || isNaN(atrPct)) return 0.5;
  return clamp(1 - (atrPct - 0.015) / 0.05);
}

function scoreSentiment(newsSentiment, macro) {
  const parts = [];
  if (macro?.vix != null) parts.push(clamp(1 - (macro.vix - 12) / 25));
  if (newsSentiment != null) parts.push(clamp(newsSentiment));
  if (macro?.fearGreed?.value != null) parts.push(clamp(macro.fearGreed.value / 100));
  return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
}

function scoreLiquidity(candles) {
  if (!candles.v.some(x => x > 0)) return null;
  const v = candles.v.slice(-20);
  const avgVol = v.reduce((a, b) => a + b, 0) / v.length;
  return clamp(Math.log10(avgVol + 1) / 8);
}

export function computeScore({ technical, fundamentals, macro, newsSentiment, candles, confluence, sector, earningsSoon }) {
  const raw = {
    trend: scoreTrend(technical, confluence),
    momentum: scoreMomentum(technical),
    fundamentals: scoreFundamentals(fundamentals),
    valuation: scoreValuation(fundamentals, sector),
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
      key,
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

  // Cada motivo real de menor confiabilidad baja un escalón la etiqueta de
  // Confianza (nunca el score compuesto): divergencia entre timeframes,
  // reporte de balance próximo (mayor incertidumbre que un día normal).
  const ladder = ['Baja', 'Media-Baja', 'Media', 'Media-Alta', 'Alta'];
  let downgrades = 0;
  if (confluence && !confluence.agree) downgrades++;
  if (earningsSoon) downgrades++;
  if (downgrades > 0) {
    const idx = Math.max(0, ladder.indexOf(confidence) - downgrades);
    confidence = ladder[idx];
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
    probabilityPct: Math.round(probability * 100),
    drawdown: `-${Math.round(drawdownPct * 100 * 1.5)}% a -${Math.round(drawdownPct * 100 * 2.5)}%`,
    // Valores numéricos crudos, para comparar contra el precio (alertas) sin
    // tener que re-parsear los strings formateados de arriba. supportRef/
    // resistanceRef/safeAtr (sin el margen de +0.1×ATR que separa sellLow del
    // precio actual solo para que el rango se vea bien en la UI) son los que
    // usa detectPriceAlert, para que la condición de cruce sea alcanzable.
    raw: { buyLow, buyHigh, sellLow, sellHigh, stopLoss, tp1, tp2, tp3, supportRef, resistanceRef, safeAtr },
  };
}

/** Compara el precio actual contra soporte/resistencia crudos (no contra el
 *  plan operativo: ese se recalcula siempre relativo al precio del momento
 *  para que el plan mostrado tenga sentido, lo que lo vuelve inútil como
 *  referencia fija de un refresco al siguiente). Soporte/resistencia salen
 *  de swings históricos reales, así que sí sirven como nivel a "cruzar". */
export function detectPriceAlert(price, technical) {
  const { support, resistance, atr } = technical;
  const safeAtr = atr && atr > 0 && !isNaN(atr) ? atr : price * 0.02;
  if (price <= support - safeAtr) return { type: 'stop', label: 'Rompió el soporte' };
  if (price <= support + 0.6 * safeAtr) return { type: 'buy', label: 'En zona de compra' };
  if (price >= resistance - 0.6 * safeAtr) return { type: 'sell', label: 'En zona de venta' };
  return null;
}
