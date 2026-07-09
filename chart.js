/**
 * chart.js — Gráfico de precio en SVG puro (sin dependencias externas).
 * Vela por vela, con EMA20/EMA50 superpuestas y líneas de soporte/resistencia,
 * calculado sobre el mismo OHLCV real que usa indicators.js.
 */
import { ema } from './indicators.js';

const W = 960, H = 320;
const PAD_L = 6, PAD_R = 60, PAD_T = 14, PAD_B = 26;
const GREEN = 'oklch(0.62 0.15 150)', RED = 'oklch(0.60 0.16 25)';
const GOLD = 'oklch(0.72 0.11 85)', WHITE = 'oklch(0.85 0.012 80)';
const GRID = 'oklch(0.30 0.01 60)', AXIS_TEXT = 'oklch(0.55 0.01 70)';

function scaleY(value, min, max, top, bottom) {
  if (max === min) return (top + bottom) / 2;
  return bottom - ((value - min) / (max - min)) * (bottom - top);
}

function niceFmt(v) {
  return v >= 1000 ? v.toLocaleString('en-US', { maximumFractionDigits: 0 }) : v.toFixed(2);
}

export function renderPriceChartSVG(candles, { support, resistance } = {}, windowSize = 130) {
  const nTotal = candles.c.length;
  if (nTotal < 5) return '<div class="chart-empty">Historial insuficiente para graficar.</div>';

  const start = Math.max(0, nTotal - windowSize);
  const o = candles.o.slice(start), h = candles.h.slice(start), l = candles.l.slice(start), c = candles.c.slice(start);
  const t = (candles.t || []).slice(start);
  const count = c.length;

  const ema20 = ema(candles.c, 20).slice(start);
  const ema50 = ema(candles.c, 50).slice(start);

  let min = Math.min(...l), max = Math.max(...h);
  if (support != null && isFinite(support)) min = Math.min(min, support);
  if (resistance != null && isFinite(resistance)) max = Math.max(max, resistance);
  const pad = (max - min) * 0.08 || max * 0.02 || 1;
  min -= pad; max += pad;

  const top = PAD_T, bottom = H - PAD_B;
  const plotW = W - PAD_L - PAD_R;
  const slot = plotW / count;
  const candleW = Math.max(1.2, Math.min(8, slot * 0.62));

  const x = (i) => PAD_L + slot * i + slot / 2;
  const y = (v) => scaleY(v, min, max, top, bottom);

  let candlesSvg = '';
  for (let i = 0; i < count; i++) {
    const up = c[i] >= o[i];
    const color = up ? GREEN : RED;
    const xc = x(i);
    candlesSvg += `<line x1="${xc.toFixed(1)}" y1="${y(h[i]).toFixed(1)}" x2="${xc.toFixed(1)}" y2="${y(l[i]).toFixed(1)}" stroke="${color}" stroke-width="1"/>`;
    const yOpen = y(o[i]), yClose = y(c[i]);
    const rectY = Math.min(yOpen, yClose), rectH = Math.max(1, Math.abs(yOpen - yClose));
    candlesSvg += `<rect x="${(xc - candleW / 2).toFixed(1)}" y="${rectY.toFixed(1)}" width="${candleW.toFixed(1)}" height="${rectH.toFixed(1)}" fill="${color}"/>`;
  }

  function polyline(series, color) {
    let d = '', started = false;
    for (let i = 0; i < series.length; i++) {
      const v = series[i];
      if (v == null || isNaN(v)) continue;
      d += `${started ? 'L' : 'M'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
      started = true;
    }
    return d ? `<path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" opacity="0.9"/>` : '';
  }

  const emaSvg = polyline(ema20, GOLD) + polyline(ema50, WHITE);

  let refSvg = '';
  const refLine = (value, color, label) => {
    if (value == null || !isFinite(value)) return '';
    const yy = y(value).toFixed(1);
    return `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${color}" stroke-width="1" stroke-dasharray="4 4" opacity="0.7"/>
      <text x="${W - PAD_R + 6}" y="${yy}" fill="${color}" font-size="10" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${label}</text>`;
  };
  refSvg += refLine(resistance, RED, niceFmt(resistance));
  refSvg += refLine(support, GREEN, niceFmt(support));

  // grilla horizontal + labels de precio (4 niveles)
  let gridSvg = '';
  const levels = 4;
  for (let i = 0; i <= levels; i++) {
    const v = min + ((max - min) * i) / levels;
    const yy = y(v).toFixed(1);
    gridSvg += `<line x1="${PAD_L}" y1="${yy}" x2="${W - PAD_R}" y2="${yy}" stroke="${GRID}" stroke-width="1"/>`;
    gridSvg += `<text x="${W - PAD_R + 6}" y="${yy}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" dominant-baseline="middle">${niceFmt(v)}</text>`;
  }

  // labels de fecha (hasta 5, espaciadas)
  let dateSvg = '';
  if (t.length === count) {
    const ticks = 5;
    for (let k = 0; k <= ticks; k++) {
      const i = Math.min(count - 1, Math.round((k * (count - 1)) / ticks));
      dateSvg += `<text x="${x(i).toFixed(1)}" y="${H - 8}" fill="${AXIS_TEXT}" font-size="10" font-family="IBM Plex Mono, monospace" text-anchor="middle">${(t[i] || '').slice(5)}</text>`;
    }
  }

  return `
    <svg viewBox="0 0 ${W} ${H}" width="100%" height="${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="Gráfico de precio">
      ${gridSvg}
      ${refSvg}
      ${candlesSvg}
      ${emaSvg}
      ${dateSvg}
    </svg>
    <div class="chart-legend">
      <span><i style="background:${GREEN};"></i>Alcista</span>
      <span><i style="background:${RED};"></i>Bajista</span>
      <span><i style="background:${GOLD};"></i>EMA 20</span>
      <span><i style="background:${WHITE};"></i>EMA 50</span>
      <span><i style="background:${RED}; opacity:0.7;"></i>Resistencia</span>
      <span><i style="background:${GREEN}; opacity:0.7;"></i>Soporte</span>
    </div>`;
}
