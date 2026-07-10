/**
 * chart.js — Gráfico de precio en SVG puro (sin dependencias externas).
 * Panel de precio (velas + EMA20/50 + Bandas de Bollinger + soporte/
 * resistencia) con paneles de Volumen y RSI debajo, todo sobre el mismo
 * OHLCV real que usa indicators.js — nada se simula acá.
 */
import { ema, bollinger, rsi } from './indicators.js';

const W = 960;
const PAD_L = 6, PAD_R = 60;
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

const GREEN = 'oklch(0.62 0.15 150)', RED = 'oklch(0.60 0.16 25)';
const GOLD = 'oklch(0.72 0.11 85)', WHITE = 'oklch(0.85 0.012 80)';
const BLUE = 'oklch(0.68 0.12 250)';
const GRID = 'oklch(0.30 0.01 60)', AXIS_TEXT = 'oklch(0.55 0.01 70)', PANEL_LABEL = 'oklch(0.60 0.01 70)';

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

export function renderPriceChartSVG(candles, { support, resistance } = {}, windowSize = 130) {
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
  const pPad = (pMax - pMin) * 0.08 || pMax * 0.02 || 1;
  pMin -= pPad; pMax += pPad;
  const yPrice = (val) => scaleY(val, pMin, pMax, PRICE_TOP, PRICE_BOTTOM);

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

  let refSvg = '';
  const refLine = (value, color, label) => {
    if (value == null || !isFinite(value)) return '';
    const yy = yPrice(value).toFixed(1);
    return `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${color}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>
      <text x="${W - PAD_R + 6}" y="${yy}" fill="${color}" font-size="10" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${label}</text>`;
  };
  refSvg += refLine(resistance, RED, niceFmt(resistance));
  refSvg += refLine(support, GREEN, niceFmt(support));

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
      ${refSvg}
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
      <span><i style="background:${RED}; opacity:0.7;"></i>Resistencia</span>
      <span><i style="background:${GREEN}; opacity:0.7;"></i>Soporte</span>
    </div>`;
}
