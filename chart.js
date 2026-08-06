/**
 * chart.js — Gráfico de precio en SVG puro (sin dependencias externas).
 * Panel de precio (velas + EMA20/50 + Bandas de Bollinger + soporte/
 * resistencia + zonas de compra/venta del plan operativo) con paneles de
 * Volumen y RSI debajo, todo sobre el mismo OHLCV real que usa
 * indicators.js — nada se simula acá.
 */
import { ema, bollinger, rsi, macd, sma, atr, keltnerChannels, detectCandlePattern } from './indicators.js';

/* ── Supertrend (ATR trailing por bandas) — indicador de tendencia clásico:
 *  línea verde bajo el precio en tendencia alcista, roja arriba en bajista,
 *  que "flipea" en el cruce. Se calcula sobre el OHLC real. ── */
function supertrend(highs, lows, closes, period = 10, mult = 3) {
  const atrS = atr(highs, lows, closes, period);
  const n = closes.length;
  const line = new Array(n).fill(NaN), dir = new Array(n).fill(1); // 1 = alcista, -1 = bajista
  let prevUpper = NaN, prevLower = NaN, prevDir = 1, prevST = NaN;
  for (let i = 0; i < n; i++) {
    if (isNaN(atrS[i])) continue;
    const hl2 = (highs[i] + lows[i]) / 2;
    let upper = hl2 + mult * atrS[i], lower = hl2 - mult * atrS[i];
    if (!isNaN(prevUpper)) upper = (upper < prevUpper || closes[i - 1] > prevUpper) ? upper : prevUpper;
    if (!isNaN(prevLower)) lower = (lower > prevLower || closes[i - 1] < prevLower) ? lower : prevLower;
    let d = prevDir;
    if (!isNaN(prevST)) {
      if (prevDir === 1 && closes[i] < prevLower) d = -1;
      else if (prevDir === -1 && closes[i] > prevUpper) d = 1;
    }
    const st = d === 1 ? lower : upper;
    line[i] = st; dir[i] = d;
    prevUpper = upper; prevLower = lower; prevDir = d; prevST = st;
  }
  return { line, dir };
}

/* ── Ichimoku Kinko Hyo (versión sin desplazamiento adelantado, ya que el
 *  gráfico no tiene barras futuras): Tenkan(9), Kijun(26) y la nube
 *  Senkou A/B calculada en el eje actual — lectura de tendencia y de la
 *  "nube" como zona de soporte/resistencia. ── */
function donchianMid(highs, lows, period) {
  const n = highs.length, out = new Array(n).fill(NaN);
  for (let i = period - 1; i < n; i++) {
    let hi = -Infinity, lo = Infinity;
    for (let k = i - period + 1; k <= i; k++) { if (highs[k] > hi) hi = highs[k]; if (lows[k] < lo) lo = lows[k]; }
    out[i] = (hi + lo) / 2;
  }
  return out;
}
function ichimoku(highs, lows) {
  const tenkan = donchianMid(highs, lows, 9);
  const kijun = donchianMid(highs, lows, 26);
  const senkouA = tenkan.map((t, i) => (isNaN(t) || isNaN(kijun[i])) ? NaN : (t + kijun[i]) / 2);
  const senkouB = donchianMid(highs, lows, 52);
  return { tenkan, kijun, senkouA, senkouB };
}

const W = 960;
const PAD_L = 6, PAD_R = 82;
const GAP = 14;
const PRICE_H = 258, VOL_H = 48, MACD_H = 60, RSI_H = 68;
const DATE_H = 24;
const PRICE_TOP = 16;
const PRICE_BOTTOM = PRICE_TOP + PRICE_H;
const VOL_TOP = PRICE_BOTTOM + GAP;
const VOL_BOTTOM = VOL_TOP + VOL_H;
const MACD_TOP = VOL_BOTTOM + GAP;
const MACD_BOTTOM = MACD_TOP + MACD_H;
const RSI_TOP = MACD_BOTTOM + GAP;
const RSI_BOTTOM = RSI_TOP + RSI_H;
const H = RSI_BOTTOM + DATE_H;

const GREEN = 'oklch(0.72 0.17 152)', RED = 'oklch(0.68 0.19 23)';
const GOLD = 'oklch(0.80 0.15 85)', WHITE = 'oklch(0.90 0.012 260)';
const BLUE = 'oklch(0.78 0.13 199)';
const PURPLE = 'oklch(0.74 0.15 291)';
const GRID = 'oklch(0.30 0.025 262)', GRID_SOFT = 'oklch(0.27 0.02 262)';
const AXIS_TEXT = 'oklch(0.58 0.018 260)', PANEL_LABEL = 'oklch(0.66 0.02 260)';
const BUY_ZONE_FILL = 'oklch(0.72 0.17 152 / 0.14)', BUY_ZONE_LINE = 'oklch(0.76 0.18 152 / 0.55)';
const SELL_ZONE_FILL = 'oklch(0.75 0.15 70 / 0.14)', SELL_ZONE_LINE = 'oklch(0.75 0.15 70 / 0.55)';
const STOP_COLOR = 'oklch(0.70 0.21 23)';
const TP_COLOR = 'oklch(0.80 0.15 85)';

function scaleY(value, min, max, top, bottom) {
  if (max === min) return (top + bottom) / 2;
  return bottom - ((value - min) / (max - min)) * (bottom - top);
}

function niceFmt(v) {
  if (v == null || isNaN(v)) return '—';
  return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2);
}
function fmtVol(n) { return n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(0) + 'K' : String(n); }

function polyline(series, x, y, color, opacity = 0.9, width = 1.5) {
  let d = '', started = false;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null || isNaN(v)) continue;
    d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    started = true;
  }
  return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="${width}" opacity="${opacity}" stroke-linejoin="round" stroke-linecap="round"/>` : '';
}

// Extensión del eje de precio — compartida por el render y el crosshair para
// que el mapeo mouse→precio coincida exactamente con lo dibujado.
function priceExtent(candles, start, opts) {
  const h = candles.h.slice(start), l = candles.l.slice(start);
  const bb = bollinger(candles.c, 20, 2);
  const bbU = bb.upper.slice(start).filter(x => !isNaN(x)), bbL = bb.lower.slice(start).filter(x => !isNaN(x));
  let pMin = Math.min(...l), pMax = Math.max(...h);
  if (bbU.length) pMax = Math.max(pMax, ...bbU);
  if (bbL.length) pMin = Math.min(pMin, ...bbL);
  const { support, resistance, plan } = opts || {};
  if (support != null && isFinite(support)) pMin = Math.min(pMin, support);
  if (resistance != null && isFinite(resistance)) pMax = Math.max(pMax, resistance);
  if (plan) {
    if (isFinite(plan.buyLow)) pMin = Math.min(pMin, plan.buyLow);
    if (isFinite(plan.stopLoss)) pMin = Math.min(pMin, plan.stopLoss);
    if (isFinite(plan.tp1)) pMax = Math.max(pMax, plan.tp1);
    if (isFinite(plan.sellHigh)) pMax = Math.max(pMax, plan.sellHigh);
  }
  const pPad = (pMax - pMin) * 0.08 || pMax * 0.02 || 1;
  return { pMin: pMin - pPad, pMax: pMax + pPad };
}

export function renderPriceChartSVG(candles, opts = {}, windowSize = 130) {
  const {
    support, resistance, plan, poc = null,
    type = 'candles',          // 'candles' | 'line' | 'area' | 'heikin'
    logScale = false,
    showEma = true, showBb = true, showVwap = true, showPoc = true, showFib = true, showGaps = true,
    showKeltner = false, showSupertrend = false, showPivots = false, showIchimoku = false, showVolProfile = false,
    showPatterns = false,
    earningsInDays = null,
  } = opts;
  const nTotal = candles.c.length;
  if (nTotal < 5) return '<div class="chart-empty">Historial insuficiente para graficar.</div>';

  const start = Math.max(0, nTotal - windowSize);
  const o = candles.o.slice(start), h = candles.h.slice(start), l = candles.l.slice(start), c = candles.c.slice(start);
  const v = (candles.v || []).slice(start);
  const t = (candles.t || []).slice(start);
  const count = c.length;

  const ema20 = ema(candles.c, 20).slice(start);
  const ema50 = ema(candles.c, 50).slice(start);
  const ema200 = ema(candles.c, 200).slice(start);
  const bb = bollinger(candles.c, 20, 2);
  const bbUpper = bb.upper.slice(start), bbLower = bb.lower.slice(start);
  const rsiFull = rsi(candles.c, 14).slice(start);
  const { macdLine: macdF, signalLine: signalF, hist: histF } = macd(candles.c);
  const macdLine = macdF.slice(start), signalLine = signalF.slice(start), macdHist = histF.slice(start);
  const volMa = sma(v, 20);
  const hasVolume = v.some(x => x > 0);

  const plotW = W - PAD_L - PAD_R;
  const slot = plotW / count;
  const candleW = Math.max(1.2, Math.min(9, slot * 0.66));
  const x = (i) => PAD_L + slot * i + slot / 2;

  /* ── escala de precio (lineal o logarítmica) ── */
  const { pMin, pMax } = priceExtent(candles, start, opts);
  const useLog = logScale && pMin > 0 && pMax > 0;
  const tScale = (val) => useLog ? Math.log(val) : val;
  const tMin = tScale(pMin), tMax = tScale(pMax);
  const yPrice = (val) => (val == null || !isFinite(val) || (useLog && val <= 0)) ? NaN : scaleY(tScale(val), tMin, tMax, PRICE_TOP, PRICE_BOTTOM);

  const last = (arr) => { for (let i = arr.length - 1; i >= 0; i--) if (arr[i] != null && !isNaN(arr[i])) return arr[i]; return null; };

  /* ── grilla horizontal + etiquetas de precio a la derecha ── */
  let priceGridSvg = '';
  for (let i = 0; i <= 5; i++) {
    const val = useLog ? Math.exp(tMin + ((tMax - tMin) * i) / 5) : pMin + ((pMax - pMin) * i) / 5;
    const yy = yPrice(val).toFixed(1);
    priceGridSvg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${GRID_SOFT}" stroke-width="1"/>`;
    priceGridSvg += `<text x="${W - PAD_R + 6}" y="${yy}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${niceFmt(val)}</text>`;
  }

  /* ── grilla vertical temporal (tenue, alineada con los ticks de fecha) ── */
  let vGridSvg = '';
  const ticks = 6;
  for (let k = 1; k < ticks; k++) {
    const i = Math.min(count - 1, Math.round((k * (count - 1)) / ticks));
    vGridSvg += `<line x1="${x(i).toFixed(1)}" y1="${PRICE_TOP}" x2="${x(i).toFixed(1)}" y2="${RSI_BOTTOM}" stroke="${GRID_SOFT}" stroke-width="1" stroke-dasharray="1 5" opacity="0.7"/>`;
  }

  /* ── zonas de compra/venta del plan operativo ── */
  const pillLabel = (xLeft, yCenter, label, bg, fg, anchor = 'start') => {
    const w = label.length * 6.3 + 12;
    const rectX = anchor === 'start' ? xLeft : xLeft - w;
    return `<rect x="${rectX.toFixed(1)}" y="${(yCenter - 8).toFixed(1)}" width="${w.toFixed(1)}" height="16" rx="3" fill="${bg}"/>
      <text x="${(anchor === 'start' ? xLeft + 5 : xLeft - 5).toFixed(1)}" y="${yCenter.toFixed(1)}" fill="${fg}" font-size="10" font-weight="700" font-family="IBM Plex Mono, monospace" letter-spacing="0.3" text-anchor="${anchor === 'start' ? 'start' : 'end'}" dominant-baseline="middle">${label}</text>`;
  };
  let zonesSvg = '';
  const zoneBand = (lo, hi, fill, lineColor, label, pillBg, pillFg) => {
    if (lo == null || hi == null || !isFinite(lo) || !isFinite(hi)) return '';
    const yTop = yPrice(Math.max(lo, hi)), yBottom = yPrice(Math.min(lo, hi));
    const bandH = Math.max(1, yBottom - yTop);
    return `<rect x="${PAD_L}" y="${yTop.toFixed(1)}" width="${(W - PAD_L - PAD_R)}" height="${bandH.toFixed(1)}" fill="${fill}"/>
      <line x1="${PAD_L}" y1="${yTop.toFixed(1)}" x2="${W - PAD_R}" y2="${yTop.toFixed(1)}" stroke="${lineColor}" stroke-width="1" stroke-dasharray="2 3"/>
      <line x1="${PAD_L}" y1="${yBottom.toFixed(1)}" x2="${W - PAD_R}" y2="${yBottom.toFixed(1)}" stroke="${lineColor}" stroke-width="1" stroke-dasharray="2 3"/>
      ${pillLabel(PAD_L + 8, yTop + 11, label, pillBg, pillFg)}`;
  };
  const zoneLine = (value, color, label, textColor) => {
    if (value == null || !isFinite(value)) return '';
    const yy = yPrice(value);
    return `<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${W - PAD_R}" y2="${yy.toFixed(1)}" stroke="${color}" stroke-width="1.4" stroke-dasharray="6 3" opacity="0.9"/>
      ${pillLabel(W - PAD_R + 6, yy, label, color, textColor)}`;
  };
  if (plan) {
    zonesSvg += zoneBand(plan.buyLow, plan.buyHigh, BUY_ZONE_FILL, BUY_ZONE_LINE, 'ZONA DE COMPRA', 'oklch(0.30 0.09 152 / 0.85)', GREEN);
    zonesSvg += zoneBand(plan.sellLow, plan.sellHigh, SELL_ZONE_FILL, SELL_ZONE_LINE, 'ZONA DE VENTA', 'oklch(0.32 0.08 70 / 0.85)', GOLD);
    zonesSvg += zoneLine(plan.stopLoss, STOP_COLOR, `STOP ${niceFmt(plan.stopLoss)}`, 'oklch(0.16 0.03 23)');
    zonesSvg += zoneLine(plan.tp1, TP_COLOR, `TP1 ${niceFmt(plan.tp1)}`, 'oklch(0.18 0.03 85)');
  }

  /* ── relleno de Bandas de Bollinger (área tenue entre banda sup. e inf.) ── */
  let bbFill = '';
  if (showBb) {
    const pts = [];
    for (let i = 0; i < count; i++) if (!isNaN(bbUpper[i])) pts.push(`${i === 0 || isNaN(bbUpper[i - 1]) ? 'M' : 'L'}${x(i).toFixed(1)},${yPrice(bbUpper[i]).toFixed(1)}`);
    for (let i = count - 1; i >= 0; i--) if (!isNaN(bbLower[i])) pts.push(`L${x(i).toFixed(1)},${yPrice(bbLower[i]).toFixed(1)}`);
    if (pts.length > 3) bbFill = `<path d="${pts.join(' ')} Z" fill="${BLUE}" opacity="0.05"/>`;
  }

  /* ── área degradada bajo el cierre (glow sutil) ── */
  const closePathD = (() => { let d = '', s = false; for (let i = 0; i < count; i++) { d += `${s ? 'L' : 'M'}${x(i).toFixed(1)},${yPrice(c[i]).toFixed(1)} `; s = true; } return d; })();
  const areaFill = closePathD ? `<path d="${closePathD} L${x(count - 1).toFixed(1)},${PRICE_BOTTOM} L${x(0).toFixed(1)},${PRICE_BOTTOM} Z" fill="url(#priceAreaGrad)" opacity="0.6"/>` : '';
  const defsSvg = `<defs>
    <linearGradient id="priceAreaGrad" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="oklch(0.70 0.19 291)" stop-opacity="0.26"/>
      <stop offset="100%" stop-color="oklch(0.70 0.19 291)" stop-opacity="0"/>
    </linearGradient>
    <filter id="lastGlow" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="2.4" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  </defs>`;

  /* ── Heikin-Ashi (velas suavizadas): promedia OHLC para filtrar ruido y
   *  mostrar la tendencia más "limpia". Se computa sobre la serie completa
   *  y se recorta a la ventana visible para que el color/tendencia sea
   *  consistente entre timeframes. ── */
  const heikin = (() => {
    const O = candles.o, Hh = candles.h, Ll = candles.l, Cc = candles.c, N = Cc.length;
    const ho = new Array(N), hh = new Array(N), hl = new Array(N), hc = new Array(N);
    for (let i = 0; i < N; i++) {
      hc[i] = (O[i] + Hh[i] + Ll[i] + Cc[i]) / 4;
      ho[i] = i === 0 ? (O[i] + Cc[i]) / 2 : (ho[i - 1] + hc[i - 1]) / 2;
      hh[i] = Math.max(Hh[i], ho[i], hc[i]);
      hl[i] = Math.min(Ll[i], ho[i], hc[i]);
    }
    return { o: ho.slice(start), h: hh.slice(start), l: hl.slice(start), c: hc.slice(start) };
  })();

  // OHLC efectivo para dibujar el cuerpo de las velas según el tipo de gráfico.
  const dO = type === 'heikin' ? heikin.o : o;
  const dH = type === 'heikin' ? heikin.h : h;
  const dL = type === 'heikin' ? heikin.l : l;
  const dC = type === 'heikin' ? heikin.c : c;

  /* ── serie de precio (velas / línea / área / Heikin-Ashi) ── */
  let candlesSvg = '';
  if (type === 'line' || type === 'area') {
    // El área/glow bajo el cierre ya se dibuja con `areaFill`; acá va la línea.
    candlesSvg = polyline(c, x, yPrice, 'oklch(0.80 0.16 264)', 0.98, 2);
  } else {
    for (let i = 0; i < count; i++) {
      const up = dC[i] >= dO[i];
      const color = up ? GREEN : RED;
      const xc = x(i);
      candlesSvg += `<line x1="${xc.toFixed(1)}" y1="${yPrice(dH[i]).toFixed(1)}" x2="${xc.toFixed(1)}" y2="${yPrice(dL[i]).toFixed(1)}" stroke="${color}" stroke-width="1" opacity="0.9"/>`;
      const yOpen = yPrice(dO[i]), yClose = yPrice(dC[i]);
      const rectY = Math.min(yOpen, yClose), rectH = Math.max(1, Math.abs(yOpen - yClose));
      // Cuerpo lleno para bajistas, hueco (contorno) para alcistas — convención
      // de las plataformas profesionales, más limpio de leer de un vistazo.
      if (up) candlesSvg += `<rect x="${(xc - candleW / 2).toFixed(1)}" y="${rectY.toFixed(1)}" width="${candleW.toFixed(1)}" height="${rectH.toFixed(1)}" fill="oklch(0.72 0.17 152 / 0.25)" stroke="${color}" stroke-width="1"/>`;
      else candlesSvg += `<rect x="${(xc - candleW / 2).toFixed(1)}" y="${rectY.toFixed(1)}" width="${candleW.toFixed(1)}" height="${rectH.toFixed(1)}" fill="${color}"/>`;
    }
  }

  const bbSvg = showBb ? polyline(bbUpper, x, yPrice, BLUE, 0.5, 1) + polyline(bbLower, x, yPrice, BLUE, 0.5, 1) : '';
  const emaSvg = showEma ? polyline(ema20, x, yPrice, GOLD, 0.95, 1.5) + polyline(ema50, x, yPrice, WHITE, 0.9, 1.5) + polyline(ema200, x, yPrice, PURPLE, 0.85, 1.6) : '';

  /* ── marcadores de máximo/mínimo del rango visible ── */
  let extremaSvg = '';
  {
    let hiIdx = 0, loIdx = 0;
    for (let i = 1; i < count; i++) { if (h[i] > h[hiIdx]) hiIdx = i; if (l[i] < l[loIdx]) loIdx = i; }
    const hiX = x(hiIdx), hiY = yPrice(h[hiIdx]), loX = x(loIdx), loY = yPrice(l[loIdx]);
    extremaSvg = `
      <text x="${hiX.toFixed(1)}" y="${(hiY - 6).toFixed(1)}" fill="${AXIS_TEXT}" font-size="9" font-family="IBM Plex Mono, monospace" text-anchor="middle">▲ ${niceFmt(h[hiIdx])}</text>
      <text x="${loX.toFixed(1)}" y="${(loY + 13).toFixed(1)}" fill="${AXIS_TEXT}" font-size="9" font-family="IBM Plex Mono, monospace" text-anchor="middle">▼ ${niceFmt(l[loIdx])}</text>`;
  }

  /* ── último precio: línea + etiqueta + punto con glow ── */
  const lastPrice = c[count - 1];
  const lastUp = count > 1 ? lastPrice >= c[count - 2] : true;
  const lastColor = lastUp ? GREEN : RED;
  const lastY = yPrice(lastPrice);
  const lastPriceSvg = `<line x1="${PAD_L}" y1="${lastY.toFixed(1)}" x2="${W - PAD_R}" y2="${lastY.toFixed(1)}" stroke="${lastColor}" stroke-width="1" stroke-dasharray="2 2" opacity="0.75"/>
    <circle cx="${x(count - 1).toFixed(1)}" cy="${lastY.toFixed(1)}" r="3.2" fill="${lastColor}" filter="url(#lastGlow)"/>
    ${pillLabel(W - PAD_R + 6, lastY, niceFmt(lastPrice), lastColor, lastUp ? 'oklch(0.16 0.03 152)' : 'oklch(0.16 0.03 23)')}`;

  /* ── panel de volumen (barras + media móvil) ── */
  let volSvg = `<text x="${PAD_L}" y="${VOL_TOP - 4}" fill="${PANEL_LABEL}" font-size="10" font-weight="600" font-family="IBM Plex Mono, monospace">VOLUMEN</text>`;
  if (hasVolume) {
    const vMax = Math.max(...v) || 1;
    volSvg += `<text x="${W - PAD_R + 6}" y="${VOL_TOP + 6}" fill="${AXIS_TEXT}" font-size="9" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${fmtVol(vMax)}</text>`;
    for (let i = 0; i < count; i++) {
      const up = c[i] >= o[i];
      const barH = (v[i] / vMax) * (VOL_H - 4);
      const xc = x(i);
      volSvg += `<rect x="${(xc - candleW / 2).toFixed(1)}" y="${(VOL_BOTTOM - barH).toFixed(1)}" width="${candleW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${up ? GREEN : RED}" opacity="0.5"/>`;
    }
    const yVol = (val) => VOL_BOTTOM - (val / vMax) * (VOL_H - 4);
    volSvg += polyline(volMa.slice(start), x, yVol, GOLD, 0.85, 1.2);
  } else {
    volSvg += `<text x="${PAD_L}" y="${(VOL_TOP + VOL_BOTTOM) / 2}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace">Sin datos de volumen para este activo/timeframe</text>`;
  }

  /* ── panel MACD (histograma + línea MACD + señal) ── */
  let macdSvg = `<text x="${PAD_L}" y="${MACD_TOP - 4}" fill="${PANEL_LABEL}" font-size="10" font-weight="600" font-family="IBM Plex Mono, monospace">MACD (12,26,9)</text>`;
  {
    const vals = [...macdLine, ...signalLine, ...macdHist].filter(x => x != null && !isNaN(x));
    const maxAbs = Math.max(0.0001, ...vals.map(Math.abs));
    const yMacd = (val) => scaleY(val, -maxAbs, maxAbs, MACD_TOP, MACD_BOTTOM);
    const zeroY = yMacd(0);
    macdSvg += `<line x1="${PAD_L}" y1="${zeroY.toFixed(1)}" x2="${W - PAD_R}" y2="${zeroY.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    for (let i = 0; i < count; i++) {
      if (macdHist[i] == null || isNaN(macdHist[i])) continue;
      const hy = yMacd(macdHist[i]);
      const rising = i > 0 && macdHist[i - 1] != null && macdHist[i] >= macdHist[i - 1];
      const col = macdHist[i] >= 0 ? (rising ? GREEN : 'oklch(0.55 0.12 152)') : (rising ? 'oklch(0.55 0.13 23)' : RED);
      macdSvg += `<rect x="${(x(i) - candleW / 2).toFixed(1)}" y="${Math.min(hy, zeroY).toFixed(1)}" width="${candleW.toFixed(1)}" height="${Math.max(0.5, Math.abs(hy - zeroY)).toFixed(1)}" fill="${col}" opacity="0.7"/>`;
    }
    macdSvg += polyline(macdLine, x, yMacd, BLUE, 0.95, 1.3) + polyline(signalLine, x, yMacd, GOLD, 0.95, 1.3);
  }

  /* ── panel de RSI (con zonas de sobrecompra/sobreventa sombreadas) ── */
  const yRsi = (val) => scaleY(val, 0, 100, RSI_TOP, RSI_BOTTOM);
  let rsiSvg = `<text x="${PAD_L}" y="${RSI_TOP - 4}" fill="${PANEL_LABEL}" font-size="10" font-weight="600" font-family="IBM Plex Mono, monospace">RSI (14)</text>`;
  rsiSvg += `<rect x="${PAD_L}" y="${yRsi(100).toFixed(1)}" width="${plotW}" height="${(yRsi(70) - yRsi(100)).toFixed(1)}" fill="${RED}" opacity="0.06"/>`;
  rsiSvg += `<rect x="${PAD_L}" y="${yRsi(30).toFixed(1)}" width="${plotW}" height="${(yRsi(0) - yRsi(30)).toFixed(1)}" fill="${GREEN}" opacity="0.06"/>`;
  for (const level of [30, 50, 70]) {
    const yy = yRsi(level).toFixed(1);
    rsiSvg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${GRID}" stroke-width="1" stroke-dasharray="${level === 50 ? '2 4' : '0'}"/>`;
    rsiSvg += `<text x="${W - PAD_R + 6}" y="${yy}" fill="${AXIS_TEXT}" font-size="9" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${level}</text>`;
  }
  rsiSvg += polyline(rsiFull, x, yRsi, PURPLE, 1, 1.5);
  const rsiLast = last(rsiFull);
  if (rsiLast != null) rsiSvg += pillLabel(W - PAD_R + 6, yRsi(rsiLast), rsiLast.toFixed(0), PURPLE, 'oklch(0.15 0.03 291)');

  /* ── fechas ── */
  let dateSvg = '';
  if (t.length === count) {
    for (let k = 0; k <= ticks; k++) {
      const i = Math.min(count - 1, Math.round((k * (count - 1)) / ticks));
      dateSvg += `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${(t[i] || '').slice(5)}</text>`;
    }
  }

  /* ── separadores entre paneles ── */
  const sep = (yy) => `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
  const sepSvg = sep(PRICE_BOTTOM + GAP / 2) + sep(VOL_BOTTOM + GAP / 2) + sep(MACD_BOTTOM + GAP / 2);

  /* ── crosshair (líneas + etiquetas flotantes, ocultas hasta el hover) ── */
  const crosshairSvg = `
    <line class="chart-ch-vline" x1="0" y1="${PRICE_TOP}" x2="0" y2="${RSI_BOTTOM}" stroke="${WHITE}" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
    <line class="chart-ch-hline" x1="${PAD_L}" y1="0" x2="${W - PAD_R}" y2="0" stroke="${WHITE}" stroke-width="1" stroke-dasharray="3 3" opacity="0"/>
    <g class="chart-ch-ytag" opacity="0"><rect x="${W - PAD_R + 2}" y="0" width="${PAD_R - 4}" height="16" rx="3" fill="oklch(0.86 0.02 260)"/><text x="${W - PAD_R + 7}" y="8" fill="oklch(0.16 0.02 260)" font-size="10" font-weight="700" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">0</text></g>
    <g class="chart-ch-xtag" opacity="0"><rect x="0" y="${H - DATE_H + 2}" width="64" height="15" rx="3" fill="oklch(0.86 0.02 260)"/><text x="32" y="${H - DATE_H + 9}" fill="oklch(0.16 0.02 260)" font-size="9.5" font-weight="700" font-family="IBM Plex Mono, monospace" text-anchor="middle" dominant-baseline="middle"></text></g>`;

  /* ── línea de estado (OHLC + var) — se actualiza al pasar el mouse ── */
  const chg = count > 1 ? ((lastPrice - c[count - 2]) / c[count - 2]) * 100 : 0;
  const statusLine = `<div class="chart-statusline" data-default="1">
    <span class="csl-o">O <b>${niceFmt(o[count - 1])}</b></span>
    <span class="csl-h">H <b>${niceFmt(h[count - 1])}</b></span>
    <span class="csl-l">L <b>${niceFmt(l[count - 1])}</b></span>
    <span class="csl-c">C <b>${niceFmt(lastPrice)}</b></span>
    <span class="${chg >= 0 ? 'csl-up' : 'csl-down'}">${chg >= 0 ? '+' : ''}${chg.toFixed(2)}%</span>
  </div>`;

  /* ── VWAP (precio promedio ponderado por volumen, anclado al inicio de la
   * ventana) — el "precio justo" donde más se operó; suele actuar de imán. ── */
  let vwapSvg = '';
  if (showVwap && hasVolume) {
    const vwap = []; let cumPV = 0, cumV = 0;
    for (let i = 0; i < count; i++) { const tp = (h[i] + l[i] + c[i]) / 3; cumPV += tp * (v[i] || 0); cumV += (v[i] || 0); vwap.push(cumV > 0 ? cumPV / cumV : null); }
    vwapSvg = polyline(vwap, x, yPrice, 'oklch(0.82 0.11 199)', 0.75, 1.3);
    const vwLast = last(vwap);
    if (vwLast != null) vwapSvg += `<text x="${(x(count - 1) - 4).toFixed(1)}" y="${(yPrice(vwLast) - 4).toFixed(1)}" fill="oklch(0.82 0.11 199)" font-size="8.5" font-family="IBM Plex Mono, monospace" text-anchor="end">VWAP</text>`;
  }

  /* ── POC (Volume Profile): el precio de mayor volumen operado — soporte/
   * resistencia "pesado". Llega ya calculado en opts.poc. ── */
  let pocSvg = '';
  if (showPoc && poc != null && isFinite(poc) && poc >= pMin && poc <= pMax) {
    const yy = yPrice(poc);
    pocSvg = `<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${W - PAD_R}" y2="${yy.toFixed(1)}" stroke="${BLUE}" stroke-width="1" stroke-dasharray="5 3" opacity="0.55"/>${pillLabel(W - PAD_R + 6, yy, 'POC ' + niceFmt(poc), BLUE, 'oklch(0.15 0.03 199)')}`;
  }

  /* ── Fibonacci: retrocesos del swing visible (0,382 / 0,5 / 0,618) — niveles
   * donde suele frenar/rebotar una corrección. ── */
  let fibSvg = '';
  if (showFib) {
    const fibHi = Math.max(...h), fibLo = Math.min(...l);
    if (fibHi > fibLo) for (const f of [0.382, 0.5, 0.618]) {
      const val = fibHi - (fibHi - fibLo) * f;
      const yy = yPrice(val);
      fibSvg += `<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${W - PAD_R}" y2="${yy.toFixed(1)}" stroke="${GOLD}" stroke-width="0.8" stroke-dasharray="1 5" opacity="0.38"/><text x="${(PAD_L + 3)}" y="${(yy - 2).toFixed(1)}" fill="${AXIS_TEXT}" font-size="8" font-family="IBM Plex Mono, monospace">fib ${(f * 100).toFixed(1)}</text>`;
    }
  }

  /* ── Gaps de apertura: hueco entre el cierre previo y la apertura (>1%) —
   * el mercado repreció de un salto; se sombrea el hueco. ── */
  let gapSvg = '';
  if (showGaps) for (let i = 1; i < count; i++) {
    const prevC = c[i - 1];
    if (!(prevC > 0)) continue;
    const gp = (o[i] - prevC) / prevC;
    if (Math.abs(gp) < 0.01) continue;
    const y1 = yPrice(prevC), y2 = yPrice(o[i]);
    gapSvg += `<rect x="${(x(i) - slot / 2).toFixed(1)}" y="${Math.min(y1, y2).toFixed(1)}" width="${Math.max(1, slot * 0.9).toFixed(1)}" height="${Math.max(1, Math.abs(y1 - y2)).toFixed(1)}" fill="${gp > 0 ? GREEN : RED}" opacity="0.14"><title>Gap ${gp > 0 ? '+' : ''}${(gp * 100).toFixed(1)}%</title></rect>`;
  }

  /* ── Keltner Channels (media EMA20 ± 1,5·ATR) — canal de volatilidad más
   * suave que Bollinger; el precio saliéndose marca impulso real. ── */
  const KELT = 'oklch(0.74 0.11 165)';
  let keltnerSvg = '';
  if (showKeltner) {
    const atrS = atr(candles.h, candles.l, candles.c, 14);
    const kc = keltnerChannels(candles.c, atrS, 20, 1.5);
    keltnerSvg = polyline(kc.upper.slice(start), x, yPrice, KELT, 0.6, 1) + polyline(kc.lower.slice(start), x, yPrice, KELT, 0.6, 1) + polyline(kc.mid.slice(start), x, yPrice, KELT, 0.4, 1);
  }

  /* ── Supertrend (ATR trailing): verde bajo el precio = alcista, roja arriba
   * = bajista; el punto marca el flip de tendencia. ── */
  let supertrendSvg = '';
  if (showSupertrend) {
    const st = supertrend(candles.h, candles.l, candles.c, 10, 3);
    const stLine = st.line.slice(start), stDir = st.dir.slice(start);
    const upSeg = stLine.map((val, i) => stDir[i] === 1 ? val : NaN);
    const dnSeg = stLine.map((val, i) => stDir[i] === -1 ? val : NaN);
    supertrendSvg = polyline(upSeg, x, yPrice, GREEN, 0.9, 1.8) + polyline(dnSeg, x, yPrice, RED, 0.9, 1.8);
    for (let i = 1; i < count; i++) {
      if (isNaN(stLine[i]) || isNaN(stDir[i - 1]) || stDir[i] === stDir[i - 1]) continue;
      const up = stDir[i] === 1;
      supertrendSvg += `<circle cx="${x(i).toFixed(1)}" cy="${yPrice(stLine[i]).toFixed(1)}" r="2.8" fill="${up ? GREEN : RED}"/>`;
    }
  }

  /* ── Ichimoku Kinko Hyo: Tenkan/Kijun + nube Senkou A-B (soporte/resistencia
   * dinámica). Nube sin desplazamiento adelantado — el gráfico no tiene barras
   * futuras — señalado como simplificación. ── */
  let ichimokuSvg = '';
  if (showIchimoku) {
    const ich = ichimoku(candles.h, candles.l);
    const tk = ich.tenkan.slice(start), kj = ich.kijun.slice(start), sa = ich.senkouA.slice(start), sb = ich.senkouB.slice(start);
    const aPts = [], bPts = [];
    for (let i = 0; i < count; i++) if (!isNaN(sa[i]) && !isNaN(sb[i])) { aPts.push([x(i), yPrice(sa[i])]); bPts.push([x(i), yPrice(sb[i])]); }
    let cloud = '';
    if (aPts.length > 2) {
      const fwd = aPts.map((p, idx) => `${idx === 0 ? 'M' : 'L'}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const back = bPts.slice().reverse().map(p => `L${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
      const bull = last(sa) >= last(sb);
      cloud = `<path d="${fwd} ${back} Z" fill="${bull ? GREEN : RED}" opacity="0.10"/>`;
    }
    ichimokuSvg = cloud
      + polyline(sa, x, yPrice, 'oklch(0.72 0.14 152)', 0.5, 1)
      + polyline(sb, x, yPrice, 'oklch(0.68 0.16 23)', 0.5, 1)
      + polyline(tk, x, yPrice, 'oklch(0.80 0.15 250)', 0.9, 1.3)
      + polyline(kj, x, yPrice, 'oklch(0.78 0.16 30)', 0.9, 1.3);
  }

  /* ── Pivots clásicos del día (P, R1/R2, S1/S2) desde la última barra —
   * niveles de referencia intradía que usan muchos operadores. ── */
  let pivotsSvg = '';
  if (showPivots) {
    const H_ = h[count - 1], L_ = l[count - 1], C_ = c[count - 1];
    const P = (H_ + L_ + C_) / 3, R1 = 2 * P - L_, S1 = 2 * P - H_, R2 = P + (H_ - L_), S2 = P - (H_ - L_);
    for (const [lab, val, col] of [['P', P, PANEL_LABEL], ['R1', R1, GOLD], ['S1', S1, BLUE], ['R2', R2, GOLD], ['S2', S2, BLUE]]) {
      if (!(val >= pMin && val <= pMax)) continue;
      const yy = yPrice(val);
      pivotsSvg += `<line x1="${PAD_L}" y1="${yy.toFixed(1)}" x2="${W - PAD_R}" y2="${yy.toFixed(1)}" stroke="${col}" stroke-width="0.8" stroke-dasharray="4 4" opacity="0.5"/><text x="${W - PAD_R - 3}" y="${(yy - 2).toFixed(1)}" fill="${col}" font-size="8" text-anchor="end" font-family="IBM Plex Mono, monospace" opacity="0.85">${lab} ${niceFmt(val)}</text>`;
    }
  }

  /* ── Volume Profile: histograma horizontal de volumen operado por nivel de
   * precio en la ventana visible; el bin dorado es el POC. Va de fondo, a la
   * izquierda, para no tapar las velas. ── */
  let volProfileSvg = '';
  if (showVolProfile && hasVolume) {
    const bins = 24, lo = pMin, hi = pMax, bs = (hi - lo) / bins;
    const vb = new Array(bins).fill(0);
    for (let i = 0; i < count; i++) { const tp = (h[i] + l[i] + c[i]) / 3; let b = Math.floor((tp - lo) / bs); b = Math.max(0, Math.min(bins - 1, b)); vb[b] += v[i] || 0; }
    const vbMax = Math.max(...vb) || 1, maxW = 92, pocBin = vb.indexOf(vbMax);
    for (let b = 0; b < bins; b++) {
      if (vb[b] <= 0) continue;
      const yTop = yPrice(lo + (b + 1) * bs), yBot = yPrice(lo + b * bs);
      const bw = (vb[b] / vbMax) * maxW;
      volProfileSvg += `<rect x="${PAD_L}" y="${yTop.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(1, yBot - yTop - 1).toFixed(1)}" fill="${b === pocBin ? GOLD : BLUE}" opacity="${b === pocBin ? 0.30 : 0.15}"/>`;
    }
  }

  /* ── Anotaciones de patrones de vela sobre las últimas ~40 velas visibles
   * (marcador con el nombre del patrón en el tooltip nativo). ── */
  let patternsSvg = '';
  if (showPatterns) {
    const from = Math.max(6, count - 40);
    for (let i = from; i < count; i++) {
      const gi = start + i + 1;
      const pat = detectCandlePattern(candles.o.slice(0, gi), candles.h.slice(0, gi), candles.l.slice(0, gi), candles.c.slice(0, gi));
      if (!pat) continue;
      const bull = pat.bias === 'bullish', bear = pat.bias === 'bearish';
      const col = bull ? GREEN : bear ? RED : AXIS_TEXT;
      const mark = bull ? '▲' : bear ? '▼' : '◆';
      const yy = bull ? yPrice(l[i]) + 13 : bear ? yPrice(h[i]) - 6 : yPrice(h[i]) - 6;
      patternsSvg += `<text x="${x(i).toFixed(1)}" y="${yy.toFixed(1)}" fill="${col}" font-size="9" text-anchor="middle" font-family="IBM Plex Mono, monospace"><title>${esc(pat.label)}</title>${mark}</text>`;
    }
  }

  /* ── Marcador de earnings próximo (línea en el borde derecho) ── */
  let earningsSvg = '';
  if (earningsInDays != null && earningsInDays >= 0 && earningsInDays <= 45) {
    const xE = W - PAD_R - 2;
    earningsSvg = `<line x1="${xE}" y1="${PRICE_TOP}" x2="${xE}" y2="${PRICE_BOTTOM}" stroke="${GOLD}" stroke-width="1" stroke-dasharray="3 3" opacity="0.6"/><text x="${xE - 4}" y="${PRICE_TOP + 11}" fill="${GOLD}" font-size="9" text-anchor="end" font-family="IBM Plex Mono, monospace">📅 Earnings ${earningsInDays === 0 ? 'hoy' : 'en ' + earningsInDays + 'd'}</text>`;
  }

  const emaLbl = (val) => val == null ? '—' : niceFmt(val);
  return `
    <div class="chart-svg-wrap">
    ${statusLine}
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gráfico de precio con volumen, MACD y RSI">
      ${defsSvg}
      ${vGridSvg}
      ${priceGridSvg}
      ${volProfileSvg}
      ${areaFill}
      ${bbFill}
      ${gapSvg}
      ${fibSvg}
      ${ichimokuSvg}
      ${keltnerSvg}
      ${pivotsSvg}
      ${zonesSvg}
      ${pocSvg}
      ${bbSvg}
      ${candlesSvg}
      ${supertrendSvg}
      ${emaSvg}
      ${vwapSvg}
      ${patternsSvg}
      ${extremaSvg}
      ${earningsSvg}
      ${lastPriceSvg}
      ${sepSvg}
      ${volSvg}
      ${macdSvg}
      ${rsiSvg}
      ${dateSvg}
      ${crosshairSvg}
    </svg>
    <div class="chart-hover-tooltip"></div>
    </div>
    <div class="chart-legend">
      <span><i style="background:${GREEN};"></i>Alcista</span>
      <span><i style="background:${RED};"></i>Bajista</span>
      ${showEma ? `<span><i style="background:${GOLD};"></i>EMA 20 · ${emaLbl(last(ema20))}</span>
      <span><i style="background:${WHITE};"></i>EMA 50 · ${emaLbl(last(ema50))}</span>
      <span><i style="background:${PURPLE};"></i>EMA 200 · ${emaLbl(last(ema200))}</span>` : ''}
      ${bbSvg ? `<span><i style="background:${BLUE};"></i>Bollinger</span>` : ''}
      ${vwapSvg ? `<span><i style="background:oklch(0.82 0.11 199);"></i>VWAP</span>` : ''}
      ${pocSvg ? `<span><i style="background:${BLUE};"></i>POC (volumen)</span>` : ''}
      ${fibSvg ? `<span><i style="background:${GOLD}; opacity:0.5;"></i>Fibonacci</span>` : ''}
      ${keltnerSvg ? `<span><i style="background:${KELT};"></i>Keltner</span>` : ''}
      ${supertrendSvg ? `<span><i style="background:${GREEN};"></i>Supertrend</span>` : ''}
      ${ichimokuSvg ? `<span><i style="background:oklch(0.80 0.15 250);"></i>Ichimoku</span>` : ''}
      ${pivotsSvg ? `<span><i style="background:${GOLD}; opacity:0.6;"></i>Pivots</span>` : ''}
      ${volProfileSvg ? `<span><i style="background:${BLUE}; opacity:0.5;"></i>Vol. Profile</span>` : ''}
      ${patternsSvg ? `<span><i style="background:${WHITE};"></i>Patrones</span>` : ''}
      ${plan ? `
      <span><i style="background:${GREEN}; opacity:0.35;"></i>Zona de compra</span>
      <span><i style="background:${GOLD}; opacity:0.35;"></i>Zona de venta</span>
      <span><i style="background:${STOP_COLOR};"></i>Stop loss</span>
      <span><i style="background:${TP_COLOR};"></i>Take profit 1</span>` : ''}
    </div>`;
}

/** Wire de interactividad post-render: crosshair completo (líneas vertical y
 *  horizontal + etiquetas flotantes de precio y fecha en los ejes), tooltip
 *  OHLC y línea de estado. Recalcula la MISMA geometría que el render
 *  (misma ventana, misma escala de precio vía priceExtent) para que todo
 *  coincida con lo dibujado. */
export function wireChartHover(container, candles, opts = {}, windowSize = 130) {
  const svg = container.querySelector('svg');
  const tooltip = container.querySelector('.chart-hover-tooltip');
  const vLine = container.querySelector('.chart-ch-vline');
  const hLine = container.querySelector('.chart-ch-hline');
  const yTag = container.querySelector('.chart-ch-ytag');
  const xTag = container.querySelector('.chart-ch-xtag');
  const statusLine = container.querySelector('.chart-statusline');
  if (!svg || !tooltip || !vLine) return;

  const nTotal = candles.c.length;
  const start = Math.max(0, nTotal - windowSize);
  const o = candles.o.slice(start), h = candles.h.slice(start), l = candles.l.slice(start), c = candles.c.slice(start);
  const v = (candles.v || []).slice(start);
  const t = (candles.t || []).slice(start);
  const count = c.length;
  if (count < 2) return;
  const plotW = W - PAD_L - PAD_R;
  const slot = plotW / count;
  const { pMin, pMax } = priceExtent(candles, start, opts);
  const useLog = opts.logScale && pMin > 0 && pMax > 0;
  const defaultStatus = statusLine ? statusLine.innerHTML : '';

  const onMove = (e) => {
    const rect = svg.getBoundingClientRect();
    const scaleX = W / rect.width, scaleY_ = H / rect.height;
    const svgX = (e.clientX - rect.left) * scaleX;
    const svgY = (e.clientY - rect.top) * scaleY_;
    let i = Math.floor((svgX - PAD_L) / slot);
    i = Math.max(0, Math.min(count - 1, i));
    const xc = PAD_L + slot * i + slot / 2;

    vLine.setAttribute('x1', xc.toFixed(1)); vLine.setAttribute('x2', xc.toFixed(1)); vLine.setAttribute('opacity', '0.55');

    // Crosshair horizontal + etiqueta de precio (solo dentro del panel de precio).
    if (hLine && yTag && svgY >= PRICE_TOP && svgY <= PRICE_BOTTOM) {
      const yy = Math.max(PRICE_TOP, Math.min(PRICE_BOTTOM, svgY));
      hLine.setAttribute('y1', yy.toFixed(1)); hLine.setAttribute('y2', yy.toFixed(1)); hLine.setAttribute('opacity', '0.45');
      const frac = (PRICE_BOTTOM - yy) / (PRICE_BOTTOM - PRICE_TOP);
      const priceAtY = useLog ? Math.exp(Math.log(pMin) + frac * (Math.log(pMax) - Math.log(pMin))) : pMin + frac * (pMax - pMin);
      yTag.setAttribute('opacity', '1');
      yTag.querySelector('rect').setAttribute('y', (yy - 8).toFixed(1));
      const tx = yTag.querySelector('text'); tx.setAttribute('y', yy.toFixed(1)); tx.textContent = niceFmt(priceAtY);
    } else if (hLine) { hLine.setAttribute('opacity', '0'); yTag && yTag.setAttribute('opacity', '0'); }

    // Etiqueta de fecha en el eje inferior.
    if (xTag) {
      xTag.setAttribute('opacity', '1');
      const w = 64, rx = Math.max(PAD_L, Math.min(W - PAD_R - w, xc - w / 2));
      xTag.querySelector('rect').setAttribute('x', rx.toFixed(1));
      const tx = xTag.querySelector('text'); tx.setAttribute('x', (rx + w / 2).toFixed(1)); tx.textContent = (t[i] || '').slice(5);
    }

    // Línea de estado OHLC.
    if (statusLine) {
      const up = c[i] >= o[i];
      const changePct = i > 0 ? ((c[i] - c[i - 1]) / c[i - 1]) * 100 : 0;
      statusLine.innerHTML = `<span class="csl-o">O <b>${niceFmt(o[i])}</b></span><span class="csl-h">H <b>${niceFmt(h[i])}</b></span><span class="csl-l">L <b>${niceFmt(l[i])}</b></span><span class="csl-c">C <b>${niceFmt(c[i])}</b></span><span class="${changePct >= 0 ? 'csl-up' : 'csl-down'}">${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%</span>`;
    }

    const up = c[i] >= o[i];
    const changePct = i > 0 ? ((c[i] - c[i - 1]) / c[i - 1]) * 100 : 0;
    tooltip.innerHTML = `
      <div class="ch-date">${esc(t[i] || '')}</div>
      <div class="ch-row"><span>O</span><b>${niceFmt(o[i])}</b></div>
      <div class="ch-row"><span>H</span><b>${niceFmt(h[i])}</b></div>
      <div class="ch-row"><span>L</span><b>${niceFmt(l[i])}</b></div>
      <div class="ch-row"><span>C</span><b class="${up ? 'ch-up' : 'ch-down'}">${niceFmt(c[i])}</b></div>
      ${v[i] ? `<div class="ch-row"><span>Vol</span><b>${fmtVol(v[i])}</b></div>` : ''}
      <div class="ch-row"><span>Var</span><b class="${changePct >= 0 ? 'ch-up' : 'ch-down'}">${changePct >= 0 ? '+' : ''}${changePct.toFixed(2)}%</b></div>`;
    tooltip.style.display = 'block';
    const leftPct = (xc / W) * 100;
    tooltip.style.left = leftPct > 65 ? 'auto' : `calc(${leftPct}% + 10px)`;
    tooltip.style.right = leftPct > 65 ? `calc(${100 - leftPct}% + 10px)` : 'auto';
    tooltip.style.top = '30px';
  };
  const onLeave = () => {
    vLine.setAttribute('opacity', '0');
    hLine && hLine.setAttribute('opacity', '0');
    yTag && yTag.setAttribute('opacity', '0');
    xTag && xTag.setAttribute('opacity', '0');
    tooltip.style.display = 'none';
    if (statusLine && defaultStatus) statusLine.innerHTML = defaultStatus;
  };
  svg.addEventListener('mousemove', onMove);
  svg.addEventListener('mouseleave', onLeave);
}

function esc(s) { return String(s ?? '').replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch])); }

/** Comparador: superpone el retorno % (no el precio absoluto, que no es
 *  comparable entre tickers de escalas distintas) de hasta 3 activos sobre
 *  la misma ventana de velas diarias reales, alineados por índice (no por
 *  fecha calendario exacta — simplificación razonable ya que son todas
 *  velas diarias recientes del mismo proveedor). */
const COMPARE_COLORS = ['oklch(0.72 0.19 291)', 'oklch(0.78 0.15 70)', 'oklch(0.72 0.17 152)'];
export function renderCompareOverlaySVG(seriesList, windowSize = 130) {
  const trimmed = seriesList.filter(s => s.closes?.length >= 2);
  if (trimmed.length < 2) return '<div class="chart-empty">Se necesitan al menos 2 activos con historial para comparar.</div>';

  const count = Math.min(windowSize, ...trimmed.map(s => s.closes.length));
  const aligned = trimmed.map(s => ({
    ticker: s.ticker,
    closes: s.closes.slice(s.closes.length - count),
    dates: (s.dates || []).slice((s.dates || []).length - count),
  }));
  const pctSeries = aligned.map(s => { const base = s.closes[0]; return s.closes.map(v => ((v - base) / base) * 100); });

  const padL = 6, padR = 150, top = 14, bottom = 244, dateY = 268;
  const plotW = W - padL - padR;
  const x = (i) => padL + (count > 1 ? (plotW * i) / (count - 1) : plotW / 2);

  const allVals = pctSeries.flat().concat([0]);
  let vMin = Math.min(...allVals), vMax = Math.max(...allVals);
  const vPad = (vMax - vMin) * 0.1 || 1;
  vMin -= vPad; vMax += vPad;
  const y = (val) => scaleY(val, vMin, vMax, top, bottom);

  let gridSvg = '';
  for (let i = 0; i <= 4; i++) {
    const val = vMin + ((vMax - vMin) * i) / 4;
    const yy = y(val).toFixed(1);
    gridSvg += `<line x1="${padL}" y1="${yy}" x2="${W - padR}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    gridSvg += `<text x="${W - padR + 6}" y="${yy}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${val >= 0 ? '+' : ''}${val.toFixed(0)}%</text>`;
  }
  const zeroY = y(0).toFixed(1);
  gridSvg += `<line x1="${padL}" y1="${zeroY}" x2="${W - padR}" y2="${zeroY}" stroke="${AXIS_TEXT}" stroke-width="1.2" stroke-dasharray="3 3"/>`;

  let linesSvg = '';
  const pills = pctSeries.map((series, idx) => {
    const color = COMPARE_COLORS[idx % COMPARE_COLORS.length];
    linesSvg += polyline(series, x, y, color, 0.95, 2.2);
    const lastVal = series[series.length - 1];
    return { color, yy: y(lastVal), label: `${aligned[idx].ticker} ${lastVal >= 0 ? '+' : ''}${lastVal.toFixed(1)}%` };
  });
  // Evita que dos series con retorno final parecido dibujen sus etiquetas
  // superpuestas: separa verticalmente las que quedan a menos de 20px.
  pills.sort((a, b) => a.yy - b.yy);
  for (let i = 1; i < pills.length; i++) {
    if (pills[i].yy - pills[i - 1].yy < 20) pills[i].yy = pills[i - 1].yy + 20;
  }
  let labelsSvg = '';
  for (const { color, yy, label } of pills) {
    const lw = label.length * 6.3 + 12;
    labelsSvg += `<rect x="${(W - padR + 6).toFixed(1)}" y="${(yy - 9).toFixed(1)}" width="${lw.toFixed(1)}" height="18" rx="3" fill="${color}"/>
      <text x="${(W - padR + 12).toFixed(1)}" y="${yy.toFixed(1)}" fill="oklch(0.16 0.02 260)" font-size="10.5" font-weight="700" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${esc(label)}</text>`;
  }

  let dateSvg = '';
  const refDates = aligned[0].dates;
  if (refDates.length === count) {
    for (let k = 0; k <= 4; k++) {
      const i = Math.min(count - 1, Math.round((k * (count - 1)) / 4));
      dateSvg += `<text x="${x(i).toFixed(1)}" y="${dateY}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${(refDates[i] || '').slice(5)}</text>`;
    }
  }

  return `
    <svg viewBox="0 0 ${W} ${dateY + 10}" width="100%" height="${dateY + 10}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Comparación de retorno porcentual">
      ${gridSvg}
      ${linesSvg}
      ${labelsSvg}
      ${dateSvg}
    </svg>`;
}

/** Radar/spider chart SVG puro: compara los sub-scores del activo (0-100
 *  por eje) contra el promedio real de sus pares del mismo sector. Ejes con
 *  valor no disponible (fundamentales sin cobertura, etc.) se dibujan en el
 *  centro (0) en vez de inventarse — el label lo aclara aparte. */
const RADAR_ACCENT = 'oklch(0.70 0.19 291)', RADAR_PEER = 'oklch(0.58 0.018 260)';
export function renderRadarSVG(labels, assetValues, peerValues) {
  const n = labels.length;
  if (n < 3) return '<div class="chart-empty">Ejes insuficientes para el radar.</div>';
  const size = 300, cx = size / 2, cy = size / 2 - 6, maxR = 92;
  const angleFor = (i) => -Math.PI / 2 + i * (2 * Math.PI / n);
  const pointFor = (i, val) => {
    const r = (Math.max(0, Math.min(100, val ?? 0)) / 100) * maxR;
    const a = angleFor(i);
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)];
  };
  const polygon = (values, color, fillOpacity) => {
    const pts = values.map((v, i) => pointFor(i, v).map(n => n.toFixed(1)).join(',')).join(' ');
    return `<polygon points="${pts}" fill="${color}" fill-opacity="${fillOpacity}" stroke="${color}" stroke-width="1.8"/>`;
  };
  const vertexDots = (values, color) => values.map((v, i) => {
    const [px, py] = pointFor(i, v ?? 0);
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="3" fill="${color}"/>`;
  }).join('');

  let gridSvg = '';
  for (const frac of [0.25, 0.5, 0.75, 1]) {
    const pts = labels.map((_, i) => {
      const a = angleFor(i);
      return [cx + frac * maxR * Math.cos(a), cy + frac * maxR * Math.sin(a)].map(n => n.toFixed(1)).join(',');
    }).join(' ');
    gridSvg += `<polygon points="${pts}" fill="none" stroke="${GRID}" stroke-width="1"/>`;
  }
  let axisSvg = '', labelSvg = '';
  labels.forEach((label, i) => {
    const [ex, ey] = pointFor(i, 100);
    axisSvg += `<line x1="${cx}" y1="${cy}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="${GRID}" stroke-width="1"/>`;
    const [lx, ly] = pointFor(i, 122);
    const anchor = Math.abs(lx - cx) < 4 ? 'middle' : lx > cx ? 'start' : 'end';
    labelSvg += `<text x="${lx.toFixed(1)}" y="${ly.toFixed(1)}" fill="${AXIS_TEXT}" font-size="11" font-family="IBM Plex Sans, sans-serif" text-anchor="${anchor}" dominant-baseline="middle">${label}</text>`;
  });

  const peerSvg = peerValues ? polygon(peerValues, RADAR_PEER, 0.12) : '';
  const assetSvg = polygon(assetValues, RADAR_ACCENT, 0.22) + vertexDots(assetValues, RADAR_ACCENT);
  const glowSvg = `<defs><radialGradient id="radarGlow" cx="50%" cy="50%" r="55%">
    <stop offset="0%" stop-color="${RADAR_ACCENT}" stop-opacity="0.16"/>
    <stop offset="100%" stop-color="${RADAR_ACCENT}" stop-opacity="0"/>
  </radialGradient></defs>
  <circle cx="${cx}" cy="${cy}" r="${maxR + 12}" fill="url(#radarGlow)"/>`;

  return `
    <svg viewBox="0 0 ${size} ${size - 10}" width="100%" height="260" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Radar comparativo vs sector">
      ${glowSvg}
      ${gridSvg}
      ${axisSvg}
      ${peerSvg}
      ${assetSvg}
      ${labelSvg}
    </svg>`;
}
