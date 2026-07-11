/**
 * chart.js — Gráfico de precio en SVG puro (sin dependencias externas).
 * Panel de precio (velas + EMA20/50 + Bandas de Bollinger + soporte/
 * resistencia + zonas de compra/venta del plan operativo) con paneles de
 * Volumen y RSI debajo, todo sobre el mismo OHLCV real que usa
 * indicators.js — nada se simula acá.
 */
import { ema, bollinger, rsi } from './indicators.js';

const W = 960;
const PAD_L = 6, PAD_R = 76;
const GAP = 16;
const PRICE_H = 240, VOL_H = 56, RSI_H = 80;
const DATE_H = 24;
const PRICE_TOP = 14;
const PRICE_BOTTOM = PRICE_TOP + PRICE_H;
const VOL_TOP = PRICE_BOTTOM + GAP;
const VOL_BOTTOM = VOL_TOP + VOL_H;
const RSI_TOP = VOL_BOTTOM + GAP;
const RSI_BOTTOM = RSI_TOP + RSI_H;
const H = RSI_BOTTOM + DATE_H;

const GREEN = 'oklch(0.72 0.17 152)', RED = 'oklch(0.68 0.19 23)';
const GOLD = 'oklch(0.80 0.15 85)', WHITE = 'oklch(0.90 0.012 260)';
const BLUE = 'oklch(0.78 0.13 199)';
const GRID = 'oklch(0.32 0.03 262)', AXIS_TEXT = 'oklch(0.58 0.018 260)', PANEL_LABEL = 'oklch(0.62 0.018 260)';
const BUY_ZONE_FILL = 'oklch(0.72 0.17 152 / 0.16)', BUY_ZONE_LINE = 'oklch(0.76 0.18 152 / 0.55)';
const SELL_ZONE_FILL = 'oklch(0.75 0.15 70 / 0.16)', SELL_ZONE_LINE = 'oklch(0.75 0.15 70 / 0.55)';
const STOP_COLOR = 'oklch(0.70 0.21 23)';
const TP_COLOR = 'oklch(0.80 0.15 85)';

function scaleY(value, min, max, top, bottom) {
  if (max === min) return (top + bottom) / 2;
  return bottom - ((value - min) / (max - min)) * (bottom - top);
}

function niceFmt(v) {
  return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2);
}

function polyline(series, x, y, color, opacity = 0.9) {
  let d = '', started = false;
  for (let i = 0; i < series.length; i++) {
    const v = series[i];
    if (v == null || isNaN(v)) continue;
    d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
    started = true;
  }
  return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" opacity="${opacity}"/>` : '';
}

export function renderPriceChartSVG(candles, { support, resistance, plan } = {}, windowSize = 130) {
  const nTotal = candles.c.length;
  if (nTotal < 5) return '<div class="chart-empty">Historial insuficiente para graficar.</div>';

  const start = Math.max(0, nTotal - windowSize);
  const o = candles.o.slice(start), h = candles.h.slice(start), l = candles.l.slice(start), c = candles.c.slice(start);
  const v = (candles.v || []).slice(start);
  const t = (candles.t || []).slice(start);
  const count = c.length;

  const ema20 = ema(candles.c, 20).slice(start);
  const ema50 = ema(candles.c, 50).slice(start);
  const bb = bollinger(candles.c, 20, 2);
  const bbUpper = bb.upper.slice(start), bbLower = bb.lower.slice(start);
  const rsiFull = rsi(candles.c, 14).slice(start);
  const hasVolume = v.some(x => x > 0);

  const plotW = W - PAD_L - PAD_R;
  const slot = plotW / count;
  const candleW = Math.max(1.2, Math.min(8, slot * 0.62));
  const x = (i) => PAD_L + slot * i + slot / 2;

  /* ── panel de precio ── */
  let pMin = Math.min(...l), pMax = Math.max(...h);
  const bbValsUpper = bbUpper.filter(x => !isNaN(x)), bbValsLower = bbLower.filter(x => !isNaN(x));
  if (bbValsUpper.length) pMax = Math.max(pMax, ...bbValsUpper);
  if (bbValsLower.length) pMin = Math.min(pMin, ...bbValsLower);
  if (support != null && isFinite(support)) pMin = Math.min(pMin, support);
  if (resistance != null && isFinite(resistance)) pMax = Math.max(pMax, resistance);
  if (plan) {
    if (isFinite(plan.buyLow)) pMin = Math.min(pMin, plan.buyLow);
    if (isFinite(plan.stopLoss)) pMin = Math.min(pMin, plan.stopLoss);
    if (isFinite(plan.tp1)) pMax = Math.max(pMax, plan.tp1);
    if (isFinite(plan.sellHigh)) pMax = Math.max(pMax, plan.sellHigh);
  }
  const pPad = (pMax - pMin) * 0.08 || pMax * 0.02 || 1;
  pMin -= pPad; pMax += pPad;
  const yPrice = (val) => scaleY(val, pMin, pMax, PRICE_TOP, PRICE_BOTTOM);

  /* ── zonas de compra/venta del plan operativo (señal visual del análisis) ── */
  let zonesSvg = '';
  const pillLabel = (xLeft, yCenter, label, bg, fg, anchor = 'start') => {
    const w = label.length * 6.3 + 12;
    const rectX = anchor === 'start' ? xLeft : xLeft - w;
    return `<rect x="${rectX.toFixed(1)}" y="${(yCenter - 8).toFixed(1)}" width="${w.toFixed(1)}" height="16" rx="3" fill="${bg}"/>
      <text x="${(anchor === 'start' ? xLeft + 5 : xLeft - 5).toFixed(1)}" y="${yCenter.toFixed(1)}" fill="${fg}" font-size="10" font-weight="700" font-family="IBM Plex Mono, monospace" letter-spacing="0.3" text-anchor="${anchor === 'start' ? 'start' : 'end'}" dominant-baseline="middle">${label}</text>`;
  };
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

  let candlesSvg = '';
  for (let i = 0; i < count; i++) {
    const up = c[i] >= o[i];
    const color = up ? GREEN : RED;
    const xc = x(i);
    candlesSvg += `<line x1="${xc.toFixed(1)}" y1="${yPrice(h[i]).toFixed(1)}" x2="${xc.toFixed(1)}" y2="${yPrice(l[i]).toFixed(1)}" stroke="${color}" stroke-width="1"/>`;
    const yOpen = yPrice(o[i]), yClose = yPrice(c[i]);
    const rectY = Math.min(yOpen, yClose), rectH = Math.max(1, Math.abs(yOpen - yClose));
    candlesSvg += `<rect x="${(xc - candleW / 2).toFixed(1)}" y="${rectY.toFixed(1)}" width="${candleW.toFixed(1)}" height="${rectH.toFixed(1)}" fill="${color}"/>`;
  }

  const bbSvg = polyline(bbUpper, x, yPrice, BLUE, 0.55) + polyline(bbLower, x, yPrice, BLUE, 0.55);
  const emaSvg = polyline(ema20, x, yPrice, GOLD) + polyline(ema50, x, yPrice, WHITE);

  // Soporte/resistencia ya no se dibujan como líneas propias: la zona de
  // compra/venta del plan operativo (abajo) se construye a partir de ellos
  // y muestra la misma información de forma más accionable, sin duplicar
  // etiquetas superpuestas en el margen derecho.

  let priceGridSvg = '';
  for (let i = 0; i <= 4; i++) {
    const val = pMin + ((pMax - pMin) * i) / 4;
    const yy = yPrice(val).toFixed(1);
    priceGridSvg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    priceGridSvg += `<text x="${W - PAD_R + 6}" y="${yy}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${niceFmt(val)}</text>`;
  }

  /* ── panel de volumen ── */
  let volSvg = `<text x="${PAD_L}" y="${VOL_TOP - 4}" fill="${PANEL_LABEL}" font-size="10" font-family="IBM Plex Mono, monospace">VOLUMEN</text>`;
  if (hasVolume) {
    const vMax = Math.max(...v) || 1;
    for (let i = 0; i < count; i++) {
      const up = c[i] >= o[i];
      const barH = (v[i] / vMax) * (VOL_H - 4);
      const xc = x(i);
      volSvg += `<rect x="${(xc - candleW / 2).toFixed(1)}" y="${(VOL_BOTTOM - barH).toFixed(1)}" width="${candleW.toFixed(1)}" height="${barH.toFixed(1)}" fill="${up ? GREEN : RED}" opacity="0.6"/>`;
    }
  } else {
    volSvg += `<text x="${PAD_L}" y="${(VOL_TOP + VOL_BOTTOM) / 2}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace">Sin datos de volumen para este activo/timeframe</text>`;
  }

  /* ── panel de RSI ── */
  const yRsi = (val) => scaleY(val, 0, 100, RSI_TOP, RSI_BOTTOM);
  let rsiSvg = `<text x="${PAD_L}" y="${RSI_TOP - 4}" fill="${PANEL_LABEL}" font-size="10" font-family="IBM Plex Mono, monospace">RSI (14)</text>`;
  for (const level of [30, 50, 70]) {
    const yy = yRsi(level).toFixed(1);
    rsiSvg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${GRID}" stroke-width="1" stroke-dasharray="${level === 50 ? '2 3' : '0'}"/>`;
    rsiSvg += `<text x="${W - PAD_R + 6}" y="${yy}" fill="${AXIS_TEXT}" font-size="9" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${level}</text>`;
  }
  rsiSvg += polyline(rsiFull, x, yRsi, GOLD, 1);

  /* ── fechas (eje compartido, debajo del panel de RSI) ── */
  let dateSvg = '';
  if (t.length === count) {
    const ticks = 5;
    for (let k = 0; k <= ticks; k++) {
      const i = Math.min(count - 1, Math.round((k * (count - 1)) / ticks));
      dateSvg += `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${(t[i] || '').slice(5)}</text>`;
    }
  }

  const sepSvg = `<line x1="${PAD_L}" y1="${PRICE_BOTTOM + GAP / 2}" x2="${W - PAD_R}" y2="${PRICE_BOTTOM + GAP / 2}" stroke="${GRID}" stroke-width="1"/>
    <line x1="${PAD_L}" y1="${VOL_BOTTOM + GAP / 2}" x2="${W - PAD_R}" y2="${VOL_BOTTOM + GAP / 2}" stroke="${GRID}" stroke-width="1"/>`;

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gráfico de precio con volumen y RSI">
      ${priceGridSvg}
      ${zonesSvg}
      ${bbSvg}
      ${candlesSvg}
      ${emaSvg}
      ${sepSvg}
      ${volSvg}
      ${rsiSvg}
      ${dateSvg}
    </svg>
    <div class="chart-legend">
      <span><i style="background:${GREEN};"></i>Alcista</span>
      <span><i style="background:${RED};"></i>Bajista</span>
      <span><i style="background:${GOLD};"></i>EMA 20 / RSI</span>
      <span><i style="background:${WHITE};"></i>EMA 50</span>
      <span><i style="background:${BLUE};"></i>Bollinger</span>
      ${plan ? `
      <span><i style="background:${GREEN}; opacity:0.35;"></i>Zona de compra</span>
      <span><i style="background:${GOLD}; opacity:0.35;"></i>Zona de venta</span>
      <span><i style="background:${STOP_COLOR};"></i>Stop loss</span>
      <span><i style="background:${TP_COLOR};"></i>Take profit 1</span>` : ''}
    </div>`;
}
