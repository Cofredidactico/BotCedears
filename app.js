import { getUniverse, getAsset, getQuote, getCandles, getFundamentals, getNews, getGeneralNews, getMacro, getCCL, getEarnings } from './dataSource.js';
import { computeTechnical, resampleWeekly, weeklyConfluence, correlationAndBeta } from './indicators.js';
import { computeScore, computePlan, SECTOR_PE_RANGE, detectPriceAlert } from './scoring.js';
import { renderPriceChartSVG, renderRadarSVG, wireChartHover, renderCompareOverlaySVG } from './chart.js';
import { getWatchlist, isWatched, toggleWatchlist, WATCHLIST_MAX } from './watchlist.js';
import { getPortfolio, addHolding, removeHolding, PORTFOLIO_MAX } from './portfolio.js';

const GREEN = 'oklch(0.76 0.18 152)', AMBER = 'oklch(0.75 0.15 70)', RED = 'oklch(0.70 0.21 23)';

const els = {
  datebadge: document.getElementById('datebadge'),
  connbanner: document.getElementById('connbanner'),
  searchinput: document.getElementById('searchinput'),
  tickerchip: document.getElementById('tickerchip'),
  dropdown: document.getElementById('dropdown'),
  report: document.getElementById('report'),
  sidebarNav: document.getElementById('sidebar-nav'),
  sidebarMarket: document.getElementById('sidebar-market'),
  toastContainer: document.getElementById('toast-container'),
};

/* ───────────────────────── toasts (feedback de acciones) ───────────────────────── */
const TOAST_ICON = { success: '✓', info: 'ℹ', error: '✕' };
function showToast(message, type = 'success', durationMs = 3200) {
  if (!els.toastContainer) return;
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span class="toast-icon">${TOAST_ICON[type] ?? TOAST_ICON.success}</span><span class="toast-msg"></span>`;
  el.querySelector('.toast-msg').textContent = message; // textContent, no esc(): evita doble-escapado en innerHTML ya armado
  els.toastContainer.appendChild(el);
  requestAnimationFrame(() => el.classList.add('show'));
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 280);
  }, durationMs);
}

// view: 'dashboard' | 'portfolio' | 'watchlist' | 'macro' | 'alerts' — páginas
// reales, todas con datos en vivo. Se muestran cuando no hay un activo
// puntual seleccionado (state.asset null); si hay un activo, se ve su ficha.
const state = { query: '', asset: null, report: null, loading: false, error: null, view: 'dashboard' };
function lsGetSafe(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }

/* ───────────────────────── dashboard / radar ───────────────────────── */
// Universo curado (no todo universe.json): rankear ~230 tickers en vivo
// pegaría contra el límite de Twelve Data (free tier, ~8 req/min) en cada
// visita. Se eligió un subconjunto líquido y representativo de categorías
// (tech US, bancos/energía AR, ETFs, cripto) — ampliar cuando haya más
// margen de API (key paga o un snapshot server-side con cron). Se carga en
// lotes (ver loadDashboardData) para no disparar más pedidos concurrentes
// de los que el free tier de Twelve Data tolera de golpe.
const DASHBOARD_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'AMD', 'TSM',
  'JPM', 'V', 'MA', 'XOM', 'KO', 'NFLX', 'CAT',
  'MELI', 'GGAL', 'BMA', 'YPF', 'PAM', 'CEPU', 'TGS', 'SUPV', 'IRS', 'CRESY', 'LOMA', 'EDN',
  'SPY', 'QQQ', 'GLD',
  'BTC', 'ETH',
];
const dashState = { data: {}, loading: new Set(), started: false };
// Subconjunto del universo del dashboard para el widget "Mercado Hoy" del
// sidebar — reusa dashState.data, no dispara requests propios.
const SIDEBAR_MARKET_TICKERS = ['SPY', 'QQQ', 'MELI', 'GGAL', 'BTC'];

/* ───────────────────────── portfolio advisor ───────────────────────── */
const portState = { data: {}, loading: new Set(), sortBy: lsGetSafe('icp_port_sort', 'weight'), editing: null };
function lsSetSafe(key, value) { try { localStorage.setItem(key, value); } catch { /* no disponible */ } }

const watchState = {
  data: {}, loading: new Set(),
  sortBy: lsGetSafe('icp_watch_sort', 'score'),
  filterSignal: lsGetSafe('icp_watch_filter', 'all'),
}; // ticker -> { price, changePct, score, scoreLabel, isReal, ts }

const SORT_OPTIONS = [
  { key: 'score', label: 'Score (mayor a menor)' },
  { key: 'price', label: 'Precio (mayor a menor)' },
  { key: 'change', label: 'Variación % (mayor a menor)' },
  { key: 'ticker', label: 'Ticker (A-Z)' },
];
const SIGNAL_FILTERS = ['all', 'Compra Fuerte', 'Compra Moderada', 'Mantener', 'Reducir', 'Venta'];

const PORT_SORT_OPTIONS = [
  { key: 'weight', label: 'Peso en cartera (mayor a menor)' },
  { key: 'value', label: 'Valor de mercado (mayor a menor)' },
  { key: 'gainPct', label: 'P&L % (mayor a menor)' },
  { key: 'score', label: 'Score (mayor a menor)' },
  { key: 'ticker', label: 'Ticker (A-Z)' },
];

/* ───────────────────────── alertas de precio ───────────────────────── */
const ALERT_META = {
  buy: { label: 'En zona de compra', color: GREEN },
  sell: { label: 'En zona de venta', color: AMBER },
  stop: { label: 'Tocó el stop loss', color: RED },
};
let alertsEnabled = lsGetSafe('icp_alerts_enabled', '0') === '1';
const lastAlertByTicker = {}; // ticker -> 'buy'|'sell'|'stop'|null, para notificar solo en la transición

/* ───────────────────────── configuración (preferencias reales) ───────────────────────── */
// Reglas de tamaño máximo de posición por perfil de riesgo — determinísticas,
// no una recomendación de IA: afectan directamente el texto de recomendación
// del Portfolio Advisor comparando contra el peso real que ya tiene cada
// holding en la cartera cargada.
const RISK_PROFILES = {
  conservador: { label: 'Conservador', maxPositionPct: 8 },
  moderado: { label: 'Moderado', maxPositionPct: 15 },
  agresivo: { label: 'Agresivo', maxPositionPct: 25 },
};
const settingsState = {
  defaultCurrency: lsGetSafe('icp_default_currency', 'USD'), // 'USD' | 'ARS' — moneda que lidera el precio grande de la ficha
  riskProfile: lsGetSafe('icp_risk_profile', 'moderado'), // afecta el tope de posición sugerido en Portfolio Advisor
};

function notifyIfNewAlert(ticker, priceAlert) {
  const prev = lastAlertByTicker[ticker] ?? null;
  const curr = priceAlert?.type ?? null;
  lastAlertByTicker[ticker] = curr;
  if (!alertsEnabled || !curr || curr === prev) return;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const meta = ALERT_META[curr];
  new Notification(`${ticker}: ${meta.label}`, { body: 'Investment Copilot AI — seguimiento de precio', tag: `icp-${ticker}` });
}

async function toggleAlerts() {
  if (!alertsEnabled) {
    if (typeof Notification === 'undefined') { alert('Este navegador no soporta notificaciones.'); return; }
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') return;
  }
  alertsEnabled = !alertsEnabled;
  lsSetSafe('icp_alerts_enabled', alertsEnabled ? '1' : '0');
  showToast(alertsEnabled ? 'Notificaciones de alertas activadas' : 'Notificaciones de alertas desactivadas', 'info');
  refreshIfWatchlistVisible();
}

const CHART_TABS = [
  { key: '45min', label: '45m' },
  { key: '4h', label: '4H' },
  { key: '1day', label: '1D' },
  { key: '1week', label: '1S' },
];
const chartState = { tf: '1day', cache: {}, loading: new Set(), mode: 'institucional' }; // mode: 'institucional' | 'libre'
function chartTabsForAsset(asset) {
  return asset?.category === 'Cripto' ? CHART_TABS.filter(t => t.key === '1day' || t.key === '1week') : CHART_TABS;
}

/** Análisis Libre: widget gratuito de TradingView embebido (tv.js), como
 *  complemento del gráfico propio — no lo reemplaza, porque TradingView usa
 *  su propio símbolo/datos (no el precio de CEDEAR en pesos que calculamos
 *  acá). Da acceso a todos sus indicadores y herramientas de dibujo para
 *  quien quiera hacer su propio análisis técnico libre sobre el mismo activo. */
const TV_SYMBOL_OVERRIDE = { BTC: 'COINBASE:BTCUSD', ETH: 'COINBASE:ETHUSD' };
function tvSymbolFor(asset) {
  return TV_SYMBOL_OVERRIDE[asset.ticker] ?? asset.ticker; // TradingView resuelve tickers US sueltos (NASDAQ/NYSE/AMEX) automáticamente
}

let tvScriptPromise = null;
function loadTradingViewScript() {
  if (window.TradingView) return Promise.resolve();
  if (tvScriptPromise) return tvScriptPromise;
  tvScriptPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.onload = resolve;
    script.onerror = () => { tvScriptPromise = null; reject(new Error('No se pudo cargar el widget de TradingView (sin conexión o bloqueado por el navegador).')); };
    document.head.appendChild(script);
  });
  return tvScriptPromise;
}

async function mountTradingViewWidget(containerId, symbol) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = `<div class="tv-loading">Cargando TradingView…</div>`;
  // Si el script queda "colgado" (bloqueador de contenido, firewall corporativo,
  // etc. que ni cargan ni disparan onerror) hay que igual sacar al usuario del
  // spinner infinito con un mensaje accionable, en vez de dejarlo cargando para siempre.
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('Tardó demasiado en cargar — puede estar bloqueado por un adblocker o firewall. Desactivalo para este sitio y volvé a intentar.')), 12000));
  try {
    await Promise.race([loadTradingViewScript(), timeout]);
    if (!document.getElementById(containerId)) return; // el usuario ya navegó a otra vista
    el.innerHTML = '';
    new window.TradingView.widget({
      container_id: containerId,
      autosize: true,
      symbol,
      interval: 'D',
      timezone: 'America/Argentina/Buenos_Aires',
      theme: 'dark',
      style: '1',
      locale: 'es',
      toolbar_bg: '#12141c',
      enable_publishing: false,
      allow_symbol_change: true,
      hide_side_toolbar: false,
      studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies'],
    });
  } catch (e) {
    if (document.getElementById(containerId)) el.innerHTML = `<div class="chart-empty">${esc(e.message)}</div>`;
  }
}

function chartCardBody(dailyTechnical, plan) {
  const tf = chartState.tf;
  const entry = chartState.cache[tf];
  if (chartState.loading.has(tf) && !entry) return `<div class="skel skel-chart"></div>`;
  if (!entry) return `<div class="chart-empty">Sin datos para este timeframe todavía.</div>`;
  const svg = renderPriceChartSVG(entry.candles, { support: dailyTechnical.support, resistance: dailyTechnical.resistance, plan: plan?.raw });
  const staleNote = entry.isReal === false ? `<div class="chart-stale">Datos de demostración — sin conexión al proveedor para este timeframe.</div>` : '';
  return svg + staleNote;
}

async function loadChartTf(tf) {
  if (!state.asset) return;
  chartState.tf = tf;
  if (chartState.cache[tf]) { renderReport(); return; }
  chartState.loading.add(tf);
  renderReport();
  try {
    const ticker = state.asset.ticker;
    const isCripto = state.asset.category === 'Cripto';
    let candles, isReal;
    if (isCripto) {
      // CoinGecko free tier no da granularidad custom — se reusa lo ya cargado.
      const base = chartState.cache['1day']?.candles ?? state.report?.candles;
      candles = tf === '1week' ? resampleWeekly(base) : base;
      isReal = chartState.cache['1day']?.isReal ?? false;
    } else {
      const n = tf === '1week' ? 130 : tf === '4h' ? 240 : tf === '45min' ? 220 : 220;
      const res = await getCandles(ticker, tf, n);
      candles = res; isReal = res.isReal;
    }
    chartState.cache[tf] = { candles, isReal };
  } catch (e) {
    console.warn('[chart] no se pudo cargar', tf, e.message);
  } finally {
    chartState.loading.delete(tf);
    renderReport();
  }
}

/* ───────────────────────── utilidades ───────────────────────── */
const fmtUsd = (n) => n == null || isNaN(n) ? 'N/D' : (Math.abs(n) >= 1000 ? `US$${n.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : `$${n.toFixed(2)}`);
const fmtArs = (n) => n == null || isNaN(n) ? 'N/D' : `AR$${Math.round(n).toLocaleString('es-AR')}`;
const fmtPct = (n, digits = 1) => n == null || isNaN(n) ? 'N/D' : `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
const fmtNum = (n, digits = 2) => n == null || isNaN(n) ? 'N/D' : n.toFixed(digits);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// Inserta un canal alpha en un oklch(...) sin parsear componentes — solo
// para glows/sombras decorativas sobre colores ya definidos en el código.
const withAlpha = (oklchStr, alpha) => oklchStr.replace(/\)\s*$/, ` / ${alpha})`);

/* ───────────────────────── iconografía (SVG inline, sin dependencias) ───────────────────────── */
const ICON_ATTR = 'class="sec-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"';
const ICONS = {
  chart: `<svg ${ICON_ATTR}><polyline points="3,17 9,10 13,14 21,5"/><circle cx="21" cy="5" r="1.4" fill="currentColor" stroke="none"/></svg>`,
  briefcase: `<svg ${ICON_ATTR}><rect x="3" y="7" width="18" height="13" rx="2"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><line x1="3" y1="12" x2="21" y2="12"/></svg>`,
  warning: `<svg ${ICON_ATTR}><path d="M12 3.5 21.5 20h-19z"/><line x1="12" y1="9.5" x2="12" y2="14"/><circle cx="12" cy="17" r="0.8" fill="currentColor" stroke="none"/></svg>`,
  bulb: `<svg ${ICON_ATTR}><path d="M9 18h6"/><path d="M10 21h4"/><path d="M12 3a6 6 0 0 0-3.5 10.9c.5.4.8 1 .8 1.6V16h5.4v-.5c0-.6.3-1.2.8-1.6A6 6 0 0 0 12 3Z"/></svg>`,
  target: `<svg ${ICON_ATTR}><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4.8"/><circle cx="12" cy="12" r="1.1" fill="currentColor" stroke="none"/></svg>`,
  check: `<svg ${ICON_ATTR}><circle cx="12" cy="12" r="8.5"/><polyline points="8,12.5 11,15.5 16,9"/></svg>`,
  grid: `<svg ${ICON_ATTR}><rect x="3" y="3" width="7.5" height="7.5" rx="1.2"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.2"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.2"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.2"/></svg>`,
  trend: `<svg ${ICON_ATTR}><polyline points="3,16 10,9 14,13 21,5"/><polyline points="15,5 21,5 21,11"/></svg>`,
  radar: `<svg ${ICON_ATTR}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5.2"/><circle cx="12" cy="12" r="1.2" fill="currentColor" stroke="none"/><line x1="12" y1="12" x2="18" y2="6.5"/></svg>`,
  bookmark: `<svg ${ICON_ATTR}><path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z"/></svg>`,
  globe: `<svg ${ICON_ATTR}><circle cx="12" cy="12" r="8.5"/><ellipse cx="12" cy="12" rx="3.6" ry="8.5"/><line x1="3.5" y1="12" x2="20.5" y2="12"/></svg>`,
  news: `<svg ${ICON_ATTR}><rect x="3.5" y="4.5" width="17" height="15" rx="1.5"/><line x1="7" y1="8.5" x2="17" y2="8.5"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="15.5" x2="13" y2="15.5"/></svg>`,
  building: `<svg ${ICON_ATTR}><rect x="5" y="3.5" width="10" height="17" rx="1"/><rect x="15" y="9" width="4.5" height="11.5" rx="1"/><line x1="8" y1="7.5" x2="8" y2="7.5"/><line x1="8" y1="11" x2="8" y2="11"/><line x1="12" y1="7.5" x2="12" y2="7.5"/><line x1="12" y1="11" x2="12" y2="11"/><line x1="8" y1="14.5" x2="8" y2="14.5"/><line x1="12" y1="14.5" x2="12" y2="14.5"/></svg>`,
  calendar: `<svg ${ICON_ATTR}><rect x="3.5" y="5" width="17" height="16" rx="2"/><line x1="3.5" y1="9.5" x2="20.5" y2="9.5"/><line x1="8" y1="3" x2="8" y2="7"/><line x1="16" y1="3" x2="16" y2="7"/></svg>`,
  compare: `<svg ${ICON_ATTR}><path d="M7 4v14"/><path d="M3 8h4l-2 4Z"/><path d="M17 4v14"/><path d="M21 12h-4l2 4Z"/></svg>`,
  gear: `<svg ${ICON_ATTR}><circle cx="12" cy="12" r="3.2"/><path d="M12 3.5v2.2M12 18.3v2.2M20.5 12h-2.2M5.7 12H3.5M17.8 6.2l-1.6 1.6M7.8 16.2l-1.6 1.6M17.8 17.8l-1.6-1.6M7.8 7.8 6.2 6.2"/></svg>`,
  filter: `<svg ${ICON_ATTR}><path d="M3.5 4.5h17l-6.2 8v6.5l-4.6 2v-8.5Z"/></svg>`,
};
function sectionTitleHTML(text, iconKey, style = '') {
  return `<div class="sectiontitle" ${style ? `style="${style}"` : ''}>${ICONS[iconKey] ?? ''}<span>${esc(text)}</span></div>`;
}

/** Estado vacío con ícono — mismo mensaje real que antes, con más peso
 *  visual que un párrafo suelto para la primera impresión de cada página. */
function emptyStateHTML(iconKey, text) {
  return `<div class="card empty-state">
    <div class="empty-state-icon">${ICONS[iconKey] ?? ''}</div>
    <div class="empty-state-text">${text}</div>
  </div>`;
}

function relativeTime(ts) {
  if (!ts) return 'sin datos';
  const diffMs = Date.now() - ts;
  const s = Math.floor(diffMs / 1000);
  if (s < 60) return `hace ${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `hace ${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `hace ${h}h`;
  const d = Math.floor(h / 24);
  return `hace ${d}d`;
}

function freshnessFor(ts, isReal, { staleAfterMs = 15 * 60 * 1000 } = {}) {
  if (!isReal) return { text: 'Sin conexión — mostrando último valor', color: RED };
  if (!ts) return { text: 'Sin datos', color: RED };
  const age = Date.now() - ts;
  if (age > staleAfterMs) return { text: `Desactualizado (${relativeTime(ts)})`, color: AMBER };
  return { text: `Actualizado ${relativeTime(ts)}`, color: GREEN };
}

/* ───────────────────────── topbar ───────────────────────── */
function renderTopbar() {
  els.datebadge.textContent = new Date().toLocaleDateString('es-AR', { year: 'numeric', month: 'long', day: 'numeric' });

  const r = state.report;
  let conn;
  if (!r) conn = { text: 'Dashboard — buscá un activo para el informe completo', color: AMBER, border: 'oklch(0.42 0.08 70)' };
  else if (r.quote.isReal && r.candles.isReal) conn = { text: 'Conectado a fuente de datos en vivo', color: GREEN, border: 'oklch(0.45 0.10 152)' };
  else if (r.quote.isReal || r.candles.isReal) conn = { text: 'Datos parcialmente en vivo — alguna fuente cayó a caché', color: AMBER, border: 'oklch(0.42 0.08 70)' };
  else conn = { text: 'Sin conexión al proveedor de datos — mostrando último valor disponible', color: RED, border: 'oklch(0.45 0.12 23)' };

  els.connbanner.style.color = conn.color;
  els.connbanner.style.border = `1px solid ${conn.border}`;
  els.connbanner.innerHTML = `<span class="dot" style="background:${conn.color}"></span>${esc(conn.text)}`;
}

/* ───────────────────────── buscador ───────────────────────── */
let universe = [];
let debounceTimer = null;

async function initSearch() {
  universe = await getUniverse();
  els.searchinput.addEventListener('input', (e) => {
    state.query = e.target.value;
    clearTimeout(debounceTimer);
    debounceTimer = setTimeout(renderDropdown, 80);
  });
  els.searchinput.addEventListener('focus', renderDropdown);
  document.addEventListener('click', (e) => {
    if (!els.dropdown.contains(e.target) && e.target !== els.searchinput) els.dropdown.style.display = 'none';
  });
}

function renderDropdown() {
  const q = state.query.trim().toLowerCase();
  if (!q) { els.dropdown.style.display = 'none'; return; }
  const matches = universe.filter(a => a.ticker.toLowerCase().includes(q) || a.name.toLowerCase().includes(q)).slice(0, 8);
  if (!matches.length) { els.dropdown.style.display = 'none'; return; }
  els.dropdown.innerHTML = matches.map(a => `
    <div class="dropdown-item" data-ticker="${esc(a.ticker)}">
      <div class="dropdown-left">
        <span class="dropdown-ticker">${esc(a.ticker)}</span>
        <span class="dropdown-name">${esc(a.name)}</span>
      </div>
      <div class="dropdown-right">
        <span class="dropdown-cat">${esc(a.category)}</span>
        <button class="star-btn" data-star="${esc(a.ticker)}" title="Agregar a seguimiento">${isWatched(a.ticker) ? '★' : '☆'}</button>
      </div>
    </div>`).join('');
  els.dropdown.style.display = 'block';
  els.dropdown.querySelectorAll('.dropdown-item').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target.closest('.star-btn')) return; selectTicker(el.dataset.ticker); });
  });
  els.dropdown.querySelectorAll('.star-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = btn.dataset.star;
      toggleWatchlist(ticker);
      btn.textContent = isWatched(ticker) ? '★' : '☆';
      refreshIfWatchlistVisible();
      loadWatchlistData();
    });
  });
}

async function selectTicker(ticker) {
  state.query = '';
  els.searchinput.value = '';
  els.dropdown.style.display = 'none';
  els.tickerchip.textContent = ticker;
  state.loading = true;
  state.error = null;
  state.report = null;
  chartState.tf = '1day';
  chartState.cache = {};
  chartState.loading.clear();
  chartState.mode = 'institucional';
  renderTopbar();
  renderReport();
  await loadReport(ticker);
}

/* ───────────────────────── carga + cálculo del reporte ───────────────────────── */
async function loadReport(ticker) {
  const asset = await getAsset(ticker);
  if (!asset) { state.loading = false; state.error = 'sin_activo'; state.asset = { ticker }; renderReport(); return; }
  state.asset = asset;

  try {
    const isCripto = asset.category === 'Cripto';
    const [quote, candles, fundamentals, news, macro, ccl, weeklyNative, spyCandles, earnings] = await Promise.all([
      getQuote(ticker), getCandles(ticker, '1day', 260), getFundamentals(ticker), getNews(ticker), getMacro(), getCCL(),
      isCripto ? Promise.resolve(null) : getCandles(ticker, '1week', 130),
      ticker === 'SPY' ? Promise.resolve(null) : getCandles('SPY', '1day', 220),
      getEarnings(ticker),
    ]);

    // Operar en la ventana de unos días antes de que la empresa reporte
    // balance es mucho más incierto que un día normal — no predice qué va a
    // pasar, solo baja la confianza de la señal técnica/fundamental.
    let daysToEarnings = null;
    if (earnings?.nextDate) {
      // Comparar contra la medianoche UTC de hoy (no la hora exacta actual):
      // si no, "earnings es hoy" redondeaba a -1 según qué hora del día fuera.
      const todayMidnight = new Date(); todayMidnight.setUTCHours(0, 0, 0, 0);
      daysToEarnings = Math.round((new Date(earnings.nextDate + 'T00:00:00Z') - todayMidnight) / 86400000);
    }
    const earningsSoon = daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 5;

    const now = Date.now();
    const technical = computeTechnical(candles);
    // Correlación/beta vs SPY: SPY se cachea 60s en dataSource, así que mirar
    // varios tickers seguidos no multiplica los requests al proveedor.
    const marketCorrelation = spyCandles ? correlationAndBeta(candles.c, spyCandles.c) : null;

    // Confirmación con el timeframe semanal: nativo (Twelve Data) para
    // acciones/CEDEARs/ETFs, resampleado de las velas diarias para cripto
    // (CoinGecko no ofrece timeframe semanal en el free tier).
    const weeklyCandles = isCripto ? resampleWeekly(candles) : weeklyNative;
    const weeklyTechnical = weeklyCandles && weeklyCandles.c.length >= 20 ? computeTechnical(weeklyCandles) : null;
    const confluence = weeklyTechnical ? weeklyConfluence(technical, weeklyTechnical) : null;

    const fundForScore = fundamentals?.hasData ? {
      hasData: true,
      revenueGrowth: fundamentals.revenueGrowth != null ? fundamentals.revenueGrowth : null,
      epsGrowth: fundamentals.epsGrowth != null ? fundamentals.epsGrowth : null,
      roe: fundamentals.roe != null ? fundamentals.roe : null,
      netMargin: fundamentals.netMargin != null ? fundamentals.netMargin : null,
      peg: fundamentals.peg,
    } : null;
    const macroForScore = { vix: macro?.vix ?? null, riesgoPaisArg: macro?.riesgoPaisArg ?? null, fearGreed: macro?.fearGreed ?? null };
    const scoreResult = computeScore({ technical, fundamentals: fundForScore, macro: macroForScore, newsSentiment: news?.sentimentScore ?? null, candles, confluence, sector: asset.sector, earningsSoon });
    const plan = computePlan(technical, scoreResult.score);

    state.report = {
      asset, quote, candles, fundamentals, news, macro, ccl,
      technical, weeklyTechnical, confluence, marketCorrelation, earnings, daysToEarnings, earningsSoon, ...scoreResult, plan,
      ts: { quote: now, candles: now, fundamentals: now, news: now },
    };

    // El gráfico arranca en 1D/1S sin pegarle de nuevo a la API: reutiliza
    // las mismas velas que ya se pidieron para el análisis diario/semanal.
    chartState.cache['1day'] = { candles, isReal: candles.isReal };
    if (weeklyCandles) chartState.cache['1week'] = { candles: weeklyCandles, isReal: isCripto ? candles.isReal : (weeklyNative?.isReal ?? false) };
    state.loading = false;
    if (asset.sector) loadPeerRadar(asset.sector, macro); // no bloquea el render del reporte
  } catch (e) {
    console.error('[app] error cargando reporte', e);
    state.loading = false;
    state.error = 'error_carga';
  }
  renderTopbar();
  renderReport();
}

/* ───────────────────────── radar de fortalezas vs sector ───────────────────────── */
// Promedio real de hasta 3 pares del mismo sector (universe.json), cacheado
// por sector (no por ticker) durante 20 min — así ver varios activos del
// mismo sector seguidos no vuelve a pedir todo de nuevo. Ejes sin cobertura
// (ej. fundamentales de un ETF) quedan marcados "no disponible", nunca 0
// disfrazado de dato real.
const PEER_RADAR_KEYS = ['fundamentals', 'trend', 'momentum', 'valuation', 'risk'];
const PEER_RADAR_LABELS = { fundamentals: 'Fundamental', trend: 'Técnico', momentum: 'Momentum', valuation: 'Valoración', risk: 'Riesgo' };
const peerRadarState = { bySector: {}, loadingSector: null };

async function loadPeerRadar(sector, macro) {
  const cached = peerRadarState.bySector[sector];
  if (cached && Date.now() - cached.at < 20 * 60 * 1000) { if (!state.asset) return; renderReport(); return; }
  if (peerRadarState.loadingSector === sector) return;
  peerRadarState.loadingSector = sector;

  const peers = universe.filter(a => a.sector === sector && a.ticker !== state.asset?.ticker && a.category !== 'Cripto').slice(0, 3);
  if (peers.length < 2) {
    peerRadarState.bySector[sector] = { at: Date.now(), data: null, peerTickers: [] };
    peerRadarState.loadingSector = null;
    if (state.asset?.sector === sector) renderReport();
    return;
  }

  try {
    const results = await Promise.all(peers.map(async (p) => {
      try {
        const [quote, candles, fundamentals] = await Promise.all([getQuote(p.ticker), getCandles(p.ticker, '1day', 220), getFundamentals(p.ticker)]);
        const technical = computeTechnical(candles);
        const fundForScore = fundamentals?.hasData ? {
          hasData: true,
          revenueGrowth: fundamentals.revenueGrowth ?? null, epsGrowth: fundamentals.epsGrowth ?? null,
          roe: fundamentals.roe ?? null, netMargin: fundamentals.netMargin ?? null, peg: fundamentals.peg,
        } : null;
        const macroForScore = { vix: macro?.vix ?? null, riesgoPaisArg: macro?.riesgoPaisArg ?? null, fearGreed: macro?.fearGreed ?? null };
        const scoreResult = computeScore({ technical, fundamentals: fundForScore, macro: macroForScore, newsSentiment: null, candles, confluence: null, sector: p.sector, earningsSoon: false });
        return scoreResult.scoreBreakdown;
      } catch (e) {
        console.warn('[peer-radar] no se pudo cargar', p.ticker, e.message);
        return null;
      }
    }));

    const valid = results.filter(Boolean);
    const data = valid.length ? PEER_RADAR_KEYS.map(key => {
      const vals = valid.map(rows => rows.find(row => row.key === key)).filter(row => row?.available);
      return vals.length ? { key, pct: Math.round(vals.reduce((s, row) => s + row.pct, 0) / vals.length), available: true } : { key, pct: null, available: false };
    }) : null;

    peerRadarState.bySector[sector] = { at: Date.now(), data, peerTickers: peers.map(p => p.ticker) };
  } catch (e) {
    console.warn('[peer-radar] falló para sector', sector, e.message);
  } finally {
    peerRadarState.loadingSector = null;
    if (state.asset?.sector === sector) renderReport();
  }
}

/* ───────────────────────── narrativas generadas de datos reales ───────────────────────── */
const BIAS_LABEL = { up: 'alcista', down: 'bajista' };

function technicalNarrative(t, confluence) {
  const alignTxt = t.bullishAlign ? 'Las EMAs 20/50/100/200 están alineadas en orden alcista.'
    : t.bearishAlign ? 'Las EMAs 20/50/100/200 están alineadas en orden bajista.'
    : 'Las EMAs no muestran alineación direccional clara — el precio se ubica ' + (t.price > t.ema200 ? 'por encima' : 'por debajo') + ' de la EMA200.';
  const rsiTxt = isNaN(t.rsi) ? '' : (t.rsi > 70 ? ` RSI en ${t.rsi.toFixed(0)}, zona de sobrecompra.` : t.rsi < 30 ? ` RSI en ${t.rsi.toFixed(0)}, zona de sobreventa.` : ` RSI en ${t.rsi.toFixed(0)}, terreno neutral.`);
  const structTxt = ` ${t.structure.label}`;
  const srTxt = ` Soporte de referencia en $${t.support.toFixed(2)} y resistencia en $${t.resistance.toFixed(2)}.`;
  const confluenceTxt = confluence
    ? confluence.agree
      ? ` El timeframe semanal confirma el sesgo ${BIAS_LABEL[confluence.dailyBias]} de corto plazo.`
      : ` Atención: el diario es ${BIAS_LABEL[confluence.dailyBias]} pero el semanal es ${BIAS_LABEL[confluence.weeklyBias]} — hay divergencia entre timeframes, señal menos confiable de lo habitual.`
    : '';
  const obvTxt = t.obvConfirms === false ? ' El volumen (OBV) no acompaña el movimiento de precio, señal de alerta.'
    : t.obvConfirms === true ? ' El volumen (OBV) confirma la dirección del precio.' : '';
  const divTxt = t.divergence ? ` ${t.divergence.label}` : '';
  return alignTxt + rsiTxt + structTxt + srTxt + ` ${t.priceAction.full}` + confluenceTxt + obvTxt + divTxt;
}

function fundamentalNarrative(f, sector) {
  if (!f?.hasData) return 'No hay cobertura de fundamentales para este ticker en el proveedor de datos conectado (común en ETFs, cripto o ADRs de menor liquidez). El score se calculó redistribuyendo el peso de esta categoría entre las demás.';
  const parts = [];
  if (f.revenueGrowth != null) parts.push(`el crecimiento de ingresos interanual es de ${f.revenueGrowth.toFixed(1)}%`);
  if (f.epsGrowth != null) parts.push(`el de EPS es de ${f.epsGrowth.toFixed(1)}%`);
  if (f.peg != null) parts.push(`el PEG se ubica en ${f.peg.toFixed(1)}x`);
  if (f.roe != null) parts.push(`el ROE es de ${f.roe.toFixed(1)}%`);
  const base = !parts.length ? 'Datos fundamentales parciales — el proveedor no reporta las métricas clave para este ticker.' : `Según los últimos datos reportados, ${parts.join(', ')}.`;

  const range = SECTOR_PE_RANGE[sector];
  if (!range || f.peTTM == null) return base;
  const [lo, hi] = range;
  const posTxt = f.peTTM <= lo ? `por debajo del rango típico del sector ${sector} (${lo}x–${hi}x), señal de valuación relativamente barata`
    : f.peTTM <= hi ? `dentro del rango típico del sector ${sector} (${lo}x–${hi}x)`
    : `por encima del rango típico del sector ${sector} (${lo}x–${hi}x), señal de valuación relativamente exigente`;
  return `${base} El PE de ${f.peTTM.toFixed(1)}x está ${posTxt}.`;
}

function conclusionText(r) {
  const { score, scoreLabel, plan, asset } = r;
  return `${asset.name} (${asset.ticker}) obtiene un score compuesto de ${score}/100 (${scoreLabel}), calculado sobre ${r.coverageWeight}/${r.fullWeight} puntos de peso con datos disponibles. El plan operativo sugiere zona de compra ${plan.compra}, con stop loss en ${plan.stopLoss} y objetivos en ${plan.tp1} / ${plan.tp2} / ${plan.tp3} (risk/reward ${plan.riskReward}). Esta lectura es puramente cuantitativa — no incorpora catalizadores cualitativos específicos de la empresa que no estén reflejados en precio, volumen o los fundamentales reportados por el proveedor de datos.`;
}

function risksAndCatalysts(r) {
  const { technical: t, fundamentals: f, macro, confluence, earningsSoon, daysToEarnings } = r;
  const risks = [];
  const catalysts = [];

  if (confluence && !confluence.agree) risks.push(`Divergencia entre timeframes: el diario es ${BIAS_LABEL[confluence.dailyBias]} pero el semanal es ${BIAS_LABEL[confluence.weeklyBias]} — la señal de corto plazo puede no sostenerse.`);
  if (confluence && confluence.agree) catalysts.push(`El timeframe semanal confirma la tendencia ${BIAS_LABEL[confluence.dailyBias]} del diario, mayor consistencia entre plazos.`);

  if (t.divergence) risks.push(t.divergence.label);
  if (t.obvConfirms === false) risks.push('El volumen (OBV) no acompaña el movimiento de precio reciente — mayor probabilidad de que sea una ruptura falsa.');
  if (t.obvConfirms === true) catalysts.push('El volumen (OBV) confirma la dirección del precio, respalda la lectura técnica.');

  if (earningsSoon) risks.push(`La empresa reporta balance en ${daysToEarnings === 0 ? 'el día de hoy' : `${daysToEarnings} día(s)`} — mayor volatilidad esperada e incertidumbre no capturada por el análisis técnico.`);

  if (t.atr / t.price > 0.03) risks.push(`Volatilidad relativa alta: ATR(14) equivale a ${(t.atr / t.price * 100).toFixed(1)}% del precio, por encima de lo típico.`);
  else catalysts.push(`Volatilidad relativa contenida: ATR(14) equivale a ${(t.atr / t.price * 100).toFixed(1)}% del precio.`);

  if (t.rsi > 70) risks.push(`RSI en zona de sobrecompra (${t.rsi.toFixed(0)}), mayor probabilidad de toma de ganancias de corto plazo.`);
  if (t.rsi < 30) catalysts.push(`RSI en zona de sobreventa (${t.rsi.toFixed(0)}), condición técnica favorable para un rebote.`);

  if (t.bearishAlign) risks.push('Estructura de EMAs en orden bajista — la tendencia de fondo no favorece posiciones largas.');
  if (t.bullishAlign) catalysts.push('Estructura de EMAs en orden alcista — la tendencia de fondo acompaña posiciones largas.');

  if (f?.hasData && f.peg != null && f.peg > 2.5) risks.push(`Valuación exigente: PEG de ${f.peg.toFixed(1)}x deja poco margen de error si el crecimiento se desacelera.`);
  if (f?.hasData && f.debtEquity != null && f.debtEquity > 1.5) risks.push(`Apalancamiento elevado: Debt/Equity de ${f.debtEquity.toFixed(2)}.`);
  if (f?.hasData && f.epsGrowth != null && f.epsGrowth > 15) catalysts.push(`Crecimiento de EPS de ${f.epsGrowth.toFixed(1)}% interanual sostiene la tesis de mediano plazo.`);

  if (macro?.vix != null && macro.vix > 22) risks.push(`Contexto macro con VIX elevado (${macro.vix}), mayor probabilidad de movimientos bruscos en todo el mercado.`);
  if (macro?.vix != null && macro.vix < 15) catalysts.push(`Contexto macro con VIX bajo (${macro.vix}), entorno de menor aversión al riesgo.`);

  if (!risks.length) risks.push('No se detectaron señales de riesgo elevado en los indicadores calculados — igual, ningún activo está exento de riesgo de mercado.');
  if (!catalysts.length) catalysts.push('No se detectaron catalizadores técnicos destacados en la ventana analizada.');

  return { risks, catalysts };
}

function reportSkeletonHTML() {
  const skelRow = (w = '100%') => `<div class="skel skel-line" style="width:${w};"></div>`;
  return `
    <div class="exec-grid">
      <div class="card exec-card">
        <div class="skel skel-title"></div>
        ${skelRow('30%')}
        <div style="height:20px;"></div>
        ${skelRow('80%')}${skelRow('60%')}${skelRow('70%')}
      </div>
      <div class="card gauge-card">
        <div class="skel" style="width:150px; height:150px; border-radius:50%;"></div>
      </div>
    </div>
    <div class="card thermo-card">${skelRow('100%')}</div>
    ${sectionTitleHTML('Gráfico de Precio', 'chart')}
    <div class="card chart-card"><div class="skel skel-chart"></div></div>
    <div class="card score-card">
      ${Array.from({ length: 6 }).map(() => `<div class="skel-row"><div class="skel" style="width:110px; height:12px;"></div><div class="skel" style="flex:1; height:8px;"></div></div>`).join('')}
    </div>
    <div class="grid2">
      <div class="card panel-card">
        <div class="skel-grid">${Array.from({ length: 8 }).map(() => skelRow('90%')).join('')}</div>
      </div>
      <div class="card panel-card">
        <div class="skel-grid">${Array.from({ length: 8 }).map(() => skelRow('90%')).join('')}</div>
      </div>
    </div>
  `;
}

/* ───────────────────────── backtesting ─────────────────────────
 * Recorre las velas diarias reales de un ticker, y en cada corte histórico
 * calcula la MISMA señal técnica que ve un usuario hoy (computeTechnical +
 * computeScore, sin fundamentales/macro/noticias históricas — no se
 * inventan, se excluyen y el peso se redistribuye, igual que hace el score
 * en vivo cuando faltan). Ningún dato de una vela futura entra en el corte
 * (no hay look-ahead): technical y score en el índice i solo ven velas
 * 0..i. Después mide el retorno real hacia adelante desde ese punto, para
 * cada horizonte, y lo agrupa por la etiqueta que dio la señal en ese momento. */
const BACKTEST_HORIZONS = [5, 10, 20, 40];
const BACKTEST_WARMUP = 210; // barras necesarias para que EMA200/ADX/etc. dejen de ser NaN
const BACKTEST_STEP = 3; // muestrea cada 3 velas: alcanza para una lectura estable sin miles de cálculos por click
const BACKTEST_LABELS = ['Compra Fuerte', 'Compra Moderada', 'Mantener', 'Reducir', 'Venta'];

async function runBacktest(ticker) {
  const candles = await getCandles(ticker, '1day', 500);
  if (!candles?.c?.length) throw new Error('sin velas disponibles para este ticker');
  const n = candles.c.length;
  const maxHorizon = Math.max(...BACKTEST_HORIZONS);
  const needed = BACKTEST_WARMUP + maxHorizon + 20;
  if (n < needed) {
    return { ticker, isReal: candles.isReal, insufficientData: true, candleCount: n, needed };
  }

  const buckets = {};
  let sampleCount = 0;
  for (let i = BACKTEST_WARMUP; i <= n - maxHorizon - 1; i += BACKTEST_STEP) {
    const slice = {
      o: candles.o.slice(0, i + 1), h: candles.h.slice(0, i + 1), l: candles.l.slice(0, i + 1),
      c: candles.c.slice(0, i + 1), v: candles.v.slice(0, i + 1), t: candles.t.slice(0, i + 1),
    };
    let technical;
    try { technical = computeTechnical(slice); } catch (e) { continue; }
    const scoreResult = computeScore({ technical, fundamentals: null, macro: null, newsSentiment: null, candles: slice, confluence: null, sector: null, earningsSoon: false });
    const label = scoreResult.scoreLabel;
    if (!buckets[label]) buckets[label] = {};
    const priceNow = candles.c[i];
    for (const h of BACKTEST_HORIZONS) {
      const fwd = candles.c[i + h];
      if (fwd == null) continue;
      (buckets[label][h] ??= []).push((fwd - priceNow) / priceNow);
    }
    sampleCount++;
  }

  const rows = BACKTEST_LABELS.map(label => {
    const byH = buckets[label] || {};
    const horizons = BACKTEST_HORIZONS.map(h => {
      const arr = byH[h] || [];
      if (!arr.length) return { h, n: 0, avgPct: null, winRate: null };
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const wins = arr.filter(r => r > 0).length;
      return { h, n: arr.length, avgPct: avg * 100, winRate: Math.round((wins / arr.length) * 100) };
    });
    return { label, horizons, occurrences: horizons.reduce((max, x) => Math.max(max, x.n), 0) };
  });

  return {
    ticker, isReal: candles.isReal, insufficientData: false, candleCount: n, sampleCount,
    from: candles.t[BACKTEST_WARMUP], to: candles.t[n - 1], rows,
  };
}

/* ───────────────────────── render del reporte ───────────────────────── */
const VIEW_PAGES = {
  dashboard: { html: dashboardHTML, wire: wireDashboardEvents, load: () => { if (!dashState.started) loadDashboardData(); loadPortfolioData(); } },
  portfolio: { html: portfolioHTML, wire: wirePortfolioEvents, load: loadPortfolioData },
  watchlist: { html: watchlistPageHTML, wire: wireWatchlistEvents, load: () => {} },
  macro: { html: macroNewsPageHTML, wire: wireMacroNewsEvents, load: loadMacroNewsData },
  alerts: { html: alertsPageHTML, wire: wireAlertsEvents, load: () => {} },
  backtest: { html: backtestPageHTML, wire: wireBacktestEvents, load: () => {} },
  calendar: { html: calendarPageHTML, wire: wireCalendarEvents, load: loadCalendarData },
  screener: { html: screenerPageHTML, wire: wireScreenerEvents, load: () => { if (!dashState.started) loadDashboardData(); } },
  compare: { html: comparePageHTML, wire: wireCompareEvents, load: () => {} },
  settings: { html: settingsPageHTML, wire: wireSettingsEvents, load: () => {} },
};

function renderReport() {
  renderReportImpl();
  triggerReportTransition();
}

/** Reinicia la animación de fade-in del panel principal en cada render
 *  (reemplazar innerHTML no reinicia una animación CSS ya asignada al
 *  contenedor — hace falta forzar un reflow) y anima el score del gauge
 *  con un conteo ascendente cuando hay un informe de ticker cargado. */
function triggerReportTransition() {
  els.report.classList.remove('report-fade');
  void els.report.offsetWidth;
  els.report.classList.add('report-fade');
  if (state.report) {
    const gaugeEl = els.report.querySelector('.gauge-score');
    if (gaugeEl) animateCountUp(gaugeEl, state.report.score);
  }
}

function animateCountUp(el, target, duration = 700) {
  const startTime = performance.now();
  const ease = (t) => 1 - Math.pow(1 - t, 3);
  function tick(now) {
    const progress = Math.min(1, (now - startTime) / duration);
    el.textContent = Math.round(target * ease(progress));
    if (progress < 1) requestAnimationFrame(tick);
  }
  requestAnimationFrame(tick);
}

function renderReportImpl() {
  renderSidebar();
  if (state.loading) {
    els.report.innerHTML = reportSkeletonHTML();
    return;
  }
  if (state.error === 'sin_activo' || (!state.report && state.asset)) {
    els.report.innerHTML = `
      <div class="emptycard">
        <div class="emptycard-title">Sin informe disponible para ${esc(state.asset.ticker)}</div>
        <div class="emptycard-body">Este ticker no está en el universo cargado. Sumalo a <code>universe.json</code> (o a la lista de cripto en <code>dataSource.js</code>) para poder analizarlo.</div>
      </div>`;
    return;
  }
  if (state.error === 'error_carga') {
    els.report.innerHTML = `
      <div class="emptycard">
        <div class="emptycard-title">No se pudo generar el informe de ${esc(state.asset?.ticker ?? '')}</div>
        <div class="emptycard-body">Falló la carga de datos en vivo y tampoco hay caché disponible. Probá de nuevo en unos segundos.</div>
      </div>`;
    return;
  }
  if (!state.report) {
    const page = VIEW_PAGES[state.view] ?? VIEW_PAGES.dashboard;
    els.report.innerHTML = page.html();
    page.wire();
    page.load();
    return;
  }

  const r = state.report;
  const { asset, quote, technical: t, fundamentals: f, news, macro, ccl, score, scoreLabel, confidence, scoreBreakdown, plan, ts, coverageWeight, fullWeight, confluence, marketCorrelation, earnings, daysToEarnings, earningsSoon } = r;

  const trendUp = quote.changePct >= 0;
  const trendBg = trendUp ? 'oklch(0.30 0.09 152)' : 'oklch(0.30 0.10 23)';
  const trendColor = trendUp ? 'oklch(0.87 0.14 152)' : 'oklch(0.86 0.15 23)';
  const trendLabel = `${trendUp ? 'Tendencia Alcista' : 'Tendencia Bajista'} (${fmtPct(quote.changePct)})`;

  const deg = Math.round(clampNum(score, 0, 100) / 100 * 360);
  const gaugeColor = scoreLabelColor(scoreLabel).color;
  const gaugeGradient = `conic-gradient(from -90deg, ${gaugeColor} ${deg}deg, oklch(0.28 0.03 262) ${deg}deg)`;
  const gaugeGlow = withAlpha(gaugeColor, 0.4);
  const thermoPos = Math.min(97, Math.max(3, score));

  const freshTechnical = freshnessFor(ts.candles, quote.isReal && r.candles.isReal);
  const freshFundamental = f?.hasData ? freshnessFor(ts.fundamentals, f.isReal, { staleAfterMs: 6 * 3600 * 1000 }) : { text: 'Sin cobertura de fundamentales', color: AMBER };
  const freshMacro = macroFreshness(macro);
  const freshNews = freshnessFor(ts.news, news?.isReal, { staleAfterMs: 30 * 60 * 1000 });
  const freshPlan = freshTechnical;
  const planOpacity = (!quote.isReal && !r.candles.isReal) ? 0.55 : 1;

  const { risks, catalysts } = risksAndCatalysts(r);
  const w52 = fiftyTwoWeekRange(r.candles);
  const volStats = volumeStats(r.candles);

  const isCedear = (asset.category === 'CEDEAR' || asset.category === 'ETF') && asset.ratio;
  const cedearPriceTxt = quote.cedearArs != null ? `AR$${Math.round(quote.cedearArs).toLocaleString('es-AR')} por CEDEAR` : 'N/D';
  const cedearSourceTxt = quote.cedearSource === 'live'
    ? 'precio real operado hoy en BYMA'
    : `estimación vía CCL${ccl?.value ? ` ≈ $${Math.round(ccl.value).toLocaleString('es-AR')}` : ''} — sin cotización real disponible para este símbolo`;
  const cedearNote = isCedear ? `
    <div class="cedear-note">
      <strong>Referencia CEDEAR (solo informativa):</strong> el análisis completo se realizó sobre ${esc(asset.name)} (${esc(asset.ticker)}) cotizando en USD. El CEDEAR argentino replica esta acción con ratio de referencia 1:${asset.ratio}. Equivalente: ${cedearPriceTxt} (${cedearSourceTxt}). Ninguna recomendación de esta sección se basa en el precio en pesos.
    </div>` : '';

  const breadcrumbLabel = { CEDEAR: 'Acciones / CEDEARs', ETF: 'ETFs', Cripto: 'Cripto' }[asset.category] ?? asset.category;
  // Moneda de referencia elegida en Configuración: si el usuario prefiere ARS
  // y hay precio de CEDEAR disponible, lidera el precio grande de la ficha —
  // el análisis y el plan operativo siguen siendo 100% en USD (subyacente).
  const showArsPrimary = settingsState.defaultCurrency === 'ARS' && quote.cedearArs != null;
  const execPricePrimary = showArsPrimary ? fmtArs(quote.cedearArs) : fmtUsd(quote.usd);
  const execPriceSecondary = showArsPrimary
    ? `<div class="exec-price-secondary">${fmtUsd(quote.usd)} USD (subyacente)</div>`
    : quote.cedearArs != null ? `<div class="exec-price-secondary">CEDEAR ${fmtArs(quote.cedearArs)}</div>` : '';
  const subScoreKeys = ['fundamentals', 'trend', 'momentum', 'valuation', 'risk'];
  const subScoreLabels = { fundamentals: 'Fundamental', trend: 'Técnico', momentum: 'Momentum', valuation: 'Valoración', risk: 'Riesgo' };
  const subScores = subScoreKeys.map(k => scoreBreakdown.find(sb => sb.key === k)).filter(Boolean);

  els.report.innerHTML = `
    <div class="breadcrumbs">Análisis <span>›</span> ${esc(breadcrumbLabel)} <span>›</span> <strong>${esc(asset.ticker)}</strong></div>
    ${sectionTitleHTML('Resumen Ejecutivo', 'briefcase')}
    <div class="exec-grid">
      <div class="card exec-card">
        <div class="exec-name-row">
          <div class="exec-name">${esc(asset.name)}</div>
          <div class="exec-tickersector">${esc(asset.ticker)} · ${esc(asset.sector)}</div>
          <button class="star-btn star-btn-lg" id="exec-star" title="Agregar a seguimiento">${isWatched(asset.ticker) ? '★' : '☆'}</button>
        </div>
        <div class="exec-price-row">
          <div class="exec-price">${execPricePrimary}</div>
          ${execPriceSecondary}
          <div class="exec-trend" style="background:${trendBg}; color:${trendColor};">${esc(trendLabel)}</div>
        </div>
        <div class="exec-stats">
          <div><div class="exec-stat-label">Confianza</div><div class="exec-stat-value">${esc(confidence)}</div></div>
          <div><div class="exec-stat-label">Horizonte</div><div class="exec-stat-value">${horizonFor(t)}</div></div>
          <div><div class="exec-stat-label">Tendencia primaria</div><div class="exec-stat-value">${esc(t.primaryTrend)}</div></div>
        </div>
        ${subScores.length ? `
        <div class="exec-subscores">
          ${subScores.map(sb => `
            <div class="exec-subscore-row">
              <span class="exec-subscore-label">${esc(subScoreLabels[sb.key])}</span>
              <div class="score-bar-bg"><div class="score-bar-fill" style="width:${sb.pct}%; opacity:${sb.available ? 1 : 0.25};"></div></div>
              <span class="exec-subscore-value">${sb.available ? Math.round(sb.pct) : 'N/D'}</span>
            </div>`).join('')}
        </div>` : ''}
      </div>
      <div class="card gauge-card">
        <div class="gauge-ring" style="background:${gaugeGradient}; filter: drop-shadow(0 0 22px ${gaugeGlow});">
          <div class="gauge-inner">
            <div class="gauge-score">${score}</div>
            <div class="gauge-outof">de 100</div>
          </div>
        </div>
        <div class="gauge-label">${esc(scoreLabel)}</div>
        <div class="gauge-conviction" title="Convicción: ${esc(confidence)}">${convictionDotsHTML(confidence)}<span>Convicción: ${esc(confidence)}</span></div>
      </div>
    </div>

    ${sectionTitleHTML('Resumen Ejecutivo IA', 'bulb')}
    <div class="card ai-summary-card">
      <ul class="ai-summary-list">
        ${catalysts.slice(0, 3).map(c => `<li class="ok">${ICONS.check}<span>${esc(c)}</span></li>`).join('')}
        ${risks.slice(0, 3).map(rk => `<li class="risk">${ICONS.warning}<span>${esc(rk)}</span></li>`).join('')}
      </ul>
    </div>

    <div class="card thermo-card">
      <div class="thermo-labels"><span>Venta</span><span>Reducir</span><span>Mantener</span><span>Compra</span><span>Compra Fuerte</span></div>
      <div class="thermo-bar"><div class="thermo-marker" style="left:${thermoPos}%;"></div></div>
      <div class="thermo-valuewrap"><div class="thermo-value" style="left:${thermoPos}%;">${score}</div></div>
    </div>

    <div class="stat-cards-row">
      <div class="card stat-card">
        <div class="stat-card-label">Precio</div>
        <div class="stat-card-value">${fmtUsd(quote.usd)}</div>
        <div class="stat-card-sub ${trendUp ? 'up' : 'down'}">${fmtPct(quote.changePct)} hoy</div>
      </div>
      <div class="card stat-card">
        <div class="stat-card-label">${w52 ? `${w52.weeks} semanas` : '52 Semanas'}</div>
        ${w52 ? `
          <div class="stat-card-value" style="font-size:15px;">${fmtUsd(w52.lo)} – ${fmtUsd(w52.hi)}</div>
          <div class="stat-card-range-bar"><div class="stat-card-range-dot" style="left:${clampNum(((w52.price - w52.lo) / (w52.hi - w52.lo || 1)) * 100, 2, 98)}%;"></div></div>
        ` : `<div class="stat-card-value">N/D</div>`}
      </div>
      <div class="card stat-card">
        <div class="stat-card-label">RSI (14)</div>
        <div class="stat-card-value ${isNaN(t.rsi) ? '' : t.rsi > 70 ? 'down' : t.rsi < 30 ? 'up' : ''}">${isNaN(t.rsi) ? 'N/D' : t.rsi.toFixed(1)}</div>
        <div class="stat-card-sub">${isNaN(t.rsi) ? '' : t.rsi > 70 ? 'Sobrecomprado' : t.rsi < 30 ? 'Sobrevendido' : 'Neutral'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-card-label">Beta (vs SPY)</div>
        <div class="stat-card-value">${marketCorrelation?.beta != null ? marketCorrelation.beta.toFixed(2) : 'N/D'}</div>
        <div class="stat-card-sub">${marketCorrelation?.beta != null ? (marketCorrelation.beta > 1.2 ? 'Alta' : marketCorrelation.beta < 0.8 ? 'Baja' : 'Moderada') : ''}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-card-label">EMA 20</div>
        <div class="stat-card-value">${fmtNum(t.ema20)}</div>
        <div class="stat-card-sub ${t.price > t.ema20 ? 'up' : 'down'}">${t.price > t.ema20 ? 'Precio arriba' : 'Precio abajo'}</div>
      </div>
      <div class="card stat-card">
        <div class="stat-card-label">Volumen</div>
        <div class="stat-card-value" style="font-size:16px;">${volStats ? fmtVolume(volStats.last) : 'N/D'}</div>
        <div class="stat-card-sub ${volStats?.ratioPct != null ? (volStats.ratioPct >= 0 ? 'up' : 'down') : ''}">${volStats?.ratioPct != null ? `${volStats.ratioPct >= 0 ? '+' : ''}${volStats.ratioPct.toFixed(0)}% vs prom.` : 'Sin datos'}</div>
      </div>
    </div>

    ${sectionTitleHTML('Gráfico de Precio', 'chart')}
    <div class="card chart-card">
      <div class="chart-mode-tabs">
        <button class="chart-mode-tab ${chartState.mode === 'institucional' ? 'active' : ''}" data-mode="institucional">Análisis Institucional</button>
        <button class="chart-mode-tab ${chartState.mode === 'libre' ? 'active' : ''}" data-mode="libre">Análisis Libre (TradingView)</button>
      </div>
      ${chartState.mode === 'libre' ? `
      <div class="tv-note">Widget gratuito de TradingView con sus propios datos e indicadores — usalo para tu propio análisis técnico libre. El símbolo puede no coincidir 1:1 con el precio de CEDEAR en pesos que calculamos arriba (esa parte del análisis siempre es sobre ${esc(asset.name)} en USD).</div>
      <div id="tv-widget-container" class="tv-widget-container"></div>
      ` : `
      <div class="chart-tabs">
        ${chartTabsForAsset(asset).map(tab => `<button class="chart-tab ${chartState.tf === tab.key ? 'active' : ''}" data-tf="${tab.key}">${tab.label}</button>`).join('')}
      </div>
      ${chartCardBody(t, plan)}
      `}
    </div>

    <div class="card score-card">
      <div class="score-card-title">Composición del Score ${coverageWeight < fullWeight ? `<span style="text-transform:none; letter-spacing:0; color:oklch(0.58 0.018 260);">— calculado sobre ${coverageWeight}/${fullWeight} puntos de peso (categorías sin datos excluidas y redistribuidas)</span>` : ''}</div>
      <div class="score-rows">
        ${scoreBreakdown.map(sb => `
          <div class="score-row">
            <div class="score-label">${esc(sb.label)}${sb.available ? '' : ' (sin datos)'}</div>
            <div class="score-bar-bg"><div class="score-bar-fill" style="width:${sb.pct}%; opacity:${sb.available ? 1 : 0.25};"></div></div>
            <div class="score-fraction">${sb.value}/${sb.weight}</div>
          </div>`).join('')}
      </div>
    </div>

    <div class="grid2">
      <div>
        <div class="panel-header">
          <div class="panel-title">${ICONS.chart}<span>Análisis Técnico</span></div>
          <div class="freshness" style="color:${freshTechnical.color};"><span class="dot" style="background:${freshTechnical.color};"></span>${esc(freshTechnical.text)}</div>
        </div>
        <div class="card panel-card">
          <div class="metrics-grid">
            ${technicalMetricRows(t, confluence, marketCorrelation).map(m => `<div class="metric-row"><span class="metric-label">${esc(m.label)}</span><span class="metric-value">${esc(m.value)}</span></div>`).join('')}
          </div>
          <div class="narrative">${esc(technicalNarrative(t, confluence))}</div>
        </div>
      </div>
      <div>
        <div class="panel-header">
          <div class="panel-title">${ICONS.building}<span>Análisis Fundamental</span></div>
          <div class="freshness" style="color:${freshFundamental.color};"><span class="dot" style="background:${freshFundamental.color};"></span>${esc(freshFundamental.text)}</div>
        </div>
        <div class="card panel-card">
          <div class="metrics-grid">
            ${fundamentalMetricRows(f, earnings, daysToEarnings).map(m => `<div class="metric-row"><span class="metric-label">${esc(m.label)}</span><span class="metric-value">${esc(m.value)}</span></div>`).join('')}
          </div>
          <div class="narrative">${esc(fundamentalNarrative(f, asset.sector))}</div>
        </div>
      </div>
    </div>

    <div class="grid2-macronews">
      <div>
        <div class="panel-header">
          <div class="panel-title">${ICONS.globe}<span>Contexto Macro</span></div>
          <div class="freshness" style="color:${freshMacro.color};"><span class="dot" style="background:${freshMacro.color};"></span>${esc(freshMacro.text)}</div>
        </div>
        <div class="card macro-card">
          ${macroChips(macro).map(mc => `<div class="macro-chip">${mc.live ? '<span class="macro-chip-live" title="En vivo"></span>' : ''}<span class="macro-chip-label">${esc(mc.label)}: </span><span class="macro-chip-value">${esc(mc.value)}</span>${typeof mc.live === 'string' ? ` <span class="macro-chip-var">(${esc(mc.live)})</span>` : ''}</div>`).join('')}
        </div>
      </div>
      <div>
        <div class="panel-header">
          <div class="panel-title">${ICONS.news}<span>Noticias Recientes</span></div>
          <div class="freshness" style="color:${freshNews.color};"><span class="dot" style="background:${freshNews.color};"></span>${esc(freshNews.text)}</div>
        </div>
        <div class="card news-card">
          ${news?.items?.length ? news.items.slice(0, 5).map(n => `
            <div class="news-item">
              <div class="news-tag" style="background:${n.bg}; color:${n.color};">${esc(n.tag)}</div>
              <div class="news-text">${esc(n.text)}</div>
            </div>`).join('') : `<div class="news-empty">Sin noticias recientes cargadas para este ticker.</div>`}
        </div>
      </div>
    </div>

    <div class="grid2">
      <div>
        ${sectionTitleHTML('Riesgos', 'warning')}
        <div class="card rc-card"><ul class="rc-list">${risks.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>
      <div>
        ${sectionTitleHTML('Catalizadores', 'bulb')}
        <div class="card rc-card"><ul class="rc-list">${catalysts.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>
    </div>

    ${radarHTML(asset, scoreBreakdown)}

    <div class="panel-header">
      ${sectionTitleHTML('Plan Operativo', 'target', 'margin-bottom:0;')}
      <div class="freshness" style="color:${freshPlan.color};"><span class="dot" style="background:${freshPlan.color};"></span>${esc(freshPlan.text)}</div>
    </div>
    <div class="card plan-card" style="opacity:${planOpacity};">
      <div class="plan-grid">
        <div><div class="plan-label">Zona de compra</div><div class="plan-chip buy">${esc(plan.compra)}</div></div>
        <div><div class="plan-label">Zona de venta</div><div class="plan-chip sell">${esc(plan.venta)}</div></div>
        <div><div class="plan-label">Stop loss</div><div class="plan-chip stop">${esc(plan.stopLoss)}</div></div>
        <div><div class="plan-label">Take Profit 1</div><div class="plan-chip tp">${esc(plan.tp1)}</div></div>
        <div><div class="plan-label">Take Profit 2</div><div class="plan-chip tp">${esc(plan.tp2)}</div></div>
        <div><div class="plan-label">Take Profit 3</div><div class="plan-chip tp">${esc(plan.tp3)}</div></div>
      </div>
      <div class="plan-footer">
        <div class="plan-footer-item">Risk/Reward: <span>${esc(plan.riskReward)}</span></div>
        <div class="plan-footer-item">Drawdown esperado: <span>${esc(plan.drawdown)}</span></div>
      </div>
      <div class="probability-row">
        <span class="probability-label">Probabilidad estimada</span>
        <div class="probability-bar-bg"><div class="probability-bar-fill" style="width:${plan.probabilityPct}%;"></div></div>
        <span class="probability-value">${esc(plan.probability)}</span>
      </div>
    </div>

    ${sectionTitleHTML('Conclusión', 'check')}
    <div class="card conclusion-card">
      <div class="conclusion-text">${esc(conclusionText(r))}</div>
    </div>

    ${cedearNote}
  `;

  const starBtn = document.getElementById('exec-star');
  if (starBtn) {
    starBtn.addEventListener('click', () => {
      toggleWatchlist(asset.ticker);
      const nowWatched = isWatched(asset.ticker);
      starBtn.textContent = nowWatched ? '★' : '☆';
      showToast(nowWatched ? `${asset.ticker} agregado a tu Watchlist` : `${asset.ticker} sacado de tu Watchlist`, nowWatched ? 'success' : 'info');
      loadWatchlistData();
    });
  }

  els.report.querySelectorAll('.chart-tab').forEach(btn => {
    btn.addEventListener('click', () => loadChartTf(btn.dataset.tf));
  });
  const chartWrap = els.report.querySelector('.chart-svg-wrap');
  const chartEntry = chartState.cache[chartState.tf];
  if (chartWrap && chartEntry) wireChartHover(chartWrap, chartEntry.candles);

  els.report.querySelectorAll('.chart-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (chartState.mode === btn.dataset.mode) return;
      chartState.mode = btn.dataset.mode;
      renderReport();
    });
  });
  if (chartState.mode === 'libre' && state.asset) mountTradingViewWidget('tv-widget-container', tvSymbolFor(state.asset));
}

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function horizonFor(t) {
  return t.adx > 22 ? '3–6 meses' : '6–12 meses';
}

/** Rango de las últimas ~52 semanas (o lo que haya disponible: candles trae
 *  hasta 260 sesiones diarias, pero un activo recién listado puede tener
 *  menos historial — se etiqueta según los días reales usados, nunca se
 *  asume "52 semanas" si no hay esa cantidad de datos). */
function fiftyTwoWeekRange(candles) {
  const n = candles.c.length;
  if (n < 10) return null;
  const window = Math.min(n, 252);
  const h = candles.h.slice(n - window), l = candles.l.slice(n - window);
  const hi = Math.max(...h), lo = Math.min(...l);
  const weeks = Math.round(window / 5);
  return { hi, lo, weeks, price: candles.c[n - 1] };
}

/** Volumen de la sesión más reciente vs el promedio de las 20 previas. */
function volumeStats(candles) {
  const v = candles.v || [];
  const n = v.length;
  if (n < 5 || !v.some(x => x > 0)) return null;
  const last = v[n - 1];
  const windowN = Math.min(20, n - 1);
  const prev = v.slice(n - 1 - windowN, n - 1);
  const avg = prev.reduce((s, x) => s + x, 0) / (prev.length || 1);
  return { last, avg, ratioPct: avg > 0 ? ((last - avg) / avg) * 100 : null };
}

function fmtVolume(n) {
  if (n == null || isNaN(n)) return 'N/D';
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(Math.round(n));
}

const CONVICTION_DOTS = { 'Alta': 4, 'Media-Alta': 3, 'Media': 2, 'Media-Baja': 1, 'Baja': 0 };
function convictionDotsHTML(confidence) {
  const filled = CONVICTION_DOTS[confidence] ?? 2;
  return Array.from({ length: 4 }).map((_, i) => `<span class="conviction-dot ${i < filled ? 'filled' : ''}"></span>`).join('');
}

function macroFreshness(macro) {
  if (macro?.isReal && macro.liveFetchedAt) return { text: `Riesgo país/dólares en vivo, ${relativeTime(new Date(macro.liveFetchedAt).getTime())}`, color: GREEN };
  if (!macro?.lastUpdated) return { text: 'Sin datos macro', color: RED };
  const ageDays = (Date.now() - new Date(macro.lastUpdated).getTime()) / 86400000;
  if (ageDays > 14) return { text: `Snapshot manual desactualizado (${Math.round(ageDays)}d)`, color: RED };
  if (ageDays > 3) return { text: `Snapshot manual (hace ${Math.round(ageDays)}d)`, color: AMBER };
  return { text: `Snapshot manual (hace ${Math.round(ageDays)}d)`, color: GREEN };
}

function radarHTML(asset, scoreBreakdown) {
  if (!asset.sector) return '';
  const entry = peerRadarState.bySector[asset.sector];
  const labels = PEER_RADAR_KEYS.map(k => PEER_RADAR_LABELS[k]);
  const assetValues = PEER_RADAR_KEYS.map(k => scoreBreakdown.find(sb => sb.key === k)?.pct ?? 0);

  if (!entry) {
    return `
      ${sectionTitleHTML('Fortalezas vs Sector', 'radar')}
      <div class="card dash-loading-note" style="margin-bottom:36px;">Calculando promedio real de pares del sector ${esc(asset.sector)}…</div>`;
  }
  if (!entry.data) {
    return `
      ${sectionTitleHTML('Fortalezas vs Sector', 'radar')}
      <div class="card watch-empty" style="margin-bottom:36px;">No hay suficientes pares del sector ${esc(asset.sector)} en el universo cargado para calcular un promedio real — se omite el radar antes que mostrar un número inventado.</div>`;
  }
  const peerValues = PEER_RADAR_KEYS.map(k => entry.data.find(d => d.key === k)?.pct ?? 0);
  return `
    ${sectionTitleHTML('Fortalezas vs Sector', 'radar')}
    <div class="card radar-card" style="margin-bottom:36px;">
      <div class="radar-layout">
        ${renderRadarSVG(labels, assetValues, peerValues)}
        <div class="radar-legend">
          <div class="radar-legend-item"><i style="background:oklch(0.70 0.19 291);"></i>${esc(asset.ticker)}</div>
          <div class="radar-legend-item"><i style="background:oklch(0.58 0.018 260);"></i>Promedio ${esc(asset.sector)} (${entry.peerTickers.map(esc).join(', ')})</div>
          <div class="radar-legend-note">Cada eje es el sub-score real (0–100) del motor de análisis; los ejes sin cobertura de datos para algún par se excluyen del promedio, nunca se completan con un valor inventado.</div>
        </div>
      </div>
    </div>`;
}

function technicalMetricRows(t, confluence, marketCorrelation) {
  const nearestFib = Object.entries(t.fib.levels).sort((a, b) => Math.abs(a[1] - t.price) - Math.abs(b[1] - t.price))[0];
  const confluenceValue = !confluence ? 'N/D — historial semanal insuficiente'
    : confluence.agree ? `✓ Confirmada (${BIAS_LABEL[confluence.dailyBias]})`
    : `⚠ Divergencia (D:${BIAS_LABEL[confluence.dailyBias]} / S:${BIAS_LABEL[confluence.weeklyBias]})`;
  const corrValue = !marketCorrelation || marketCorrelation.correlation == null ? 'N/D'
    : `${marketCorrelation.correlation.toFixed(2)} (beta ${marketCorrelation.beta.toFixed(2)})`;
  return [
    { label: 'Confirmación semanal', value: confluenceValue },
    { label: 'Correlación / Beta vs SPY', value: corrValue },
    { label: 'EMA 20 / 50', value: `${fmtNum(t.ema20)} / ${fmtNum(t.ema50)}` },
    { label: 'EMA 100 / 200', value: `${fmtNum(t.ema100)} / ${fmtNum(t.ema200)}` },
    { label: 'RSI (14)', value: isNaN(t.rsi) ? 'N/D' : `${t.rsi.toFixed(0)} — ${t.rsi > 70 ? 'sobrecompra' : t.rsi < 30 ? 'sobreventa' : 'neutral'}` },
    { label: 'MACD (señal)', value: isNaN(t.hist) ? 'N/D' : (t.hist > 0 ? 'Cruce alcista' : 'Cruce bajista') },
    { label: 'ADX', value: isNaN(t.adx) ? 'N/D' : `${t.adx.toFixed(0)} — ${t.adx > 25 ? 'fuerte' : t.adx > 20 ? 'moderada' : 'débil'}` },
    { label: 'ATR (14)', value: fmtNum(t.atr) },
    { label: 'VWAP (rolling 20)', value: t.hasVolume ? fmtNum(t.vwap) : 'N/D — sin volumen' },
    { label: 'Bandas de Bollinger', value: t.bbPos ?? 'N/D' },
    { label: 'OBV', value: t.obvTrend + (t.obvConfirms === true ? ' ✓ confirma' : t.obvConfirms === false ? ' ⚠ no confirma' : '') },
    { label: 'Divergencia RSI', value: t.divergence ? (t.divergence.type === 'bearish' ? '⚠ Bajista' : '⚠ Alcista') : 'Sin divergencia' },
    { label: 'Soporte / Resistencia', value: `$${t.support.toFixed(2)} / $${t.resistance.toFixed(2)}` },
    { label: 'Acción de precio', value: t.priceAction.short },
    { label: 'Fibonacci', value: nearestFib ? `${nearestFib[0]} ≈ $${nearestFib[1].toFixed(2)}` : 'N/D' },
    { label: 'Estructura de mercado', value: t.structure.short },
  ];
}

function fundamentalMetricRows(f, earnings, daysToEarnings) {
  if (!f?.hasData) return [{ label: 'Cobertura', value: 'Sin datos fundamentales para este ticker' }];
  const pct = (v) => v == null ? 'N/D' : fmtPct(v);
  const x = (v) => v == null ? 'N/D' : `${v.toFixed(1)}x`;
  const earningsValue = !earnings?.nextDate ? 'N/D'
    : daysToEarnings < 0 ? `Reportó el ${earnings.nextDate}`
    : daysToEarnings === 0 ? '⚠ Hoy'
    : daysToEarnings <= 5 ? `⚠ En ${daysToEarnings} día${daysToEarnings === 1 ? '' : 's'} (${earnings.nextDate})`
    : `${earnings.nextDate} (en ${daysToEarnings} días)`;
  return [
    { label: 'Próximo reporte (earnings)', value: earningsValue },
    { label: 'Revenue Growth (YoY)', value: pct(f.revenueGrowth) },
    { label: 'EPS Growth (YoY)', value: pct(f.epsGrowth) },
    { label: 'PE / Forward PE', value: `${f.peTTM != null ? f.peTTM.toFixed(1) + 'x' : 'N/D'} / ${f.peForward != null ? f.peForward.toFixed(1) + 'x' : 'N/D'}` },
    { label: 'PEG', value: x(f.peg) },
    { label: 'PB / PS', value: `${x(f.pb)} / ${x(f.ps)}` },
    { label: 'EV/EBITDA', value: x(f.evEbitda) },
    { label: 'ROE / ROIC', value: `${pct(f.roe)} / ${pct(f.roi)}` },
    { label: 'Margen bruto / neto', value: `${pct(f.grossMargin)} / ${pct(f.netMargin)}` },
    { label: 'Debt/Equity', value: f.debtEquity != null ? f.debtEquity.toFixed(2) : 'N/D' },
    { label: 'Dividend Yield', value: pct(f.dividendYield) },
  ];
}

function macroChips(macro) {
  if (!macro) return [];
  const arsFmt = (v) => v == null ? 'N/D' : `$${Math.round(v).toLocaleString('es-AR')}`;
  const chips = [
    { label: 'FED (tasa)', value: macro.fedRateLabel ?? 'N/D' },
    { label: 'DXY', value: macro.dxy ?? 'N/D' },
    { label: 'VIX', value: macro.vix ?? 'N/D' },
    { label: 'Bono 10Y', value: macro.bond10y != null ? `${macro.bond10y}%` : 'N/D' },
    { label: 'IPC (YoY)', value: macro.cpiYoyLabel ?? 'N/D' },
    { label: 'PBI (trim.)', value: macro.gdpQoqLabel ?? 'N/D' },
    { label: 'Riesgo país (ARG)', value: macro.riesgoPaisArg ?? 'N/D', live: macro.isReal ? macro.riesgoPaisVariacion : null },
  ];
  if (macro.dolares) {
    chips.push(
      { label: 'Dólar oficial', value: arsFmt(macro.dolares.oficial), live: true },
      { label: 'Dólar blue', value: arsFmt(macro.dolares.blue), live: true },
      { label: 'Dólar MEP', value: arsFmt(macro.dolares.mep), live: true },
      { label: 'Dólar CCL', value: arsFmt(macro.dolares.ccl), live: true },
    );
  }
  if (macro.fearGreed) {
    chips.push({ label: 'Fear & Greed (cripto)', value: `${macro.fearGreed.value} — ${macro.fearGreed.label}`, live: true });
  }
  return chips;
}

/* ───────────────────────── seguimiento (watchlist) ───────────────────────── */
function scoreLabelColor(label) {
  if (label === 'Compra Fuerte') return { bg: 'oklch(0.32 0.11 152)', color: 'oklch(0.90 0.16 152)' };
  if (label === 'Compra Moderada') return { bg: 'oklch(0.28 0.08 152)', color: 'oklch(0.83 0.14 152)' };
  if (label === 'Mantener') return { bg: 'oklch(0.30 0.09 70)', color: 'oklch(0.85 0.13 70)' };
  if (label === 'Reducir') return { bg: 'oklch(0.30 0.10 45)', color: 'oklch(0.85 0.14 45)' };
  return { bg: 'oklch(0.30 0.12 23)', color: 'oklch(0.88 0.16 23)' }; // Venta
}

function sortAndFilterTickers(tickers) {
  let list = tickers.slice();
  if (watchState.filterSignal !== 'all') {
    list = list.filter(ticker => watchState.data[ticker]?.scoreLabel === watchState.filterSignal);
  }
  const val = (ticker, key) => {
    const d = watchState.data[ticker];
    if (!d) return key === 'ticker' ? ticker : -Infinity; // sin datos todavía: al final
    if (key === 'score') return d.score;
    if (key === 'price') return d.price;
    if (key === 'change') return d.changePct;
    return ticker;
  };
  list.sort((a, b) => {
    if (watchState.sortBy === 'ticker') return val(a, 'ticker').localeCompare(val(b, 'ticker'));
    return val(b, watchState.sortBy) - val(a, watchState.sortBy);
  });
  return list;
}

/* ───────────────────────── sidebar de navegación ───────────────────────── */
const SIDEBAR_NAV = [
  { view: 'dashboard', label: 'Dashboard', icon: 'grid' },
  { view: 'portfolio', label: 'Portfolio Advisor', icon: 'briefcase' },
  { view: 'watchlist', label: 'Watchlist', icon: 'bookmark' },
  { view: 'screener', label: 'Screener', icon: 'filter' },
  { view: 'compare', label: 'Comparador', icon: 'compare' },
  { view: 'macro', label: 'Noticias & Macro', icon: 'globe' },
  { view: 'alerts', label: 'Alertas', icon: 'warning' },
  { view: 'calendar', label: 'Calendario Económico', icon: 'calendar' },
  { view: 'backtest', label: 'Backtesting', icon: 'trend' },
  { view: 'settings', label: 'Configuración', icon: 'gear' },
];
// Ninguna funcionalidad queda deshabilitada por ahora: cada ítem del sidebar
// corresponde a una vista real con datos en vivo. Si se agrega una nueva
// función todavía sin terminar, va acá con datos omitidos por completo (no
// un placeholder con números inventados) hasta que esté lista.
const SIDEBAR_NAV_DISABLED = [];

function renderSidebar() {
  if (!els.sidebarNav) return;
  const activeView = !state.asset ? state.view : null;
  els.sidebarNav.innerHTML = `
    <div class="sidebar-nav-group">
      ${SIDEBAR_NAV.map(item => `
        <button class="sidebar-nav-btn ${activeView === item.view ? 'active' : ''}" data-view="${item.view}">
          ${ICONS[item.icon]}<span>${esc(item.label)}</span>
        </button>`).join('')}
    </div>
    ${SIDEBAR_NAV_DISABLED.length ? `
    <div class="sidebar-nav-group">
      <div class="sidebar-nav-label">Próximamente</div>
      ${SIDEBAR_NAV_DISABLED.map(item => `
        <button class="sidebar-nav-btn disabled" disabled title="Todavía no disponible">
          ${ICONS[item.icon]}<span>${esc(item.label)}</span>
        </button>`).join('')}
    </div>` : ''}`;

  els.sidebarNav.querySelectorAll('.sidebar-nav-btn[data-view]').forEach(btn => {
    btn.addEventListener('click', () => {
      state.asset = null; state.report = null; state.error = null; state.loading = false;
      state.view = btn.dataset.view;
      els.tickerchip.textContent = '—';
      renderTopbar();
      renderReport();
    });
  });

  renderSidebarMarket();
}

function renderSidebarMarket() {
  if (!els.sidebarMarket) return;
  const tickers = SIDEBAR_MARKET_TICKERS.filter(t => dashState.data[t]);
  els.sidebarMarket.innerHTML = `
    <div class="sidebar-market-title">Mercado Hoy</div>
    ${tickers.length ? tickers.map(t => {
      const d = dashState.data[t];
      const up = d.changePct >= 0;
      return `<div class="sidebar-market-row" data-dash-ticker="${esc(t)}">
        <span class="sidebar-market-ticker">${esc(t)}</span>
        <span class="sidebar-market-change ${up ? 'up' : 'down'}">${fmtPct(d.changePct)}</span>
      </div>`;
    }).join('') : `<div class="sidebar-market-loading">Cargando…</div>`}`;
  els.sidebarMarket.querySelectorAll('[data-dash-ticker]').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.dashTicker));
  });
}

let sparklineIdSeq = 0;
function sparklineSVG(closes, up) {
  if (!closes || closes.length < 2) return '';
  const w = 120, h = 34, pad = 2;
  const min = Math.min(...closes), max = Math.max(...closes);
  const range = (max - min) || 1;
  const stepX = (w - pad * 2) / (closes.length - 1);
  const pts = closes.map((c, i) => {
    const x = pad + i * stepX;
    const y = h - pad - ((c - min) / range) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const color = up ? 'oklch(0.76 0.18 152)' : 'oklch(0.70 0.21 23)';
  const linePath = `M${pts.join(' L')}`;
  const areaPath = `${linePath} L${(w - pad).toFixed(1)},${(h - pad).toFixed(1)} L${pad.toFixed(1)},${(h - pad).toFixed(1)} Z`;
  const gradId = `sparkGrad${sparklineIdSeq++}`; // id único por instancia — varias tarjetas comparten la página
  return `<svg class="watch-sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
    <defs><linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0%" stop-color="${color}" stop-opacity="0.38"/>
      <stop offset="100%" stop-color="${color}" stop-opacity="0"/>
    </linearGradient></defs>
    <path d="${areaPath}" fill="url(#${gradId})" stroke="none"/>
    <path d="${linePath}" fill="none" stroke="${color}" stroke-width="1.6"/>
  </svg>`;
}

function dashCardHTML(ticker, d) {
  const up = d.changePct >= 0;
  const sig = scoreLabelColor(d.scoreLabel);
  const am = d.alert ? ALERT_META[d.alert.type] : null;
  return `<div class="watch-card ${am ? 'has-alert' : ''}" data-dash-ticker="${esc(ticker)}" style="${am ? `border-color:${am.color};` : ''}">
    <div class="watch-ticker">${esc(ticker)}${d.isReal === false ? ' <span class="watch-stale">demo</span>' : ''}</div>
    <div class="watch-name">${esc(d.name ?? '')}</div>
    <div class="watch-price">${fmtUsd(d.price)}</div>
    <div class="watch-change ${up ? 'up' : 'down'}">${fmtPct(d.changePct)}</div>
    ${sparklineSVG(d.sparkline, up)}
    <div class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(d.scoreLabel)} · ${d.score}</div>
    ${d.highlight ? `<div class="watch-highlight">${esc(d.highlight)}</div>` : ''}
    ${am ? `<div class="watch-alert" style="color:${am.color};">⚡ ${esc(am.label)}</div>` : ''}
  </div>`;
}

function dashboardHTML() {
  const entries = DASHBOARD_UNIVERSE.map(ticker => ({ ticker, d: dashState.data[ticker] }));
  const loaded = entries.filter(e => e.d);
  const loadingCount = DASHBOARD_UNIVERSE.length - loaded.length;

  const opportunities = loaded.slice().sort((a, b) => b.d.score - a.d.score).slice(0, 6);
  const buyZone = loaded.filter(e => e.d.alert?.type === 'buy').sort((a, b) => b.d.score - a.d.score).slice(0, 6);

  const bySignal = {};
  for (const e of loaded) bySignal[e.d.scoreLabel] = (bySignal[e.d.scoreLabel] || 0) + 1;

  const bySector = {};
  for (const e of loaded) {
    if (!e.d.sector) continue;
    if (!bySector[e.d.sector]) bySector[e.d.sector] = { sum: 0, count: 0 };
    bySector[e.d.sector].sum += e.d.score; bySector[e.d.sector].count++;
  }
  const sectorRows = Object.entries(bySector)
    .map(([sector, s]) => ({ sector, avg: Math.round(s.sum / s.count) }))
    .sort((a, b) => b.avg - a.avg);

  const byChange = loaded.slice().sort((a, b) => b.d.changePct - a.d.changePct);
  const gainers = byChange.slice(0, 3);
  const losers = byChange.slice(-3).reverse();

  const radarRow = (label, valueHtml) => `<div class="dash-radar-row"><span class="dash-radar-label">${label}</span><span class="dash-radar-count">${valueHtml}</span></div>`;

  const avgScore = loaded.length ? Math.round(loaded.reduce((s, e) => s + e.d.score, 0) / loaded.length) : null;
  const topSignal = Object.entries(bySignal).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  const heroStat = (value, label, small) => `<div class="dash-hero-stat"><div class="dash-hero-stat-value${small ? ' small' : ''}">${value}</div><div class="dash-hero-stat-label">${label}</div></div>`;

  return `
    <div class="dash-hero">
      <div class="dash-hero-text">
        <div class="dash-hero-title">Tu mesa de análisis, en un vistazo</div>
        <div class="dash-hero-sub">Score compuesto, plan operativo y contexto macro con datos reales — sin señales inventadas.</div>
      </div>
      <div class="dash-hero-stats">
        ${heroStat(`${loaded.length}/${DASHBOARD_UNIVERSE.length}`, 'Activos en vivo')}
        ${heroStat(buyZone.length, 'En zona de compra')}
        ${heroStat(avgScore ?? '—', 'Score promedio')}
        ${heroStat(esc(topSignal ?? '—'), 'Señal dominante', true)}
      </div>
    </div>
    ${sectionTitleHTML('Dashboard', 'grid')}
    <div class="dash-intro">Oportunidades del día y radar del mercado sobre un universo curado de ${DASHBOARD_UNIVERSE.length} activos líquidos (acciones US, CEDEARs argentinos, ETFs y cripto) — no es todo el universo buscable, para no exceder el límite de requests del proveedor de datos gratuito. Elegí cualquiera para ver el informe completo, o buscá otro activo arriba.</div>

    ${sectionTitleHTML('Oportunidades del Día', 'trend', 'margin-top:28px;')}
    ${!opportunities.length ? `<div class="card watch-empty">Cargando universo curado…</div>` : `<div class="watch-grid">${opportunities.map(({ ticker, d }) => dashCardHTML(ticker, d)).join('')}</div>`}
    ${loadingCount > 0 ? `<div class="dash-loading-note">Cargando ${loadingCount} activo(s) más del universo curado…</div>` : ''}

    ${sectionTitleHTML('En Zona de Compra Ahora', 'target')}
    <div class="dash-intro" style="margin-bottom:14px;">Activos del universo curado cuyo precio está, ahora mismo, en zona de compra o recién rompió el soporte según el análisis técnico (mismo criterio que las alertas de Seguimiento) — no es una recomendación, es dónde está el precio respecto al plan operativo de cada uno.</div>
    ${!loaded.length ? `<div class="card watch-empty">Cargando universo curado…</div>` : !buyZone.length ? `<div class="card watch-empty">Ningún activo del universo curado está en zona de compra en este momento.</div>` : `<div class="watch-grid">${buyZone.map(({ ticker, d }) => dashCardHTML(ticker, d)).join('')}</div>`}

    ${sectionTitleHTML('Radar del Mercado', 'radar')}
    <div class="dash-radar-grid">
      <div class="card dash-radar-card">
        <div class="dash-radar-title">Señales</div>
        ${['Compra Fuerte', 'Compra Moderada', 'Mantener', 'Reducir', 'Venta'].map(label => {
          const sig = scoreLabelColor(label);
          return `<div class="dash-radar-row"><span class="dash-radar-dot" style="background:${sig.color};"></span><span class="dash-radar-label">${label}</span><span class="dash-radar-count">${bySignal[label] || 0}</span></div>`;
        }).join('')}
      </div>
      <div class="card dash-radar-card">
        <div class="dash-radar-title">Score promedio por sector</div>
        ${sectorRows.length ? sectorRows.map(s => radarRow(esc(s.sector), s.avg)).join('') : '<div class="dash-loading-note">Cargando…</div>'}
      </div>
      <div class="card dash-radar-card">
        <div class="dash-radar-title">Mayores subas</div>
        ${gainers.length ? gainers.map(({ ticker, d }) => `<div class="dash-radar-row"><span class="dash-radar-label">${esc(ticker)}</span><span class="dash-radar-count up">${fmtPct(d.changePct)}</span></div>`).join('') : '<div class="dash-loading-note">Cargando…</div>'}
      </div>
      <div class="card dash-radar-card">
        <div class="dash-radar-title">Mayores bajas</div>
        ${losers.length ? losers.map(({ ticker, d }) => `<div class="dash-radar-row"><span class="dash-radar-label">${esc(ticker)}</span><span class="dash-radar-count down">${fmtPct(d.changePct)}</span></div>`).join('') : '<div class="dash-loading-note">Cargando…</div>'}
      </div>
    </div>

    ${dashBottomWidgetsHTML()}`;
}

function dashBottomWidgetsHTML() {
  const watchTickers = getWatchlist().slice(0, 6);
  const holdings = getPortfolio();
  const stats = holdings.length ? computePortfolioStats(holdings) : null;

  return `
    <div class="grid2">
      <div>
        <div class="panel-header">
          ${sectionTitleHTML('Watchlist Rápido', 'bookmark', 'margin-bottom:0;')}
          <a class="dash-widget-link" data-goto-view="watchlist">Ver Watchlist completa ›</a>
        </div>
        ${!watchTickers.length ? emptyStateHTML('bookmark', 'Todavía no agregaste activos a tu Watchlist.') : `
        <div class="watch-grid watch-grid-compact">${watchTickers.map(watchCardHTML).join('')}</div>`}
      </div>
      <div>
        <div class="panel-header">
          ${sectionTitleHTML('Mi Portfolio', 'briefcase', 'margin-bottom:0;')}
          <a class="dash-widget-link" data-goto-view="portfolio">Ver Portfolio ›</a>
        </div>
        ${!holdings.length ? emptyStateHTML('briefcase', 'Todavía no cargaste tenencias en Portfolio Advisor.') : `
        <div class="card port-mini-summary">
          <div class="port-mini-row">
            <span class="port-mini-label">Valor total</span>
            <span class="port-mini-value">${fmtUsd(stats.totalValue)}</span>
          </div>
          ${stats.totalGainUsd != null ? `<div class="port-mini-row"><span class="port-mini-label">Ganancia (costo USD)</span><span class="port-mini-value ${stats.totalGainUsd >= 0 ? 'up' : 'down'}">${stats.totalGainUsd >= 0 ? '+' : ''}${fmtUsd(stats.totalGainUsd)}</span></div>` : ''}
          ${stats.totalGainArs != null ? `<div class="port-mini-row"><span class="port-mini-label">Ganancia (costo ARS)</span><span class="port-mini-value ${stats.totalGainArs >= 0 ? 'up' : 'down'}">${stats.totalGainArs >= 0 ? '+' : ''}${fmtArs(stats.totalGainArs)}</span></div>` : ''}
          <div class="port-mini-row">
            <span class="port-mini-label">Score ponderado</span>
            <span class="port-mini-value">${stats.weightedScore ?? 'N/D'}</span>
          </div>
          <div class="port-mini-row">
            <span class="port-mini-label">Posiciones</span>
            <span class="port-mini-value">${holdings.length}</span>
          </div>
        </div>`}
      </div>
    </div>`;
}

function wireDashboardEvents() {
  els.report.querySelectorAll('[data-dash-ticker]').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.dashTicker));
  });
  els.report.querySelectorAll('.watch-card').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target.closest('.watch-remove')) return; selectTicker(el.dataset.ticker); });
  });
  els.report.querySelectorAll('.watch-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      toggleWatchlist(btn.dataset.remove);
      delete watchState.data[btn.dataset.remove];
      renderReport();
    });
  });
  els.report.querySelectorAll('[data-goto-view]').forEach(el => {
    el.addEventListener('click', () => { state.view = el.dataset.gotoView; renderReport(); });
  });
}

/** Página de Screener: filtra/ordena el mismo universo curado del Dashboard
 *  (dashState.data, ya calculado con datos reales) por score, sector,
 *  categoría, señal técnica y RSI — sin pedidos propios, reusa la carga
 *  batcheada de loadDashboardData(). */
const SCREENER_SORT_OPTIONS = [
  { key: 'score', label: 'Score (mayor a menor)' },
  { key: 'change', label: 'Variación % (mayor a menor)' },
  { key: 'rsi', label: 'RSI (menor a mayor)' },
  { key: 'ticker', label: 'Ticker (A-Z)' },
];
const screenerState = { minScore: 0, category: 'all', sector: 'all', signal: 'all', rsiFilter: 'all', sortBy: 'score' };

function screenerSectorOptions() {
  const set = new Set();
  for (const ticker of DASHBOARD_UNIVERSE) {
    const a = universe.find(x => x.ticker === ticker);
    if (a?.sector) set.add(a.sector);
  }
  return Array.from(set).sort();
}

function screenerRows() {
  let rows = DASHBOARD_UNIVERSE.map(ticker => ({ ticker, d: dashState.data[ticker] })).filter(e => e.d);
  if (screenerState.category !== 'all') rows = rows.filter(e => e.d.category === screenerState.category);
  if (screenerState.sector !== 'all') rows = rows.filter(e => e.d.sector === screenerState.sector);
  if (screenerState.signal !== 'all') rows = rows.filter(e => e.d.scoreLabel === screenerState.signal);
  if (screenerState.minScore > 0) rows = rows.filter(e => e.d.score >= screenerState.minScore);
  if (screenerState.rsiFilter === 'oversold') rows = rows.filter(e => e.d.rsi != null && e.d.rsi < 30);
  else if (screenerState.rsiFilter === 'overbought') rows = rows.filter(e => e.d.rsi != null && e.d.rsi > 70);
  else if (screenerState.rsiFilter === 'neutral') rows = rows.filter(e => e.d.rsi != null && e.d.rsi >= 30 && e.d.rsi <= 70);
  const sorters = {
    score: (a, b) => b.d.score - a.d.score,
    change: (a, b) => b.d.changePct - a.d.changePct,
    rsi: (a, b) => (a.d.rsi ?? 999) - (b.d.rsi ?? 999),
    ticker: (a, b) => a.ticker.localeCompare(b.ticker),
  };
  return rows.slice().sort(sorters[screenerState.sortBy] ?? sorters.score);
}

function screenerPageHTML() {
  const rows = screenerRows();
  const totalLoaded = DASHBOARD_UNIVERSE.filter(t => dashState.data[t]).length;
  const sectorOptions = screenerSectorOptions();
  const selectField = (id, label, options) => `
    <label class="screener-filter"><span>${esc(label)}</span>
      <select id="${id}" class="watch-select">${options}</select>
    </label>`;
  return `
    ${sectionTitleHTML('Screener', 'filter')}
    <div class="dash-intro">Filtrá el universo curado de ${DASHBOARD_UNIVERSE.length} activos líquidos por score, sector, categoría, señal técnica y RSI — mismo motor de análisis que el resto de la plataforma, sin pedidos extra.${totalLoaded < DASHBOARD_UNIVERSE.length ? ` Cargando datos de ${DASHBOARD_UNIVERSE.length - totalLoaded} activo(s) más…` : ''}</div>
    <div class="card screener-filters-card">
      <div class="screener-filters">
        ${selectField('scr-minscore', 'Score mínimo', [0, 30, 45, 65, 80].map(v => `<option value="${v}" ${screenerState.minScore === v ? 'selected' : ''}>${v === 0 ? 'Cualquiera' : `${v}+`}</option>`).join(''))}
        ${selectField('scr-signal', 'Señal', SIGNAL_FILTERS.map(s => `<option value="${esc(s)}" ${screenerState.signal === s ? 'selected' : ''}>${s === 'all' ? 'Todas' : esc(s)}</option>`).join(''))}
        ${selectField('scr-sector', 'Sector', `<option value="all" ${screenerState.sector === 'all' ? 'selected' : ''}>Todos</option>` + sectorOptions.map(s => `<option value="${esc(s)}" ${screenerState.sector === s ? 'selected' : ''}>${esc(s)}</option>`).join(''))}
        ${selectField('scr-category', 'Categoría', ['all', 'CEDEAR', 'ETF', 'Cripto'].map(c => `<option value="${c}" ${screenerState.category === c ? 'selected' : ''}>${c === 'all' ? 'Todas' : c}</option>`).join(''))}
        ${selectField('scr-rsi', 'RSI', `
          <option value="all" ${screenerState.rsiFilter === 'all' ? 'selected' : ''}>Cualquiera</option>
          <option value="oversold" ${screenerState.rsiFilter === 'oversold' ? 'selected' : ''}>Sobreventa (&lt;30)</option>
          <option value="neutral" ${screenerState.rsiFilter === 'neutral' ? 'selected' : ''}>Neutral (30-70)</option>
          <option value="overbought" ${screenerState.rsiFilter === 'overbought' ? 'selected' : ''}>Sobrecompra (&gt;70)</option>`)}
        ${selectField('scr-sort', 'Ordenar por', SCREENER_SORT_OPTIONS.map(o => `<option value="${o.key}" ${screenerState.sortBy === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join(''))}
      </div>
    </div>
    <div class="card bt-table-card">
      <div class="bt-table-wrap">
        <table class="bt-table screener-table">
          <thead><tr><th class="scr-left">Ticker</th><th class="scr-left">Nombre</th><th class="scr-left">Sector</th><th>Precio</th><th>Var %</th><th>RSI</th><th class="scr-left">Señal</th><th>Score</th></tr></thead>
          <tbody>
            ${!rows.length ? `<tr><td colspan="8" class="bt-nd" style="text-align:center; padding:26px;">Ningún activo del universo curado cumple estos filtros ahora mismo.</td></tr>` : rows.map(({ ticker, d }) => `
              <tr class="screener-row" data-ticker="${esc(ticker)}">
                <td class="scr-left" style="font-weight:700;">${esc(ticker)}</td>
                <td class="scr-left" style="color:var(--text-mute);">${esc(d.name)}</td>
                <td class="scr-left" style="color:var(--text-mute);">${esc(d.sector ?? 'N/D')}</td>
                <td>${fmtUsd(d.price)}</td>
                <td class="${d.changePct >= 0 ? 'bt-pos' : 'bt-neg'}">${fmtPct(d.changePct)}</td>
                <td>${d.rsi != null ? d.rsi.toFixed(0) : 'N/D'}</td>
                <td class="scr-left"><span class="bt-label-dot" style="background:${scoreLabelColor(d.scoreLabel).color};"></span>${esc(d.scoreLabel)}</td>
                <td style="font-weight:700;">${d.score}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function wireScreenerEvents() {
  const bind = (id, key, parse = (v) => v) => {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', () => { screenerState[key] = parse(el.value); renderReport(); });
  };
  bind('scr-minscore', 'minScore', Number);
  bind('scr-signal', 'signal');
  bind('scr-sector', 'sector');
  bind('scr-category', 'category');
  bind('scr-rsi', 'rsiFilter');
  bind('scr-sort', 'sortBy');
  els.report.querySelectorAll('.screener-row').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.ticker));
  });
}

/** Página de Comparador: hasta 3 tickers elegidos por el usuario, con score
 *  y su desglose, fundamentales/valuación clave y el retorno % superpuesto
 *  en el mismo gráfico — todo con datos reales pedidos on-demand (mismo
 *  patrón que el radar de sector: nada precalculado ni simulado). */
const COMPARE_MAX = 3;
const compareState = { tickers: [], loading: false, error: null, results: [] };

async function computeCompareEntry(ticker, macro) {
  const asset = await getAsset(ticker);
  if (!asset) throw new Error(`"${ticker}" no está en el universo cargado.`);
  const [quote, candles, fundamentals] = await Promise.all([getQuote(ticker), getCandles(ticker, '1day', 220), getFundamentals(ticker)]);
  const technical = computeTechnical(candles);
  const fundForScore = fundamentals?.hasData ? {
    hasData: true, revenueGrowth: fundamentals.revenueGrowth ?? null, epsGrowth: fundamentals.epsGrowth ?? null,
    roe: fundamentals.roe ?? null, netMargin: fundamentals.netMargin ?? null, peg: fundamentals.peg,
  } : null;
  const macroForScore = { vix: macro?.vix ?? null, riesgoPaisArg: macro?.riesgoPaisArg ?? null, fearGreed: macro?.fearGreed ?? null };
  const scoreResult = computeScore({ technical, fundamentals: fundForScore, macro: macroForScore, newsSentiment: null, candles, confluence: null, sector: asset.sector, earningsSoon: false });
  return {
    ticker, name: asset.name, sector: asset.sector, category: asset.category,
    price: quote.usd, changePct: quote.changePct, isReal: quote.isReal && candles.isReal,
    score: scoreResult.score, scoreLabel: scoreResult.scoreLabel, scoreBreakdown: scoreResult.scoreBreakdown,
    fundamentals, rsi: isNaN(technical.rsi) ? null : technical.rsi, atr: technical.atr,
    closes: candles.c, dates: candles.t,
  };
}

async function runCompare(tickers) {
  compareState.loading = true;
  compareState.error = null;
  renderReport();
  try {
    const macro = await getMacro();
    compareState.results = await Promise.all(tickers.map(t => computeCompareEntry(t, macro)));
    showToast(`Comparación de ${tickers.join(', ')} lista`, 'success');
  } catch (e) {
    compareState.error = e.message;
    compareState.results = [];
    showToast(e.message, 'error');
  } finally {
    compareState.loading = false;
    if (!state.asset && state.view === 'compare') renderReport();
  }
}

function comparePageHTML() {
  const slots = Array.from({ length: COMPARE_MAX }, (_, i) => compareState.tickers[i] ?? '');
  const results = compareState.results;
  return `
    ${sectionTitleHTML('Comparador de Activos', 'compare')}
    <div class="dash-intro">Compará hasta ${COMPARE_MAX} activos lado a lado: score y su desglose por categoría, fundamentales, valuación y retorno % superpuesto en el mismo gráfico — todo calculado en el momento con datos reales.</div>
    <div class="card port-form-card">
      <div class="port-form">
        ${slots.map((v, i) => `
          <input list="cmp-ticker-list" data-cmp-slot="${i}" class="port-input cmp-input" placeholder="Ticker ${i + 1}${i < 2 ? '' : ' (opcional)'}" autocomplete="off" style="text-transform:uppercase;" value="${esc(v)}" />`).join('')}
        <datalist id="cmp-ticker-list">${universe.map(a => `<option value="${esc(a.ticker)}">${esc(a.name)}</option>`).join('')}</datalist>
        <button class="port-add-btn" id="cmp-run" ${compareState.loading ? 'disabled' : ''}>${compareState.loading ? 'Comparando…' : 'Comparar'}</button>
      </div>
    </div>
    ${compareState.error ? `<div class="card watch-empty">${esc(compareState.error)}</div>` : ''}
    ${!results.length ? '' : `
      <div class="card chart-card" style="margin-bottom:24px;">
        ${renderCompareOverlaySVG(results.map(r => ({ ticker: r.ticker, closes: r.closes, dates: r.dates })))}
      </div>
      <div class="card bt-table-card" style="margin-bottom:24px;">
        <div class="bt-table-wrap">
          <table class="bt-table">
            <thead><tr>
              <th class="scr-left">Métrica</th>
              ${results.map(r => `<th>${esc(r.ticker)}</th>`).join('')}
            </tr></thead>
            <tbody>
              <tr><td class="scr-left" style="font-weight:600;">Score</td>${results.map(r => `<td style="font-weight:700; color:${scoreLabelColor(r.scoreLabel).color};">${r.score} · ${esc(r.scoreLabel)}</td>`).join('')}</tr>
              <tr><td class="scr-left">Precio</td>${results.map(r => `<td>${fmtUsd(r.price)}</td>`).join('')}</tr>
              <tr><td class="scr-left">Variación diaria</td>${results.map(r => `<td class="${r.changePct >= 0 ? 'bt-pos' : 'bt-neg'}">${fmtPct(r.changePct)}</td>`).join('')}</tr>
              <tr><td class="scr-left">Sector</td>${results.map(r => `<td>${esc(r.sector ?? 'N/D')}</td>`).join('')}</tr>
              <tr><td class="scr-left">RSI (14)</td>${results.map(r => `<td>${r.rsi != null ? r.rsi.toFixed(0) : 'N/D'}</td>`).join('')}</tr>
              ${['trend', 'momentum', 'fundamentals', 'valuation', 'risk', 'liquidity'].map(key => {
                const label = results[0].scoreBreakdown.find(x => x.key === key)?.label ?? key;
                return `<tr><td class="scr-left">${esc(label)}</td>${results.map(r => {
                  const sb = r.scoreBreakdown.find(x => x.key === key);
                  return `<td class="${!sb?.available ? 'bt-nd' : ''}">${sb?.available ? `${sb.pct}%` : 'N/D'}</td>`;
                }).join('')}</tr>`;
              }).join('')}
              <tr><td class="scr-left">PE (TTM)</td>${results.map(r => `<td>${r.fundamentals?.peTTM != null ? `${r.fundamentals.peTTM.toFixed(1)}x` : 'N/D'}</td>`).join('')}</tr>
              <tr><td class="scr-left">PEG</td>${results.map(r => `<td>${r.fundamentals?.peg != null ? `${r.fundamentals.peg.toFixed(1)}x` : 'N/D'}</td>`).join('')}</tr>
              <tr><td class="scr-left">ROE</td>${results.map(r => `<td>${r.fundamentals?.roe != null ? `${r.fundamentals.roe.toFixed(1)}%` : 'N/D'}</td>`).join('')}</tr>
              <tr><td class="scr-left">Crecimiento de ingresos</td>${results.map(r => `<td>${r.fundamentals?.revenueGrowth != null ? `${r.fundamentals.revenueGrowth.toFixed(1)}%` : 'N/D'}</td>`).join('')}</tr>
            </tbody>
          </table>
        </div>
      </div>
      <div class="bt-disclaimer">El gráfico superpone el retorno porcentual (no el precio absoluto, no comparable entre tickers de escalas distintas) de cada activo sobre la misma ventana de velas diarias, alineadas por cantidad de velas — no por fecha calendario exacta.</div>
    `}`;
}

function wireCompareEvents() {
  els.report.querySelectorAll('.cmp-input').forEach(input => {
    input.addEventListener('input', () => {
      const i = Number(input.dataset.cmpSlot);
      compareState.tickers[i] = input.value.toUpperCase();
    });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') document.getElementById('cmp-run')?.click(); });
  });
  const runBtn = document.getElementById('cmp-run');
  if (runBtn) runBtn.addEventListener('click', () => {
    const tickers = Array.from(new Set(compareState.tickers.map(t => (t || '').trim().toUpperCase()).filter(Boolean)));
    if (tickers.length < 2) { compareState.error = `Ingresá al menos 2 tickers para comparar.`; renderReport(); return; }
    runCompare(tickers.slice(0, COMPARE_MAX));
  });
}

/** Página de Configuración: dos preferencias que afectan la app de verdad,
 *  no un placeholder — moneda que lidera el precio grande de la ficha de
 *  cada activo, y perfil de riesgo que ajusta el tope de posición sugerido
 *  en Portfolio Advisor (ver portfolioRecommendation). Persiste en
 *  localStorage, mismo patrón que el resto de las preferencias de la app. */
function settingsPageHTML() {
  return `
    ${sectionTitleHTML('Configuración', 'gear')}
    <div class="dash-intro">Preferencias que afectan directamente el análisis que ya usás — no hay nada acá que sea solo cosmético.</div>

    <div class="card settings-card">
      <div class="settings-row-title">Moneda de referencia en la ficha del activo</div>
      <div class="settings-row-desc">El análisis, el score y el plan operativo siempre se calculan en USD (precio del activo subyacente) — esta preferencia solo decide qué precio aparece grande arriba de todo en la ficha de cada activo.</div>
      <div class="settings-options">
        <label class="settings-option ${settingsState.defaultCurrency === 'USD' ? 'active' : ''}">
          <input type="radio" name="set-currency" value="USD" ${settingsState.defaultCurrency === 'USD' ? 'checked' : ''} />
          <span>USD (activo subyacente)</span>
        </label>
        <label class="settings-option ${settingsState.defaultCurrency === 'ARS' ? 'active' : ''}">
          <input type="radio" name="set-currency" value="ARS" ${settingsState.defaultCurrency === 'ARS' ? 'checked' : ''} />
          <span>ARS (precio de CEDEAR, cuando esté disponible)</span>
        </label>
      </div>
    </div>

    <div class="card settings-card">
      <div class="settings-row-title">Perfil de riesgo</div>
      <div class="settings-row-desc">Fija el peso máximo sugerido por posición en Portfolio Advisor. Cuando una tenencia tiene señal de compra, la recomendación te avisa si ya estás en (o por encima de) ese tope según el peso real que tiene hoy en tu cartera cargada.</div>
      <div class="settings-options">
        ${Object.entries(RISK_PROFILES).map(([key, p]) => `
          <label class="settings-option ${settingsState.riskProfile === key ? 'active' : ''}">
            <input type="radio" name="set-risk" value="${key}" ${settingsState.riskProfile === key ? 'checked' : ''} />
            <span>${esc(p.label)} <span class="settings-option-sub">(tope ${p.maxPositionPct}% por posición)</span></span>
          </label>`).join('')}
      </div>
    </div>`;
}

function wireSettingsEvents() {
  els.report.querySelectorAll('input[name="set-currency"]').forEach(input => {
    input.addEventListener('change', () => {
      settingsState.defaultCurrency = input.value;
      lsSetSafe('icp_default_currency', input.value);
      showToast(`Moneda de referencia: ${input.value === 'ARS' ? 'ARS (CEDEAR)' : 'USD'}`, 'success');
      renderReport();
    });
  });
  els.report.querySelectorAll('input[name="set-risk"]').forEach(input => {
    input.addEventListener('change', () => {
      settingsState.riskProfile = input.value;
      lsSetSafe('icp_risk_profile', input.value);
      showToast(`Perfil de riesgo: ${RISK_PROFILES[input.value].label}`, 'success');
      renderReport();
    });
  });
}

/** Agrega los holdings con su señal ya resuelta en portState.data: valor
 *  total, score ponderado por peso en la cartera, concentración por activo
 *  y por sector, y qué posiciones tienen señal de Venta/Reducir. Todo a
 *  partir de datos reales — nada se inventa si falta el precio de un ticker. */
function computePortfolioStats(holdings) {
  const rows = holdings.map(h => {
    const d = portState.data[h.ticker];
    const price = d?.price ?? null;
    const value = price != null ? price * h.shares : null;
    return { ...h, d, value };
  });
  const totalValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  for (const r of rows) {
    r.weight = (r.value != null && totalValue > 0) ? r.value / totalValue : null;
    // El valor de mercado (arriba) siempre es en USD — es el precio real del
    // activo subyacente. El costo promedio, en cambio, puede haberse cargado
    // en pesos (CEDEAR) o en USD según cómo compró el usuario, así que el
    // P&L se calcula en la MISMA moneda que el costo, no siempre contra el
    // precio en USD (comparar pesos contra dólares daría un % sin sentido).
    if (r.avgCost != null) {
      const isArs = r.costCurrency === 'ARS';
      const currentInCostCurrency = isArs ? r.d?.cedearArs : r.d?.price;
      if (currentInCostCurrency != null) {
        r.gainPct = (currentInCostCurrency - r.avgCost) / r.avgCost;
        r.gainAbs = (currentInCostCurrency - r.avgCost) * r.shares;
        r.gainCurrency = isArs ? 'ARS' : 'USD';
      } else if (isArs) {
        r.gainUnavailableReason = 'Este activo no tiene CEDEAR (sin ratio ARS) — no se puede comparar el costo en pesos.';
      }
    }
  }

  let weightedScoreSum = 0, weightedScoreDenom = 0;
  const bySector = {};
  for (const r of rows) {
    if (r.d?.score != null && r.weight != null) { weightedScoreSum += r.d.score * r.weight; weightedScoreDenom += r.weight; }
    if (r.d?.sector && r.value != null) bySector[r.d.sector] = (bySector[r.d.sector] || 0) + r.value;
  }
  const weightedScore = weightedScoreDenom > 0 ? Math.round(weightedScoreSum / weightedScoreDenom) : null;
  const sectorRows = Object.entries(bySector)
    .map(([sector, value]) => ({ sector, pct: totalValue > 0 ? value / totalValue : 0 }))
    .sort((a, b) => b.pct - a.pct);

  const topHolding = rows.slice().sort((a, b) => (b.weight ?? 0) - (a.weight ?? 0))[0] ?? null;
  const concentrationRisk = topHolding && (topHolding.weight ?? 0) > 0.35;
  const sectorRisk = sectorRows[0] && sectorRows[0].pct > 0.5 ? sectorRows[0] : null;
  const sellSignals = rows.filter(r => r.d?.scoreLabel === 'Venta' || r.d?.scoreLabel === 'Reducir');

  // Los totales agregados de P&L se calculan por separado por moneda — sumar
  // ganancia en pesos con ganancia en dólares daría un número sin sentido.
  const usdRows = rows.filter(r => r.gainAbs != null && r.gainCurrency === 'USD');
  const arsRows = rows.filter(r => r.gainAbs != null && r.gainCurrency === 'ARS');
  const sumGain = (list) => list.reduce((s, r) => s + r.gainAbs, 0);
  const sumCost = (list) => list.reduce((s, r) => s + r.avgCost * r.shares, 0);
  const totalGainUsd = usdRows.length ? sumGain(usdRows) : null;
  const totalCostUsd = usdRows.length ? sumCost(usdRows) : null;
  const totalGainArs = arsRows.length ? sumGain(arsRows) : null;
  const totalCostArs = arsRows.length ? sumCost(arsRows) : null;

  return { rows, totalValue, weightedScore, sectorRows, topHolding, concentrationRisk, sectorRisk, sellSignals, totalGainUsd, totalCostUsd, totalGainArs, totalCostArs };
}

function portfolioRiskNotes(stats) {
  const notes = [];
  if (stats.concentrationRisk) notes.push({ type: 'risk', text: `${stats.topHolding.ticker} representa ${Math.round(stats.topHolding.weight * 100)}% de la cartera — concentración alta en un solo activo.` });
  if (stats.sectorRisk) notes.push({ type: 'risk', text: `El sector ${stats.sectorRisk.sector} concentra ${Math.round(stats.sectorRisk.pct * 100)}% de la cartera.` });
  if (stats.sellSignals.length) notes.push({ type: 'risk', text: `${stats.sellSignals.length} posición(es) con señal de Venta/Reducir: ${stats.sellSignals.map(r => r.ticker).join(', ')}.` });
  if (!notes.length && stats.rows.length) notes.push({ type: 'ok', text: 'Sin señales de concentración excesiva ni posiciones en zona de Venta/Reducir en este momento.' });
  return notes;
}

/** Recomendación accionable por posición: combina la señal de mercado
 *  (score compuesto del activo) con el P&L real de ESA tenencia — no es lo
 *  mismo "Compra Fuerte" en general que "Compra Fuerte" cuando ya estás
 *  parado en la posición y perdiendo, ganando, o recién por entrar. */
const RECO_TONE = {
  buy: { bg: 'oklch(0.32 0.11 152)', color: 'oklch(0.90 0.16 152)' },
  hold: { bg: 'oklch(0.30 0.09 70)', color: 'oklch(0.85 0.13 70)' },
  reduce: { bg: 'oklch(0.30 0.10 45)', color: 'oklch(0.85 0.14 45)' },
  sell: { bg: 'oklch(0.30 0.12 23)', color: 'oklch(0.88 0.16 23)' },
};

function portfolioRecommendation(r) {
  const reco = baseRecommendation(r);
  // El perfil de riesgo (Configuración) fija un tope real de peso por
  // posición — se compara contra r.weight, el peso REAL que ya tiene esa
  // tenencia en la cartera cargada, no un número inventado. Solo aplica
  // cuando el análisis técnico sugiere sumar (tone 'buy'): frena o confirma
  // esa sugerencia según cuánto margen quede hasta el tope del perfil.
  if (reco && reco.tone === 'buy' && r.weight != null) {
    const profile = RISK_PROFILES[settingsState.riskProfile] ?? RISK_PROFILES.moderado;
    const capPct = profile.maxPositionPct;
    const weightPct = r.weight * 100;
    if (weightPct >= capPct) {
      return { ...reco, detail: `${reco.detail} Ojo: esta posición ya pesa ${weightPct.toFixed(1)}% de tu cartera, en o por encima del tope de ${capPct}% de tu perfil ${profile.label} — el análisis técnico sugiere sumar, pero tu perfil sugiere no concentrar más acá.` };
    }
    return { ...reco, detail: `${reco.detail} Tu perfil ${profile.label} sugiere un tope de ${capPct}% por posición — hoy pesa ${weightPct.toFixed(1)}%, con margen para sumar hasta ${(capPct - weightPct).toFixed(1)} puntos porcentuales más.` };
  }
  return reco;
}

function baseRecommendation(r) {
  const signal = r.d?.scoreLabel;
  const gainPct = r.gainPct; // fracción (0.213 = +21.3%), null si no hay costo cargado
  if (!signal) return null;

  if (signal === 'Compra Fuerte') {
    if (gainPct == null) return { label: 'Comprar Fuerte', tone: 'buy', detail: 'Señal técnica y fundamental de compra fuerte sobre el activo.' };
    if (gainPct < 0) return { label: 'Promediar a la baja', tone: 'buy', detail: `Cotiza ${Math.abs(gainPct * 100).toFixed(1)}% por debajo de tu costo promedio con la señal en Compra Fuerte — oportunidad de bajar el costo promedio.` };
    return { label: 'Sumar posición', tone: 'buy', detail: 'Posición en ganancia y la señal se mantiene en Compra Fuerte — el análisis respalda ampliar.' };
  }
  if (signal === 'Compra Moderada') {
    if (gainPct == null) return { label: 'Comprar', tone: 'buy', detail: 'Señal de compra moderada sobre el activo.' };
    if (gainPct < -0.10) return { label: 'Promediar con cautela', tone: 'buy', detail: `Pérdida no realizada de ${Math.abs(gainPct * 100).toFixed(1)}% con señal de compra moderada — promediar en tramos, no de una vez.` };
    return { label: 'Mantener / sumar selectivo', tone: 'hold', detail: 'Señal de compra moderada — mantener la posición y evaluar sumar en retrocesos.' };
  }
  if (signal === 'Mantener') {
    return { label: 'Mantener', tone: 'hold', detail: 'El análisis no muestra una señal direccional fuerte de compra ni de venta.' };
  }
  if (signal === 'Reducir') {
    if (gainPct != null && gainPct > 0) return { label: 'Tomar ganancias parciales', tone: 'reduce', detail: `Posición en ganancia (+${(gainPct * 100).toFixed(1)}%) con la señal debilitándose — considerar realizar parte de la ganancia.` };
    return { label: 'Reducir exposición', tone: 'reduce', detail: 'La señal se debilitó — considerar reducir el tamaño de la posición.' };
  }
  // Venta
  if (gainPct != null && gainPct < 0) return { label: 'Cortar pérdida', tone: 'sell', detail: `Pérdida no realizada de ${Math.abs(gainPct * 100).toFixed(1)}% con señal de Venta — evaluar cortar para no profundizar la pérdida.` };
  if (gainPct != null && gainPct >= 0) return { label: 'Cerrar posición', tone: 'sell', detail: `Posición en ganancia (+${(gainPct * 100).toFixed(1)}%) pero la señal pasó a Venta — considerar cerrar y asegurar la ganancia.` };
  return { label: 'Evitar / no entrar', tone: 'sell', detail: 'Señal de Venta sobre el activo.' };
}

function sortPortfolioRows(rows) {
  const list = rows.slice();
  const val = (r, key) => {
    if (key === 'ticker') return r.ticker;
    if (key === 'score') return r.d?.score ?? -Infinity;
    if (key === 'gainPct') return r.gainPct ?? -Infinity;
    if (key === 'value') return r.value ?? -Infinity;
    return r.weight ?? -Infinity;
  };
  list.sort((a, b) => {
    if (portState.sortBy === 'ticker') return val(a, 'ticker').localeCompare(val(b, 'ticker'));
    return val(b, portState.sortBy) - val(a, portState.sortBy);
  });
  return list;
}

function holdingsToCsv(holdings) {
  const header = 'ticker,shares,avgCost,costCurrency';
  const lines = holdings.map(h => `${h.ticker},${h.shares},${h.avgCost ?? ''},${h.costCurrency ?? 'USD'}`);
  return [header, ...lines].join('\n');
}

function parseHoldingsCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const [ticker, shares, avgCost, costCurrency] = line.split(',').map(x => x?.trim());
    if (!ticker || ticker.toLowerCase() === 'ticker') continue; // salteo encabezado
    const sharesNum = parseFloat(shares);
    if (!sharesNum || sharesNum <= 0) continue;
    const costNum = avgCost ? parseFloat(avgCost) : null;
    out.push({ ticker: ticker.toUpperCase(), shares: sharesNum, avgCost: costNum != null && !isNaN(costNum) ? costNum : null, costCurrency: costCurrency === 'ARS' ? 'ARS' : 'USD' });
  }
  return out;
}

function portfolioHTML() {
  const holdings = getPortfolio();
  const stats = holdings.length ? computePortfolioStats(holdings) : null;
  const notes = stats ? portfolioRiskNotes(stats) : [];
  const loadingCount = holdings.filter(h => !portState.data[h.ticker]).length;
  const editingHolding = portState.editing ? holdings.find(h => h.ticker === portState.editing) : null;

  return `
    ${sectionTitleHTML('Portfolio Advisor', 'briefcase')}
    <div class="dash-intro">Cargá tus tenencias (ticker, cantidad y costo promedio opcional) para ver diversificación, concentración y señal de cada posición con datos reales. Si compraste CEDEARs en pesos, elegí "ARS (CEDEAR)" — el P&amp;L se compara contra el precio del CEDEAR en pesos (vía CCL), no contra el precio en dólares del subyacente. Se guarda solo en este navegador.</div>

    <div class="card port-form-card">
      ${editingHolding ? `<div class="port-editing-banner">Editando ${esc(editingHolding.ticker)} — <a href="#" id="port-edit-cancel">cancelar</a></div>` : ''}
      <div class="port-form">
        <input list="port-ticker-list" id="port-ticker" class="port-input" placeholder="Ticker (ej. AAPL)" autocomplete="off" style="text-transform:uppercase;" value="${editingHolding ? esc(editingHolding.ticker) : ''}" ${editingHolding ? 'readonly' : ''} />
        <datalist id="port-ticker-list">${universe.map(a => `<option value="${esc(a.ticker)}">${esc(a.name)}</option>`).join('')}</datalist>
        <input type="number" id="port-shares" class="port-input" placeholder="Cantidad" min="0" step="any" value="${editingHolding ? editingHolding.shares : ''}" />
        <input type="number" id="port-cost" class="port-input" placeholder="Costo promedio (opcional)" min="0" step="any" value="${editingHolding?.avgCost ?? ''}" />
        <select id="port-currency" class="port-input">
          <option value="USD" ${!editingHolding || editingHolding.costCurrency !== 'ARS' ? 'selected' : ''}>USD (acción/activo subyacente)</option>
          <option value="ARS" ${editingHolding?.costCurrency === 'ARS' ? 'selected' : ''}>ARS (CEDEAR en pesos)</option>
        </select>
        <button class="port-add-btn" id="port-add">${editingHolding ? 'Actualizar' : 'Agregar'}</button>
      </div>
    </div>

    <div class="port-table-controls">
      <button class="port-csv-btn" id="port-export">Exportar CSV</button>
      <button class="port-csv-btn" id="port-import">Importar CSV</button>
      <input type="file" id="port-import-file" accept=".csv,text/csv" style="display:none;" />
    </div>

    ${!holdings.length ? emptyStateHTML('briefcase', `Todavía no cargaste tenencias (máx. ${PORTFOLIO_MAX}). Podés empezar cargando una a la vez arriba, o importar un CSV (columnas: ticker,shares,avgCost,costCurrency).`) : `
    <div class="port-summary-grid">
      <div class="card port-summary-card">
        <div class="dash-radar-title">Valor total</div>
        <div class="port-summary-value">${fmtUsd(stats.totalValue)}</div>
        ${stats.totalGainUsd != null ? `<div class="port-summary-sub ${stats.totalGainUsd >= 0 ? 'up' : 'down'}">${stats.totalGainUsd >= 0 ? '+' : ''}${fmtUsd(stats.totalGainUsd)} (${fmtPct(stats.totalCostUsd > 0 ? (stats.totalGainUsd / stats.totalCostUsd) * 100 : 0)}) en posiciones con costo en USD</div>` : ''}
        ${stats.totalGainArs != null ? `<div class="port-summary-sub ${stats.totalGainArs >= 0 ? 'up' : 'down'}">${stats.totalGainArs >= 0 ? '+' : ''}${fmtArs(stats.totalGainArs)} (${fmtPct(stats.totalCostArs > 0 ? (stats.totalGainArs / stats.totalCostArs) * 100 : 0)}) en posiciones con costo en ARS</div>` : ''}
      </div>
      <div class="card port-summary-card">
        <div class="dash-radar-title">Score ponderado</div>
        <div class="port-summary-value">${stats.weightedScore ?? 'N/D'}</div>
        <div class="port-summary-sub">de 100, ponderado por peso en la cartera</div>
      </div>
      <div class="card port-summary-card">
        <div class="dash-radar-title">Posiciones</div>
        <div class="port-summary-value">${holdings.length}</div>
        <div class="port-summary-sub">${loadingCount > 0 ? `${loadingCount} cargando…` : 'todas actualizadas'}</div>
      </div>
    </div>

    <div class="card port-notes-card">
      <div class="dash-radar-title">Recomendación por posición</div>
      ${stats.rows.filter(r => r.d).map(r => {
        const reco = portfolioRecommendation(r);
        if (!reco) return '';
        const tone = RECO_TONE[reco.tone];
        return `
        <div class="port-reco-row">
          <span class="port-reco-ticker">${esc(r.ticker)}</span>
          <span class="watch-signal" style="background:${tone.bg}; color:${tone.color};">${esc(reco.label)}</span>
          <span class="port-reco-detail">${esc(reco.detail)}</span>
        </div>`;
      }).join('') || '<div class="dash-loading-note">Cargando análisis de cada posición…</div>'}
    </div>

    <div class="card port-notes-card">
      <div class="dash-radar-title">Lectura de diversificación</div>
      ${notes.map(n => `<div class="port-note ${n.type}">${n.type === 'risk' ? '⚠' : '✓'} ${esc(n.text)}</div>`).join('')}
    </div>

    ${stats.sectorRows.length ? `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Asignación por sector</div>
      ${stats.sectorRows.map(s => `
        <div class="score-row" style="grid-template-columns: 140px 1fr 50px;">
          <span class="score-label">${esc(s.sector)}</span>
          <div class="score-bar-bg"><div class="score-bar-fill" style="width:${Math.round(s.pct * 100)}%;"></div></div>
          <span class="score-fraction">${Math.round(s.pct * 100)}%</span>
        </div>`).join('')}
    </div>` : ''}

    <div class="port-table-controls">
      <select class="watch-select" id="port-sort">
        ${PORT_SORT_OPTIONS.map(o => `<option value="${o.key}" ${portState.sortBy === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
      </select>
    </div>

    <div class="port-table-wrap">
      <table class="port-table">
        <thead><tr><th>Ticker</th><th>Cantidad</th><th>Precio</th><th>Valor</th><th>Peso</th><th>P&amp;L</th><th>Señal</th><th>Recomendación</th><th></th></tr></thead>
        <tbody>
          ${sortPortfolioRows(stats.rows).map(r => portfolioRowHTML(r)).join('')}
        </tbody>
      </table>
    </div>`}
  `;
}

function portfolioRowHTML(r) {
  if (!r.d) {
    return `<tr data-port-ticker="${esc(r.ticker)}"><td>${esc(r.ticker)}</td><td>${r.shares}</td><td colspan="5"><span class="skel skel-line" style="width:80%; height:10px; display:inline-block;"></span></td><td></td><td><button class="port-remove" data-port-remove="${esc(r.ticker)}">×</button></td></tr>`;
  }
  const sig = scoreLabelColor(r.d.scoreLabel);
  const fmtGain = r.gainCurrency === 'ARS' ? fmtArs : fmtUsd;
  let pnlCell = '—';
  if (r.gainPct != null) {
    pnlCell = `${fmtPct(r.gainPct * 100)}<br><span class="port-pnl-abs">${r.gainAbs >= 0 ? '+' : ''}${fmtGain(r.gainAbs)}</span>`;
  } else if (r.gainUnavailableReason) {
    pnlCell = `<span title="${esc(r.gainUnavailableReason)}">N/D ⓘ</span>`;
  }
  const reco = portfolioRecommendation(r);
  const recoTone = reco ? RECO_TONE[reco.tone] : null;
  return `<tr class="port-row" data-port-ticker="${esc(r.ticker)}">
    <td class="port-ticker-cell">${esc(r.ticker)}${r.d.isReal === false ? ' <span class="watch-stale">demo</span>' : ''}${r.costCurrency === 'ARS' ? ' <span class="watch-stale">ARS</span>' : ''}</td>
    <td>${r.shares}</td>
    <td>${fmtUsd(r.d.price)}${r.costCurrency === 'ARS' && r.d.cedearArs != null ? `<br><span class="port-pnl-abs" title="${r.d.cedearSource === 'live' ? 'Precio real operado hoy en BYMA' : 'Estimado vía CCL — sin cotización real disponible para este símbolo'}">CEDEAR ${fmtArs(r.d.cedearArs)} ${r.d.cedearSource === 'live' ? '●' : '≈'}</span>` : ''}</td>
    <td>${r.value != null ? fmtUsd(r.value) : 'N/D'}</td>
    <td>${r.weight != null ? `${Math.round(r.weight * 100)}%` : 'N/D'}</td>
    <td class="${r.gainPct != null ? (r.gainPct >= 0 ? 'up' : 'down') : ''}">${pnlCell}</td>
    <td><span class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(r.d.scoreLabel)} · ${r.d.score}</span></td>
    <td>${reco ? `<span class="watch-signal" style="background:${recoTone.bg}; color:${recoTone.color};" title="${esc(reco.detail)}">${esc(reco.label)}</span>` : 'N/D'}</td>
    <td>
      <button class="port-edit" data-port-edit="${esc(r.ticker)}" title="Editar">✎</button>
      <button class="port-remove" data-port-remove="${esc(r.ticker)}" title="Quitar">×</button>
    </td>
  </tr>`;
}

function downloadTextFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
}

function wirePortfolioEvents() {
  els.report.querySelectorAll('[data-port-ticker]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.port-remove') || e.target.closest('.port-edit')) return;
      selectTicker(el.dataset.portTicker);
    });
  });
  els.report.querySelectorAll('.port-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = btn.dataset.portRemove;
      removeHolding(ticker);
      delete portState.data[ticker];
      if (portState.editing === ticker) portState.editing = null;
      showToast(`${ticker} eliminado de tu Portfolio`, 'info');
      renderReport();
    });
  });
  els.report.querySelectorAll('.port-edit').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      portState.editing = btn.dataset.portEdit;
      renderReport();
    });
  });
  const cancelEdit = document.getElementById('port-edit-cancel');
  if (cancelEdit) cancelEdit.addEventListener('click', (e) => {
    e.preventDefault();
    portState.editing = null;
    renderReport();
  });
  const addBtn = document.getElementById('port-add');
  if (addBtn) addBtn.addEventListener('click', () => {
    const tickerEl = document.getElementById('port-ticker');
    const sharesEl = document.getElementById('port-shares');
    const costEl = document.getElementById('port-cost');
    const currencyEl = document.getElementById('port-currency');
    const ticker = tickerEl.value.trim().toUpperCase();
    const shares = parseFloat(sharesEl.value);
    const cost = costEl.value ? parseFloat(costEl.value) : null;
    const currency = currencyEl?.value === 'ARS' ? 'ARS' : 'USD';
    if (!ticker || !shares || shares <= 0) return;
    const wasEditing = portState.editing != null;
    addHolding(ticker, shares, cost, currency);
    portState.editing = null;
    tickerEl.value = ''; sharesEl.value = ''; costEl.value = '';
    showToast(wasEditing ? `${ticker} actualizado en tu Portfolio` : `${ticker} agregado a tu Portfolio`, 'success');
    renderReport();
  });
  const sortSel = document.getElementById('port-sort');
  if (sortSel) sortSel.addEventListener('change', () => {
    portState.sortBy = sortSel.value;
    lsSetSafe('icp_port_sort', portState.sortBy);
    renderReport();
  });
  const exportBtn = document.getElementById('port-export');
  if (exportBtn) exportBtn.addEventListener('click', () => {
    downloadTextFile('portfolio.csv', holdingsToCsv(getPortfolio()), 'text/csv');
    showToast('CSV de tu Portfolio descargado', 'success');
  });
  const importBtn = document.getElementById('port-import');
  const importFile = document.getElementById('port-import-file');
  if (importBtn && importFile) {
    importBtn.addEventListener('click', () => importFile.click());
    importFile.addEventListener('change', async () => {
      const file = importFile.files?.[0];
      if (!file) return;
      const text = await file.text();
      const parsed = parseHoldingsCsv(text);
      for (const h of parsed) addHolding(h.ticker, h.shares, h.avgCost, h.costCurrency);
      importFile.value = '';
      showToast(`${parsed.length} tenencia(s) importada(s) desde CSV`, 'success');
      renderReport();
    });
  }
}

// Solo pide lo que todavía no tiene: renderReport() dispara esto en cada
// render mientras se está en la vista Portfolio, así que tiene que ser un
// no-op cuando no hay nada nuevo — si no, cada holding resuelto vuelve a
// llamar a renderReport(), que vuelve a llamar a esta función, en loop.
async function loadPortfolioData() {
  const holdings = getPortfolio();
  const missing = holdings.filter(h => !portState.data[h.ticker] && !portState.loading.has(h.ticker));
  if (!missing.length) return;
  const macro = await getMacro();
  await Promise.all(missing.map(async (h) => {
    portState.loading.add(h.ticker);
    try {
      portState.data[h.ticker] = await computeLightSignal(h.ticker, macro);
    } catch (e) {
      console.warn('[portfolio] no se pudo cargar', h.ticker, e.message);
    } finally {
      portState.loading.delete(h.ticker);
      if (!state.asset && (state.view === 'portfolio' || state.view === 'dashboard')) renderReport();
    }
  }));
}

function watchCardHTML(ticker) {
  const d = watchState.data[ticker];
  if (!d) {
    if (watchState.loading.has(ticker)) {
      return `<div class="watch-card" data-ticker="${esc(ticker)}">
        <button class="watch-remove" data-remove="${esc(ticker)}" title="Quitar">×</button>
        <div class="skel skel-line" style="width:50%; height:14px;"></div>
        <div class="skel skel-line" style="width:70%; height:10px;"></div>
        <div class="skel skel-line" style="width:60%; height:16px;"></div>
        <div class="skel skel-line" style="width:40%; height:10px;"></div>
        <div class="skel" style="width:80px; height:18px; border-radius:10px;"></div>
      </div>`;
    }
    return `<div class="watch-card" data-ticker="${esc(ticker)}">
      <button class="watch-remove" data-remove="${esc(ticker)}" title="Quitar">×</button>
      <div class="watch-ticker">${esc(ticker)}</div>
      <div class="watch-loading">Sin datos</div>
    </div>`;
  }
  const up = d.changePct >= 0;
  const sig = scoreLabelColor(d.scoreLabel);
  const am = d.alert ? ALERT_META[d.alert.type] : null;
  return `<div class="watch-card ${am ? 'has-alert' : ''}" data-ticker="${esc(ticker)}" style="${am ? `border-color:${am.color};` : ''}">
    <button class="watch-remove" data-remove="${esc(ticker)}" title="Quitar">×</button>
    <div class="watch-ticker">${esc(ticker)}${d.isReal === false ? ' <span class="watch-stale">demo</span>' : ''}</div>
    <div class="watch-name">${esc(d.name ?? '')}</div>
    <div class="watch-price">${fmtUsd(d.price)}</div>
    <div class="watch-change ${up ? 'up' : 'down'}">${fmtPct(d.changePct)}</div>
    <div class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(d.scoreLabel)} · ${d.score}</div>
    ${am ? `<div class="watch-alert" style="color:${am.color};">⚡ ${esc(am.label)}</div>` : ''}
  </div>`;
}

function watchlistPageHTML() {
  const allTickers = getWatchlist();
  if (!allTickers.length) {
    return `
      ${sectionTitleHTML('Watchlist', 'bookmark')}
      ${emptyStateHTML('bookmark', `Todavía no agregaste activos. Buscá uno y tocá la ☆ para tenerlo siempre a mano acá (máx. ${WATCHLIST_MAX}).`)}`;
  }
  const tickers = sortAndFilterTickers(allTickers);
  return `
    <div class="panel-header">
      ${sectionTitleHTML('Watchlist', 'bookmark', 'margin-bottom:0;')}
      <div class="watch-controls">
        <button class="watch-alerts-btn ${alertsEnabled ? 'on' : ''}" id="watch-alerts-toggle" title="Avisar cuando un activo entra en zona de compra/venta o toca el stop">
          ${alertsEnabled ? '🔔 Alertas activas' : '🔕 Activar alertas'}
        </button>
        <select class="watch-select" id="watch-sort">
          ${SORT_OPTIONS.map(o => `<option value="${o.key}" ${watchState.sortBy === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        <select class="watch-select" id="watch-filter">
          ${SIGNAL_FILTERS.map(s => `<option value="${esc(s)}" ${watchState.filterSignal === s ? 'selected' : ''}>${s === 'all' ? 'Todas las señales' : esc(s)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="watch-grid">
      ${!tickers.length ? `<div class="watch-empty">Ningún activo en seguimiento tiene la señal filtrada ahora mismo.</div>` : tickers.map(watchCardHTML).join('')}
    </div>`;
}

function wireWatchlistEvents() {
  els.report.querySelectorAll('.watch-card').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target.closest('.watch-remove')) return; selectTicker(el.dataset.ticker); });
  });
  els.report.querySelectorAll('.watch-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = btn.dataset.remove;
      toggleWatchlist(ticker);
      delete watchState.data[ticker];
      renderReport();
    });
  });

  const sortSel = document.getElementById('watch-sort');
  if (sortSel) sortSel.addEventListener('change', () => {
    watchState.sortBy = sortSel.value;
    lsSetSafe('icp_watch_sort', watchState.sortBy);
    renderReport();
  });
  const filterSel = document.getElementById('watch-filter');
  if (filterSel) filterSel.addEventListener('change', () => {
    watchState.filterSignal = filterSel.value;
    lsSetSafe('icp_watch_filter', watchState.filterSignal);
    renderReport();
  });
  const alertsBtn = document.getElementById('watch-alerts-toggle');
  if (alertsBtn) alertsBtn.addEventListener('click', toggleAlerts);
}

/** Página de Noticias & Macro: chips macro (ya reales, misma fuente que la
 *  ficha de cada activo) + noticias generales de mercado (no ligadas a un
 *  ticker puntual). */
const macroNewsState = { macro: null, news: null, loading: false, loadedAt: 0 };
function macroNewsPageHTML() {
  const macro = macroNewsState.macro;
  const news = macroNewsState.news;
  return `
    ${sectionTitleHTML('Noticias & Macro', 'globe')}
    <div class="dash-intro">Contexto macroeconómico y noticias generales del mercado — la misma fuente que se usa en cada ficha individual, acá agregada en una sola vista.</div>
    <div class="card macro-card" style="margin-bottom:28px;">
      ${macro ? macroChips(macro).map(mc => `<div class="macro-chip">${mc.live ? '<span class="macro-chip-live" title="En vivo"></span>' : ''}<span class="macro-chip-label">${esc(mc.label)}: </span><span class="macro-chip-value">${esc(mc.value)}</span>${typeof mc.live === 'string' ? ` <span class="macro-chip-var">(${esc(mc.live)})</span>` : ''}</div>`).join('') : `<div class="dash-loading-note">Cargando…</div>`}
    </div>
    ${sectionTitleHTML('Noticias generales', 'news', 'margin-top:8px;')}
    <div class="card news-card">
      ${!news ? `<div class="dash-loading-note">Cargando…</div>` : news.items?.length ? news.items.map(n => `
        <div class="news-item">
          <div class="news-tag" style="background:${n.bg}; color:${n.color};">${esc(n.tag)}</div>
          <div class="news-text">${esc(n.text)}${n.source ? ` <span class="news-source">— ${esc(n.source)}</span>` : ''}</div>
        </div>`).join('') : `<div class="news-empty">Sin noticias generales disponibles en este momento.</div>`}
    </div>`;
}
function wireMacroNewsEvents() { /* sin interacciones propias por ahora */ }
async function loadMacroNewsData() {
  if (macroNewsState.loading || Date.now() - macroNewsState.loadedAt < 3 * 60 * 1000) return;
  macroNewsState.loading = true;
  try {
    const [macro, news] = await Promise.all([getMacro(), getGeneralNews()]);
    macroNewsState.macro = macro;
    macroNewsState.news = news;
    macroNewsState.loadedAt = Date.now();
  } catch (e) {
    console.warn('[macro-news] no se pudo cargar', e.message);
  } finally {
    macroNewsState.loading = false;
    if (!state.asset && state.view === 'macro') renderReport();
  }
}

/** Página de Alertas: activos en seguimiento cuya señal de precio está
 *  activa ahora mismo (zona de compra/venta o stop) — deriva 100% de
 *  watchState.data, ya calculado por Seguimiento, sin pedidos propios. */
function alertsPageHTML() {
  const tickers = getWatchlist().filter(t => watchState.data[t]?.alert);
  return `
    ${sectionTitleHTML('Alertas', 'warning')}
    <div class="dash-intro">Activos en tu Watchlist que están, ahora mismo, en zona de compra, zona de venta o tocaron el stop loss según el análisis técnico. Activá las notificaciones del navegador desde Watchlist para recibir un aviso apenas cambie una señal.</div>
    ${!tickers.length ? `<div class="card watch-empty">Ningún activo en seguimiento tiene una alerta activa en este momento.</div>` : `
    <div class="watch-grid">${tickers.map(watchCardHTML).join('')}</div>`}`;
}
function wireAlertsEvents() {
  els.report.querySelectorAll('.watch-card').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target.closest('.watch-remove')) return; selectTicker(el.dataset.ticker); });
  });
  els.report.querySelectorAll('.watch-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = btn.dataset.remove;
      toggleWatchlist(ticker);
      delete watchState.data[ticker];
      renderReport();
    });
  });
}

/** Página de Backtesting: el usuario elige un ticker y corre runBacktest()
 *  sobre sus velas diarias reales — nada queda precalculado ni simulado. */
const backtestState = { ticker: '', loading: false, result: null, error: null };

function backtestPageHTML() {
  const r = backtestState.result;
  return `
    ${sectionTitleHTML('Backtesting', 'trend')}
    <div class="dash-intro">Probá cómo se comportó, históricamente, la misma señal que usa el análisis en vivo. Para cada corte de velas diarias reales se recalcula el score técnico (sin fundamentales, macro ni noticias históricas — no se inventan, se excluyen del cálculo) usando solo información disponible hasta ese día, y se mide el retorno real hacia adelante desde ese punto, agrupado por la señal vigente en ese momento.</div>
    <div class="card port-form-card">
      <div class="port-form">
        <input list="bt-ticker-list" id="bt-ticker" class="port-input" placeholder="Ticker (ej. AAPL)" autocomplete="off" style="text-transform:uppercase;" value="${esc(backtestState.ticker)}" />
        <datalist id="bt-ticker-list">${universe.map(a => `<option value="${esc(a.ticker)}">${esc(a.name)}</option>`).join('')}</datalist>
        <button class="port-add-btn" id="bt-run" ${backtestState.loading ? 'disabled' : ''}>${backtestState.loading ? 'Calculando…' : 'Correr backtest'}</button>
      </div>
    </div>
    ${backtestState.error ? `<div class="card watch-empty">${esc(backtestState.error)}</div>` : ''}
    ${!r ? '' : r.insufficientData ? `
      <div class="card watch-empty">Historial insuficiente para ${esc(r.ticker)}: hay ${r.candleCount} velas diarias disponibles y se necesitan al menos ${r.needed} (indicadores de largo plazo + horizonte de proyección) para un backtest confiable. Probá con un ticker con más historial cotizando.</div>
    ` : `
      <div class="card bt-meta-card">${esc(r.ticker)} — ${r.sampleCount} cortes históricos analizados, desde ${esc(r.from)} hasta ${esc(r.to)} (${r.candleCount} velas diarias reales)${r.isReal ? '' : ' · usando datos de caché (sin conexión en vivo al proveedor en este momento)'}</div>
      <div class="card bt-table-card">
        <div class="bt-table-wrap">
          <table class="bt-table">
            <thead><tr>
              <th>Señal</th><th>Ocurrencias</th>
              ${BACKTEST_HORIZONS.map(h => `<th>${h}d retorno prom.</th><th>${h}d win rate</th>`).join('')}
            </tr></thead>
            <tbody>
              ${r.rows.map(row => `
                <tr>
                  <td class="bt-label-cell"><span class="bt-label-dot" style="background:${scoreLabelColor(row.label).color}"></span>${esc(row.label)}</td>
                  <td>${row.occurrences}</td>
                  ${row.horizons.map(x => x.n ? `
                    <td class="${x.avgPct >= 0 ? 'bt-pos' : 'bt-neg'}">${x.avgPct >= 0 ? '+' : ''}${x.avgPct.toFixed(1)}%</td><td>${x.winRate}%</td>
                  ` : `<td class="bt-nd">—</td><td class="bt-nd">—</td>`).join('')}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
      <div class="bt-disclaimer">Resultado histórico calculado sobre datos reales, sin look-ahead (cada corte solo usa velas hasta ese día — nunca información futura). No es garantía de resultados futuros: las condiciones de mercado cambian y el tamaño de muestra puede ser chico en señales poco frecuentes (columna "Ocurrencias").</div>
    `}`;
}

function wireBacktestEvents() {
  const input = document.getElementById('bt-ticker');
  const runBtn = document.getElementById('bt-run');
  if (input) input.addEventListener('input', () => { backtestState.ticker = input.value.toUpperCase(); });
  if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') runBtn?.click(); });
  if (runBtn) runBtn.addEventListener('click', async () => {
    const ticker = (backtestState.ticker || input?.value || '').trim().toUpperCase();
    if (!ticker) return;
    backtestState.ticker = ticker;
    backtestState.loading = true;
    backtestState.error = null;
    backtestState.result = null;
    renderReport();
    try {
      const asset = await getAsset(ticker);
      if (!asset) { backtestState.error = `"${ticker}" no está en el universo cargado.`; return; }
      backtestState.result = await runBacktest(ticker);
      if (!backtestState.result.insufficientData) showToast(`Backtest de ${ticker} listo`, 'success');
    } catch (e) {
      backtestState.error = `No se pudo correr el backtest de ${ticker}: ${e.message}`;
      showToast(backtestState.error, 'error');
    } finally {
      backtestState.loading = false;
      if (!state.asset && state.view === 'backtest') renderReport();
    }
  });
}

/** Página de Calendario Económico: agrega la fecha de próximo balance (real,
 *  misma fuente Finnhub que ya se usa en la ficha de cada activo) de todos
 *  los tickers en Watchlist + Portfolio + universo curado del Dashboard, en
 *  una sola vista cronológica de los próximos 45 días. */
const CALENDAR_BATCH_SIZE = 10;
const CALENDAR_BATCH_DELAY_MS = 500;
const calendarState = { items: [], loading: false, loadedAt: 0, tickersDone: 0, tickersTotal: 0 };

function calendarUniverseTickers() {
  return Array.from(new Set([...getWatchlist(), ...getPortfolio().map(h => h.ticker), ...DASHBOARD_UNIVERSE]));
}

function earningsHourLabel(hour) {
  if (hour === 'bmo') return 'antes de la apertura';
  if (hour === 'amc') return 'después del cierre';
  if (hour === 'dmh') return 'en horario de mercado';
  return null;
}

async function loadCalendarData() {
  if (calendarState.loading || Date.now() - calendarState.loadedAt < 5 * 60 * 1000) return;
  calendarState.loading = true;
  calendarState.items = [];
  const tickers = calendarUniverseTickers();
  calendarState.tickersTotal = tickers.length;
  calendarState.tickersDone = 0;
  try {
    for (let i = 0; i < tickers.length; i += CALENDAR_BATCH_SIZE) {
      const batch = tickers.slice(i, i + CALENDAR_BATCH_SIZE);
      await Promise.all(batch.map(async (ticker) => {
        try {
          const [asset, earnings] = await Promise.all([getAsset(ticker), getEarnings(ticker)]);
          if (earnings?.nextDate) {
            const todayMidnight = new Date(new Date().toISOString().slice(0, 10) + 'T00:00:00Z');
            const days = Math.round((new Date(earnings.nextDate + 'T00:00:00Z') - todayMidnight) / 86400000);
            if (days >= 0) calendarState.items.push({ ticker, name: asset?.name ?? ticker, sector: asset?.sector ?? null, date: earnings.nextDate, hour: earnings.hour ?? null, days });
          }
        } catch (e) {
          console.warn('[calendario] earnings falló', ticker, e.message);
        } finally {
          calendarState.tickersDone++;
        }
      }));
      if (!state.asset && state.view === 'calendar') renderReport();
      if (i + CALENDAR_BATCH_SIZE < tickers.length) await new Promise(res => setTimeout(res, CALENDAR_BATCH_DELAY_MS));
    }
    calendarState.items.sort((a, b) => a.date.localeCompare(b.date) || a.ticker.localeCompare(b.ticker));
    calendarState.loadedAt = Date.now();
  } finally {
    calendarState.loading = false;
    if (!state.asset && state.view === 'calendar') renderReport();
  }
}

function calFormatDate(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const txt = d.toLocaleDateString('es-AR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' });
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function calendarPageHTML() {
  const items = calendarState.items;
  const grouped = [];
  for (const it of items) {
    if (!grouped.length || grouped[grouped.length - 1].date !== it.date) grouped.push({ date: it.date, items: [] });
    grouped[grouped.length - 1].items.push(it);
  }
  const loadingNote = calendarState.loading
    ? `<div class="dash-loading-note">Buscando fechas de balance… (${calendarState.tickersDone}/${calendarState.tickersTotal} activos revisados)</div>` : '';
  return `
    ${sectionTitleHTML('Calendario Económico', 'calendar')}
    <div class="dash-intro">Próximos reportes de balance (earnings) reales de los próximos 45 días para los activos en tu Watchlist, tu Portfolio y el universo curado del Dashboard — la misma fuente (Finnhub) que ya usa la fecha de earnings dentro de la ficha de cada activo, acá agregada en una sola vista cronológica.</div>
    ${loadingNote}
    ${!calendarState.loading && !items.length ? `<div class="card watch-empty">No hay reportes de balance confirmados en los próximos 45 días para los activos en seguimiento (Watchlist, Portfolio o universo del Dashboard).</div>` : ''}
    <div class="cal-list">
      ${grouped.map(g => `
        <div class="cal-group">
          <div class="cal-group-date">${esc(calFormatDate(g.date))} ${g.items[0].days === 0 ? '<span class="cal-today-badge">Hoy</span>' : g.items[0].days <= 5 ? `<span class="cal-soon-badge">en ${g.items[0].days} día${g.items[0].days === 1 ? '' : 's'}</span>` : ''}</div>
          <div class="cal-group-items">
            ${g.items.map(it => `
              <div class="cal-item" data-ticker="${esc(it.ticker)}">
                <div class="cal-item-main"><span class="cal-item-ticker">${esc(it.ticker)}</span><span class="cal-item-name">${esc(it.name)}</span></div>
                <div class="cal-item-meta">${it.sector ? `${esc(it.sector)} · ` : ''}${earningsHourLabel(it.hour) ? esc(earningsHourLabel(it.hour)) : 'horario no confirmado'}</div>
              </div>`).join('')}
          </div>
        </div>`).join('')}
    </div>`;
}

function wireCalendarEvents() {
  els.report.querySelectorAll('.cal-item').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.ticker));
  });
}

/** Score liviano (quote + candles diarios, sin fundamentales/noticias/semanal
 *  para no multiplicar requests) — usado tanto por Seguimiento como por el
 *  Dashboard, que recorren listas de tickers en paralelo. */
async function computeLightSignal(ticker, macro) {
  const asset = await getAsset(ticker);
  const [quote, candles] = await Promise.all([getQuote(ticker), getCandles(ticker, '1day', 220)]);
  const technical = computeTechnical(candles);
  const scoreResult = computeScore({
    technical, fundamentals: null,
    macro: { vix: macro?.vix ?? null, riesgoPaisArg: macro?.riesgoPaisArg ?? null, fearGreed: macro?.fearGreed ?? null },
    newsSentiment: null, candles,
  });
  const priceAlert = detectPriceAlert(quote.usd, technical);
  return {
    name: asset?.name ?? ticker, sector: asset?.sector ?? null, category: asset?.category ?? null,
    price: quote.usd, changePct: quote.changePct,
    cedearArs: quote.cedearArs ?? null, // precio del CEDEAR en pesos — null para cripto, que no tiene CEDEAR
    cedearSource: quote.cedearSource ?? null, // 'live' (precio real BYMA) | 'estimated' (vía CCL) | null
    score: scoreResult.score, scoreLabel: scoreResult.scoreLabel, isReal: quote.isReal && candles.isReal,
    alert: priceAlert,
    rsi: isNaN(technical.rsi) ? null : technical.rsi, // ya calculado acá — sin pedidos extra, para el Screener
    sparkline: candles.c.slice(-30), // últimos cierres reales, ya obtenidos acá — sin pedidos extra
    highlight: technicalHighlight(technical),
  };
}

/** Un solo motivo técnico real, el más relevante disponible — no una lista
 *  completa (esa vive en la ficha del activo), solo el titular para tarjetas
 *  compactas del Dashboard. */
function technicalHighlight(t) {
  if (t.divergence) return t.divergence.label;
  if (t.obvConfirms === false) return 'El volumen (OBV) no confirma el movimiento de precio.';
  if (!isNaN(t.rsi) && t.rsi > 70) return `RSI en ${t.rsi.toFixed(0)} — zona de sobrecompra.`;
  if (!isNaN(t.rsi) && t.rsi < 30) return `RSI en ${t.rsi.toFixed(0)} — zona de sobreventa.`;
  if (t.bullishAlign) return 'EMAs 20/50/100/200 alineadas en orden alcista.';
  if (t.bearishAlign) return 'EMAs 20/50/100/200 alineadas en orden bajista.';
  if (t.structure?.bullish != null) return t.structure.label;
  return t.priceAction?.short ?? 'Sin señal técnica destacada.';
}

// Seguimiento no tiene una sola página fija: alimenta Watchlist, Alertas y
// (más abajo) el widget "Watchlist Rápido" del Dashboard — se refresca la
// pantalla solo si alguna de esas vistas está activa en este momento.
function refreshIfWatchlistVisible() {
  if (!state.asset && (state.view === 'watchlist' || state.view === 'alerts' || state.view === 'dashboard')) renderReport();
}

async function loadWatchlistData() {
  const tickers = getWatchlist();
  const macro = await getMacro();
  await Promise.all(tickers.map(async (ticker) => {
    if (watchState.loading.has(ticker)) return;
    watchState.loading.add(ticker);
    refreshIfWatchlistVisible();
    try {
      const signal = await computeLightSignal(ticker, macro);
      notifyIfNewAlert(ticker, signal.alert);
      watchState.data[ticker] = signal;
    } catch (e) {
      console.warn('[watchlist] no se pudo cargar', ticker, e.message);
    } finally {
      watchState.loading.delete(ticker);
      refreshIfWatchlistVisible();
    }
  }));
}

// Lotes de 8 (no todo el universo junto): el free tier de Twelve Data
// comparte ~8 req/min entre todo el sitio, así que tirar 30 pedidos de
// golpe en un cache frío hace que varios caigan a demo por rate limit —
// justo lo que se quiere evitar. Entre lote y lote se espera un toque para
// repartir la carga en la ventana del minuto.
const DASHBOARD_BATCH_SIZE = 8;
const DASHBOARD_BATCH_DELAY_MS = 4000;

async function loadDashboardData() {
  dashState.started = true;
  const macro = await getMacro();
  const pending = DASHBOARD_UNIVERSE.filter(t => !dashState.data[t] && !dashState.loading.has(t));
  for (let i = 0; i < pending.length; i += DASHBOARD_BATCH_SIZE) {
    const batch = pending.slice(i, i + DASHBOARD_BATCH_SIZE);
    await Promise.all(batch.map(async (ticker) => {
      dashState.loading.add(ticker);
      if (!state.asset) renderReport(); // el dashboard solo se ve en la pantalla de inicio
      try {
        dashState.data[ticker] = await computeLightSignal(ticker, macro);
      } catch (e) {
        console.warn('[dashboard] no se pudo cargar', ticker, e.message);
      } finally {
        dashState.loading.delete(ticker);
        if (!state.asset) renderReport();
      }
    }));
    if (i + DASHBOARD_BATCH_SIZE < pending.length) await new Promise(res => setTimeout(res, DASHBOARD_BATCH_DELAY_MS));
  }
}

/* ───────────────────────── init ───────────────────────── */
renderTopbar();
renderReport();
initSearch();
loadWatchlistData();
document.getElementById('wordmark-home')?.addEventListener('click', () => {
  state.asset = null; state.report = null; state.error = null; state.loading = false;
  state.view = 'dashboard';
  els.tickerchip.textContent = '—';
  renderTopbar();
  renderReport();
});
setInterval(renderTopbar, 30 * 1000);
setInterval(() => { if (state.asset) renderReport(); }, 30 * 1000); // refresca textos de frescura sin re-fetch
// Ciclos espaciados a propósito: candles/fundamentales/noticias no cambian
// significativamente minuto a minuto, y Twelve Data free tier comparte ~8
// req/min entre todos los que estén usando el sitio a la vez.
setInterval(() => { if (state.asset) loadReport(state.asset.ticker); }, 180 * 1000);
setInterval(loadWatchlistData, 180 * 1000);
setInterval(() => { if (!state.asset) loadDashboardData(); }, 180 * 1000);
setInterval(() => { if (!state.asset && state.view === 'portfolio') { portState.data = {}; loadPortfolioData(); } }, 180 * 1000);
setInterval(() => { if (!state.asset && state.view === 'macro') loadMacroNewsData(); }, 180 * 1000);
