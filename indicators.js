/**
 * indicators.js — Motor de indicadores técnicos.
 * Todas las funciones operan sobre candles = { o[], h[], l[], c[], v[] }
 * ordenados de más viejo a más nuevo (mismo contrato que dataSource.getCandles).
 * Sin datos simulados: todo se calcula a partir del OHLCV que llega de la API real.
 */

export function ema(values, period) {
  const k = 2 / (period + 1);
  const out = [];
  let prev;
  for (let i = 0; i < values.length; i++) {
    prev = i === 0 ? values[i] : values[i] * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

export function sma(values, period) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    out.push(i >= period - 1 ? sum / period : NaN);
  }
  return out;
}

function wilder(values, period) {
  const out = new Array(values.length).fill(NaN);
  if (values.length < period) return out;
  let sum = 0;
  for (let i = 0; i < period; i++) sum += values[i];
  let prev = sum / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i++) {
    prev = (prev * (period - 1) + values[i]) / period;
    out[i] = prev;
  }
  return out;
}

export function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(NaN);
  if (closes.length <= period) return out;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i] - closes[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  gain /= period; loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    const g = d > 0 ? d : 0, l = d < 0 ? -d : 0;
    gain = (gain * (period - 1) + g) / period;
    loss = (loss * (period - 1) + l) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(closes, fast = 12, slow = 26, signalP = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => emaFast[i] - emaSlow[i]);
  const signalLine = ema(macdLine, signalP);
  const hist = macdLine.map((v, i) => v - signalLine[i]);
  return { macdLine, signalLine, hist };
}

export function atr(highs, lows, closes, period = 14) {
  const tr = highs.map((h, i) => i === 0
    ? h - lows[i]
    : Math.max(h - lows[i], Math.abs(h - closes[i - 1]), Math.abs(lows[i] - closes[i - 1])));
  return wilder(tr, period);
}

export function adx(highs, lows, closes, period = 14) {
  const n = highs.length;
  const plusDM = new Array(n).fill(0), minusDM = new Array(n).fill(0), tr = new Array(n).fill(0);
  for (let i = 1; i < n; i++) {
    const up = highs[i] - highs[i - 1];
    const down = lows[i - 1] - lows[i];
    plusDM[i] = (up > down && up > 0) ? up : 0;
    minusDM[i] = (down > up && down > 0) ? down : 0;
    tr[i] = Math.max(highs[i] - lows[i], Math.abs(highs[i] - closes[i - 1]), Math.abs(lows[i] - closes[i - 1]));
  }
  const trS = wilder(tr, period), pDMS = wilder(plusDM, period), mDMS = wilder(minusDM, period);
  const plusDI = trS.map((t, i) => (t ? (pDMS[i] / t) * 100 : NaN));
  const minusDI = trS.map((t, i) => (t ? (mDMS[i] / t) * 100 : NaN));
  const dx = plusDI.map((p, i) => {
    const m = minusDI[i], sum = p + m;
    return sum ? (Math.abs(p - m) / sum) * 100 : 0;
  });
  return wilder(dx.map(v => (isNaN(v) ? 0 : v)), period);
}

export function bollinger(closes, period = 20, mult = 2) {
  const mid = sma(closes, period);
  const upper = [], lower = [];
  for (let i = 0; i < closes.length; i++) {
    if (i < period - 1) { upper.push(NaN); lower.push(NaN); continue; }
    const slice = closes.slice(i - period + 1, i + 1);
    const mean = mid[i];
    const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
    const sd = Math.sqrt(variance);
    upper.push(mean + mult * sd);
    lower.push(mean - mult * sd);
  }
  return { upper, mid, lower };
}

export function obv(closes, volumes) {
  const out = [0];
  for (let i = 1; i < closes.length; i++) {
    const prev = out[i - 1];
    const vol = volumes[i] || 0;
    if (closes[i] > closes[i - 1]) out.push(prev + vol);
    else if (closes[i] < closes[i - 1]) out.push(prev - vol);
    else out.push(prev);
  }
  return out;
}

/** VWAP aproximado: promedio ponderado por volumen sobre una ventana rolling.
 *  No es el VWAP intradiario clásico (requiere reset de sesión y ticks) —
 *  es un proxy razonable sobre barras diarias, documentado como tal. */
export function rollingVwap(highs, lows, closes, volumes, period = 20) {
  const hasVolume = volumes.some(v => v > 0);
  const out = new Array(closes.length).fill(NaN);
  if (!hasVolume) return out;
  for (let i = period - 1; i < closes.length; i++) {
    let pv = 0, vv = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const tp = (highs[j] + lows[j] + closes[j]) / 3;
      pv += tp * (volumes[j] || 0);
      vv += volumes[j] || 0;
    }
    out[i] = vv ? pv / vv : NaN;
  }
  return out;
}

export function findSwings(highs, lows, lookback = 90, leftRight = 3) {
  const n = highs.length;
  const start = Math.max(leftRight, n - lookback);
  const swingHighs = [], swingLows = [];
  for (let i = start; i < n - leftRight; i++) {
    let isHigh = true, isLow = true;
    for (let j = i - leftRight; j <= i + leftRight; j++) {
      if (j === i) continue;
      if (highs[j] >= highs[i]) isHigh = false;
      if (lows[j] <= lows[i]) isLow = false;
    }
    if (isHigh) swingHighs.push({ i, price: highs[i] });
    if (isLow) swingLows.push({ i, price: lows[i] });
  }
  return { swingHighs, swingLows };
}

export function supportResistance(highs, lows, closes, lookback = 90) {
  const { swingHighs, swingLows } = findSwings(highs, lows, lookback);
  const price = closes[closes.length - 1];
  const resistances = swingHighs.map(s => s.price).filter(p => p > price).sort((a, b) => a - b);
  const supports = swingLows.map(s => s.price).filter(p => p < price).sort((a, b) => b - a);
  const windowLows = lows.slice(-lookback), windowHighs = highs.slice(-lookback);
  return {
    support: supports[0] ?? Math.min(...windowLows),
    resistance: resistances[0] ?? Math.max(...windowHighs),
  };
}

export function fibonacci(highs, lows, lookback = 90) {
  const hSlice = highs.slice(-lookback), lSlice = lows.slice(-lookback);
  const hi = Math.max(...hSlice), lo = Math.min(...lSlice);
  const range = hi - lo;
  return {
    hi, lo,
    levels: { '0.382': hi - range * 0.382, '0.5': hi - range * 0.5, '0.618': hi - range * 0.618 },
  };
}

/** Divergencia entre el precio y el RSI: si el precio hace un máximo más
 *  alto pero el RSI no lo acompaña (o un mínimo más bajo que el RSI no
 *  confirma), es una señal clásica de agotamiento de la tendencia — se
 *  detecta comparando los dos últimos swings de precio contra el RSI en
 *  esos mismos puntos. */
export function detectDivergence(closes, rsiSeries, lookback = 60) {
  const { swingHighs, swingLows } = findSwings(closes, closes, lookback);
  if (swingHighs.length >= 2) {
    const a = swingHighs.at(-2), b = swingHighs.at(-1);
    if (b.price > a.price && rsiSeries[b.i] < rsiSeries[a.i]) {
      return { type: 'bearish', label: 'Divergencia bajista — precio hace un máximo más alto, el RSI no lo confirma.' };
    }
  }
  if (swingLows.length >= 2) {
    const a = swingLows.at(-2), b = swingLows.at(-1);
    if (b.price < a.price && rsiSeries[b.i] > rsiSeries[a.i]) {
      return { type: 'bullish', label: 'Divergencia alcista — precio hace un mínimo más bajo, el RSI no lo confirma.' };
    }
  }
  return null;
}

export function marketStructure(highs, lows, lookback = 90) {
  const { swingHighs, swingLows } = findSwings(highs, lows, lookback);
  if (swingHighs.length < 2 || swingLows.length < 2) {
    return { short: 'Estructura indefinida', label: 'Estructura indefinida (historial insuficiente).', bullish: null };
  }
  const hh = swingHighs.at(-1).price > swingHighs.at(-2).price;
  const hl = swingLows.at(-1).price > swingLows.at(-2).price;
  const ll = swingLows.at(-1).price < swingLows.at(-2).price;
  const lh = swingHighs.at(-1).price < swingHighs.at(-2).price;
  if (hh && hl) return { short: 'BOS alcista', label: 'BOS alcista — máximos y mínimos crecientes.', bullish: true };
  if (ll && lh) return { short: 'BOS bajista', label: 'BOS bajista — máximos y mínimos decrecientes.', bullish: false };
  if (hh && ll) return { short: 'CHoCH', label: 'CHoCH — posible cambio de carácter de la tendencia.', bullish: null };
  return { short: 'Rango', label: 'Rango — sin estructura direccional clara.', bullish: null };
}

/** Clasificación honesta de la acción del precio reciente (no pretende
 *  reconocer patrones chartistas específicos tipo "banderín" sin un
 *  clasificador visual real, que este proyecto no tiene). */
const PRICE_ACTION = {
  insufficient: { short: 'Datos insuficientes', full: 'Historial insuficiente para clasificar la acción de precio reciente.' },
  contracting: { short: 'Compresión de volatilidad', full: 'Compresión de volatilidad — posible ruptura próxima.' },
  up: { short: 'Canal ascendente', full: 'Canal ascendente en las últimas sesiones.' },
  down: { short: 'Canal descendente', full: 'Canal descendente en las últimas sesiones.' },
  flat: { short: 'Consolidación lateral', full: 'Consolidación lateral, sin dirección clara en las últimas sesiones.' },
};

export function priceActionLabel(closes, atrSeries) {
  const n = closes.length;
  const recentAtr = atrSeries.slice(-20).filter(v => !isNaN(v));
  if (recentAtr.length < 5) return PRICE_ACTION.insufficient;
  const avgFirst = recentAtr.slice(0, Math.floor(recentAtr.length / 2)).reduce((a, b) => a + b, 0) / Math.max(1, Math.floor(recentAtr.length / 2));
  const avgLast = recentAtr.slice(Math.floor(recentAtr.length / 2)).reduce((a, b) => a + b, 0) / Math.max(1, Math.ceil(recentAtr.length / 2));
  const contracting = avgLast < avgFirst * 0.85;
  const slope = closes.at(-1) - closes[Math.max(0, n - 15)];
  if (contracting) return PRICE_ACTION.contracting;
  if (slope > 0) return PRICE_ACTION.up;
  if (slope < 0) return PRICE_ACTION.down;
  return PRICE_ACTION.flat;
}

/** Agrupa velas diarias en semanales (lunes a domingo, UTC). Se usa cuando
 *  el proveedor no da un timeframe semanal nativo (ej. cripto vía CoinGecko),
 *  como confirmación de tendencia de mayor plazo sobre datos reales. */
export function resampleWeekly(candles) {
  const { o, h, l, c, v, t } = candles;
  if (!t || t.length !== c.length) return null;
  const weeks = new Map();
  for (let i = 0; i < c.length; i++) {
    const d = new Date(t[i] + 'T00:00:00Z');
    if (isNaN(d.getTime())) continue;
    const dow = (d.getUTCDay() + 6) % 7; // lunes=0
    const monday = new Date(d); monday.setUTCDate(d.getUTCDate() - dow);
    const key = monday.toISOString().slice(0, 10);
    if (!weeks.has(key)) weeks.set(key, { o: o[i], h: h[i], l: l[i], c: c[i], v: v[i] || 0, t: key });
    else {
      const w = weeks.get(key);
      w.h = Math.max(w.h, h[i]); w.l = Math.min(w.l, l[i]); w.c = c[i]; w.v += v[i] || 0;
    }
  }
  const arr = Array.from(weeks.values());
  return { o: arr.map(w => w.o), h: arr.map(w => w.h), l: arr.map(w => w.l), c: arr.map(w => w.c), v: arr.map(w => w.v), t: arr.map(w => w.t) };
}

/** Compara el sesgo direccional diario vs. semanal. Confirmar con el timeframe
 *  mayor es una práctica estándar de análisis técnico — reduce falsas señales
 *  del ruido de corto plazo. */
export function weeklyConfluence(daily, weekly) {
  if (!weekly) return null;
  const dailyBias = daily.bullishAlign ? 'up' : daily.bearishAlign ? 'down' : (daily.price > daily.ema200 ? 'up' : 'down');
  const weeklyBias = weekly.bullishAlign ? 'up' : weekly.bearishAlign ? 'down' : (weekly.price > weekly.ema50 ? 'up' : 'down');
  return { dailyBias, weeklyBias, agree: dailyBias === weeklyBias };
}

/** Calcula el bloque técnico completo listo para el reporte. */
export function computeTechnical(candles) {
  const { h, l, c, v } = candles;
  const last = c.length - 1;
  const price = c[last];

  const ema20 = ema(c, 20), ema50 = ema(c, 50), ema100 = ema(c, 100), ema200 = ema(c, 200);
  const r = rsi(c, 14);
  const { macdLine, signalLine, hist } = macd(c);
  const a = adx(h, l, c, 14);
  const tr = atr(h, l, c, 14);
  const bb = bollinger(c, 20, 2);
  const ov = obv(c, v);
  const vwap = rollingVwap(h, l, c, v, 20);
  const sr = supportResistance(h, l, c);
  const fib = fibonacci(h, l);
  const structure = marketStructure(h, l);
  const trSeries = tr;

  const obvSlope = ov[last] - ov[Math.max(0, last - 10)];
  const hasVolume = v.some(x => x > 0);
  const priceSlope = price - c[Math.max(0, last - 10)];
  // Confirmación de volumen: un movimiento de precio sin que el OBV
  // acompañe en la misma dirección es la causa más común de rupturas
  // falsas — se compara el signo de ambas pendientes en la misma ventana.
  let obvConfirms = null;
  if (hasVolume && Math.abs(priceSlope) / price > 0.002) {
    obvConfirms = Math.sign(obvSlope) === Math.sign(priceSlope);
  }
  const divergence = detectDivergence(c, r);
  const bullishAlign = ema20[last] > ema50[last] && ema50[last] > ema100[last] && ema100[last] > ema200[last];
  const bearishAlign = ema20[last] < ema50[last] && ema50[last] < ema100[last] && ema100[last] < ema200[last];
  const bbPos = isNaN(bb.upper[last]) ? null
    : price >= bb.upper[last] * 0.98 ? 'Precio cerca de banda superior'
    : price <= bb.lower[last] * 1.02 ? 'Precio cerca de banda inferior'
    : 'Precio en banda media';

  return {
    price,
    ema20: ema20[last], ema50: ema50[last], ema100: ema100[last], ema200: ema200[last],
    rsi: r[last], macd: macdLine[last], signal: signalLine[last], hist: hist[last],
    adx: a[last], atr: tr[last], vwap: vwap[last],
    bbUpper: bb.upper[last], bbMid: bb.mid[last], bbLower: bb.lower[last], bbPos,
    obvTrend: ov.length > 10 ? (obvSlope > 0 ? 'Ascendente — acumulación' : obvSlope < 0 ? 'Descendente — distribución' : 'Lateral') : 'N/D',
    obvConfirms, hasVolume, divergence,
    support: sr.support, resistance: sr.resistance,
    fib, structure,
    priceAction: priceActionLabel(c, trSeries),
    bullishAlign, bearishAlign,
    primaryTrend: bullishAlign ? 'Alcista'
      : bearishAlign ? 'Bajista'
      : (price > ema200[last] ? 'Alcista de fondo, corrección de corto plazo' : 'Bajista de fondo, rebote de corto plazo'),
  };
}

/** Correlación (Pearson) y beta de los retornos diarios del activo contra un
 *  benchmark (SPY), sobre la ventana de datos que ambas series tengan en
 *  común. Beta = covarianza(activo,bench) / varianza(bench). */
export function correlationAndBeta(assetCloses, benchCloses) {
  const n = Math.min(assetCloses.length, benchCloses.length);
  if (n < 20) return null;
  const a = assetCloses.slice(-n), b = benchCloses.slice(-n);
  const ra = [], rb = [];
  for (let i = 1; i < n; i++) {
    ra.push((a[i] - a[i - 1]) / a[i - 1]);
    rb.push((b[i] - b[i - 1]) / b[i - 1]);
  }
  const mean = (arr) => arr.reduce((s, v) => s + v, 0) / arr.length;
  const ma = mean(ra), mb = mean(rb);
  let cov = 0, varA = 0, varB = 0;
  for (let i = 0; i < ra.length; i++) {
    const da = ra[i] - ma, db = rb[i] - mb;
    cov += da * db; varA += da * da; varB += db * db;
  }
  cov /= ra.length; varA /= ra.length; varB /= ra.length;
  const corr = (varA > 0 && varB > 0) ? cov / Math.sqrt(varA * varB) : null;
  const beta = varB > 0 ? cov / varB : null;
  return { correlation: corr, beta };
}
