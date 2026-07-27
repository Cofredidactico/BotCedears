/* Utilidades puras de formato y números, extraídas de app.js como primer paso
 * para de-monolitizar. Sin estado ni DOM: fáciles de testear y reutilizar.
 * El frontend las importa como ES module (igual que scoring/indicators). */

export const fmtUsd = (n) => n == null || isNaN(n) ? 'N/D' : (Math.abs(n) >= 1000 ? `US$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${n.toFixed(2)}`);
export const fmtArs = (n) => n == null || isNaN(n) ? 'N/D' : `AR$${Math.round(n).toLocaleString('es-AR')}`;
export const fmtPct = (n, digits = 1) => n == null || isNaN(n) ? 'N/D' : `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
export const fmtNum = (n, digits = 2) => n == null || isNaN(n) ? 'N/D' : n.toFixed(digits);
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Inserta un canal alpha en un oklch(...) sin parsear componentes — solo
// para glows/sombras decorativas sobre colores ya definidos en el código.
export const withAlpha = (oklchStr, alpha) => oklchStr.replace(/\)\s*$/, ` / ${alpha})`);

export function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
