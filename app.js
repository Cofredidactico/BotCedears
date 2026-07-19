import { getUniverse, getAsset, getQuote, getCandles, getFundamentals, getNews, getGeneralNews, getMacro, getCCL, getCCLHistory, getEarnings, getInflacion, getDividends, getBonds, isLive } from './dataSource.js';
import { computeTechnical, resampleWeekly, weeklyConfluence, correlationAndBeta, relativeStrength as relStrength, monthlySeasonality, structureChanged, macd, rsi } from './indicators.js';
import { computeScore, computePlan, SECTOR_PE_RANGE, detectPriceAlert } from './scoring.js';
import { renderPriceChartSVG, renderRadarSVG, wireChartHover, renderCompareOverlaySVG } from './chart.js';
import { getWatchlist, isWatched, toggleWatchlist, WATCHLIST_MAX } from './watchlist.js';
import { getPortfolio, addHolding, removeHolding, PORTFOLIO_MAX } from './portfolio.js';

const GREEN = 'oklch(0.76 0.18 152)', AMBER = 'oklch(0.75 0.15 70)', RED = 'oklch(0.70 0.21 23)', BLUE = 'oklch(0.72 0.15 250)', GOLD = 'oklch(0.82 0.14 85)';

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
  sidebar: document.getElementById('app-sidebar'),
  sidebarScrim: document.getElementById('sidebar-scrim'),
  mobileNavToggle: document.getElementById('mobile-nav-toggle'),
  helpBtn: document.getElementById('help-btn'),
  onboardingOverlay: document.getElementById('onboarding-overlay'),
  assistantFab: document.getElementById('assistant-fab'),
  assistantPanel: document.getElementById('assistant-panel'),
};

/* ───────────────────────── sidebar móvil (cajón) ───────────────────────── */
function closeMobileSidebar() {
  els.sidebar?.classList.remove('open');
  els.sidebarScrim?.classList.remove('show');
  els.mobileNavToggle?.setAttribute('aria-expanded', 'false');
}
function openMobileSidebar() {
  els.sidebar?.classList.add('open');
  els.sidebarScrim?.classList.add('show');
  els.mobileNavToggle?.setAttribute('aria-expanded', 'true');
}
if (els.mobileNavToggle) {
  els.mobileNavToggle.addEventListener('click', () => {
    els.sidebar?.classList.contains('open') ? closeMobileSidebar() : openMobileSidebar();
  });
}
els.sidebarScrim?.addEventListener('click', closeMobileSidebar);
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMobileSidebar(); });

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
// Universo curado (no todo universe.json): rankear los ~238 tickers del
// universo completo en vivo en cada visita sigue sin tener sentido aunque
// el proveedor de velas (Alpaca, ver api/candles.js) tenga mucho más margen
// que el anterior — se eligió un subconjunto amplio, líquido y
// representativo de categorías (tech US, bancos/energía/salud/consumo US,
// ADRs argentinos, ETFs, cripto). Se carga en lotes (ver loadDashboardData)
// para repartir la carga entre visitantes concurrentes, no por un límite
// de 8 req/min como antes.
const DASHBOARD_UNIVERSE = [
  'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'META', 'AMZN', 'ORCL', 'CRM', 'ADBE', 'CSCO', 'SHOP',
  'AMD', 'TSM', 'INTC', 'QCOM', 'AVGO', 'MU',
  'JPM', 'V', 'MA', 'BAC', 'GS', 'WFC', 'PYPL', 'COIN',
  'XOM', 'CVX', 'COP', 'SLB', 'VIST',
  'JNJ', 'PFE', 'UNH', 'LLY', 'ABBV',
  'CAT', 'BA', 'GE', 'DE',
  'KO', 'WMT', 'NKE', 'SBUX', 'PG', 'MCD',
  'NFLX', 'DIS', 'T', 'VZ',
  'TSLA', 'F',
  'GOLD', 'VALE',
  'MELI', 'GGAL', 'BMA', 'YPF', 'PAM', 'CEPU', 'TGS', 'SUPV', 'IRS', 'CRESY', 'LOMA', 'EDN', 'BBAR', 'TEO', 'TS', 'CAAP', 'AGRO', 'BIOX', 'GLOB',
  'MSTR', 'RIOT', 'HUT', 'IREN', 'IBIT', 'ETHA',
  'SPY', 'QQQ', 'GLD', 'DIA',
  'BTC', 'ETH',
];
// Paneles temáticos: ADRs argentinos (empresas argentinas con cotización real
// en NYSE/Nasdaq) y activos relacionados con cripto (CEDEARs de empresas
// bitcoin-céntricas + ETFs spot + exchanges/brokers con exposición directa).
const AR_TICKERS = new Set(['GGAL', 'BMA', 'SUPV', 'BBAR', 'YPF', 'PAM', 'CEPU', 'VIST', 'EDN', 'LOMA', 'TGS', 'TEO', 'CRESY', 'IRS', 'AGRO', 'CAAP', 'DESP', 'GLOB', 'BIOX', 'MELI', 'TS', 'TX', 'ARCO', 'SATL']);
const CRYPTO_RELATED = new Set(['BTC', 'ETH', 'MSTR', 'RIOT', 'HUT', 'IREN', 'COIN', 'IBIT', 'ETHA']);
const dashState = { data: {}, loading: new Set(), started: false, macro: null, ccl: null };
// Subconjunto del universo del dashboard para el widget "Mercado Hoy" del
// sidebar — reusa dashState.data, no dispara requests propios.
const SIDEBAR_MARKET_TICKERS = ['SPY', 'QQQ', 'MELI', 'GGAL', 'BTC'];

/* ───────────────────────── dashboard personalizable ───────────────────────── */
const DASH_WIDGETS = [
  { key: 'opportunities', label: 'Oportunidades del Día' },
  { key: 'buyzone', label: 'En Zona de Compra Ahora' },
  { key: 'argentina', label: 'Panel Argentina' },
  { key: 'cripto', label: 'Termómetro Cripto' },
  { key: 'heatmap', label: 'Heatmap Sectorial' },
  { key: 'radar', label: 'Radar del Mercado' },
  { key: 'watchlist', label: 'Watchlist Rápido' },
  { key: 'portfolio', label: 'Mi Portfolio' },
];
const DASH_WIDGET_KEYS = DASH_WIDGETS.map(w => w.key);
function loadDashWidgetOrder() {
  const saved = lsGetSafe('icp_dash_order', '').split(',').filter(k => DASH_WIDGET_KEYS.includes(k));
  const missing = DASH_WIDGET_KEYS.filter(k => !saved.includes(k));
  return [...saved, ...missing];
}
function loadDashWidgetHidden() {
  return new Set(lsGetSafe('icp_dash_hidden', '').split(',').filter(k => DASH_WIDGET_KEYS.includes(k)));
}
const dashWidgetState = { order: loadDashWidgetOrder(), hidden: loadDashWidgetHidden(), customizeOpen: false };
function saveDashWidgetState() {
  lsSetSafe('icp_dash_order', dashWidgetState.order.join(','));
  lsSetSafe('icp_dash_hidden', [...dashWidgetState.hidden].join(','));
}

/* ───────────────────────── portfolio advisor ───────────────────────── */
const portState = {
  data: {}, loading: new Set(), sortBy: lsGetSafe('icp_port_sort', 'weight'), editing: null,
  macro: null, inflacion: null, ccl: null,
  spy: null, // cierres de SPY para beta/benchmark de la cartera
  cclHistory: null, // serie histórica del CCL (argentinadatos) para medir la cartera en dólares reales
  dividends: {}, // ticker -> historial de dividendos, para el yield agregado de la cartera
  compact: lsGetSafe('icp_port_compact', '0') === '1',
  privacy: lsGetSafe('icp_port_privacy', '0') === '1',
  allocAmount: '', allocResult: null, // asignador "¿qué compro con AR$X?"
  tab: 'resumen', // pestaña activa de la Radiografía de Cartera
  stressShock: null, // shock de mercado elegido en el panel de estrés (o null)
  optMode: 'minvar', // criterio del optimizador de cartera
};
const taxState = { cumplidor: lsGetSafe('icp_tax_cumplidor', '0') === '1' };
function lsSetSafe(key, value) { try { localStorage.setItem(key, value); } catch { /* no disponible */ } }

/* ───────────────────────── onboarding guiado ───────────────────────── */
const ONBOARDING_STEPS = [
  {
    title: 'Bienvenido a Investment Copilot AI',
    body: 'Una mesa de análisis con datos de mercado reales (Finnhub, Twelve Data, dolarapi, CoinGecko, BYMA) para acciones, CEDEARs, ETFs y cripto. No es un asesor con IA que "opina": cada número que ves sale de un cálculo trazable sobre datos reales.',
  },
  {
    title: 'Score compuesto (0–100)',
    body: 'Combina técnico (medias, RSI, MACD, volumen), fundamental (valuación relativa al sector) y contexto macro (riesgo país, Fear & Greed) en un solo número. Arriba de 60 tiende a favorable, abajo de 40 tiende a desfavorable — nunca es una garantía.',
  },
  {
    title: 'Plan operativo',
    body: 'Para cada activo armamos zonas de entrada, stop-loss y objetivo basadas en soportes/resistencias reales del gráfico, no en un número inventado. Es información para decidir vos, no una orden de compra/venta.',
  },
  {
    title: 'Señales técnicas y divergencias',
    body: 'RSI, MACD, cruces de medias, confirmación por volumen (OBV) y divergencias precio/indicador quedan marcadas directamente sobre el gráfico y en las tarjetas de indicadores.',
  },
  {
    title: 'Portfolio Advisor',
    body: 'Cargá tus tenencias reales (en ARS o USD, con fecha de compra) y obtené P&L, retorno ajustado por inflación, riesgo de la cartera (volatilidad, drawdown, Sharpe), impacto fiscal estimado y recomendaciones puntuales por holding.',
  },
  {
    title: 'Datos reales, sin inventar',
    body: 'Cuando una fuente en vivo falla o está degradada, la plataforma lo dice explícitamente en vez de mostrar un número simulado como si fuera real. Si ves un aviso de "datos de respaldo", es justamente por eso.',
  },
];
const onboardingState = { step: 0 };
function closeOnboarding(markSeen = true) {
  if (!els.onboardingOverlay) return;
  els.onboardingOverlay.style.display = 'none';
  els.onboardingOverlay.innerHTML = '';
  if (markSeen) lsSetSafe('icp_onboarding_seen', '1');
}
function renderOnboarding() {
  if (!els.onboardingOverlay) return;
  const step = ONBOARDING_STEPS[onboardingState.step];
  const isLast = onboardingState.step === ONBOARDING_STEPS.length - 1;
  const isFirst = onboardingState.step === 0;
  els.onboardingOverlay.innerHTML = `
    <div class="onboarding-card">
      <button class="onboarding-close" id="onboarding-close" aria-label="Cerrar guía">✕</button>
      <div class="onboarding-dots">
        ${ONBOARDING_STEPS.map((_, i) => `<span class="onboarding-dot ${i === onboardingState.step ? 'active' : ''}"></span>`).join('')}
      </div>
      <h2 class="onboarding-title" id="onboarding-title">${esc(step.title)}</h2>
      <p class="onboarding-body">${esc(step.body)}</p>
      <div class="onboarding-actions">
        <button class="onboarding-btn onboarding-btn-ghost" id="onboarding-skip">${isLast ? 'Cerrar' : 'Saltar'}</button>
        <div class="onboarding-actions-right">
          ${!isFirst ? `<button class="onboarding-btn onboarding-btn-ghost" id="onboarding-back">Atrás</button>` : ''}
          <button class="onboarding-btn onboarding-btn-primary" id="onboarding-next">${isLast ? 'Empezar' : 'Siguiente'}</button>
        </div>
      </div>
    </div>`;
  els.onboardingOverlay.style.display = 'flex';
  document.getElementById('onboarding-close')?.addEventListener('click', () => closeOnboarding(true));
  document.getElementById('onboarding-skip')?.addEventListener('click', () => closeOnboarding(true));
  document.getElementById('onboarding-back')?.addEventListener('click', () => { onboardingState.step = Math.max(0, onboardingState.step - 1); renderOnboarding(); });
  document.getElementById('onboarding-next')?.addEventListener('click', () => {
    if (isLast) { closeOnboarding(true); return; }
    onboardingState.step = Math.min(ONBOARDING_STEPS.length - 1, onboardingState.step + 1);
    renderOnboarding();
  });
}
function showOnboarding() {
  onboardingState.step = 0;
  renderOnboarding();
}
els.helpBtn?.addEventListener('click', () => showOnboarding());
els.onboardingOverlay?.addEventListener('click', (e) => { if (e.target === els.onboardingOverlay) closeOnboarding(true); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && els.onboardingOverlay?.style.display === 'flex') closeOnboarding(true);
});

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
  structure: { label: 'Cambio de estructura', color: BLUE },
  exdiv: { label: 'Ex-dividend próximo', color: GOLD },
};
const ALERT_CONFIDENCE_LABEL = { alta: 'confianza alta', media: 'confianza media', baja: 'confianza baja' };
// El stop es gestión de riesgo incondicional (no pasa por el filtro de
// confirmaciones), por eso no muestra sufijo de confianza.
function alertConfidenceSuffix(a) {
  if (!a || a.type === 'stop' || a.type === 'structure') return '';
  if (a.pending) return ` <span class="alert-confidence tentativa">tentativa</span>`;
  return ` <span class="alert-confidence ${esc(a.confidence)}">${esc(ALERT_CONFIDENCE_LABEL[a.confidence] ?? a.confidence)}</span>`;
}
function alertTitleAttr(a) {
  return a?.confirmations?.length ? ` title="${esc(a.confirmations.join(' · '))}"` : '';
}
let alertsEnabled = lsGetSafe('icp_alerts_enabled', '0') === '1';
const lastAlertByTicker = {}; // ticker -> 'buy'|'sell'|'stop'|null, para notificar solo en la transición
const lastStructureByTicker = {}; // ticker -> structure.short ('BOS alcista'|'BOS bajista'|'CHoCH'|'Rango'), para notificar solo en el cambio

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

// Historial de alertas disparadas: solo lo que este navegador observó con
// la pestaña abierta (mismo alcance que las notificaciones del navegador —
// no reemplaza el historial de mensajes de Telegram, que ya vive en el
// propio chat del usuario).
const ALERT_HISTORY_KEY = 'icp_alert_history';
const ALERT_HISTORY_MAX = 50;
function getAlertHistory() {
  try { return JSON.parse(localStorage.getItem(ALERT_HISTORY_KEY) || '[]'); } catch { return []; }
}
function logAlertHistory(ticker, type, confidence, confirmations) {
  const list = getAlertHistory();
  list.unshift({ ticker, type, confidence: confidence ?? null, confirmations: confirmations ?? [], ts: Date.now() });
  lsSetSafe(ALERT_HISTORY_KEY, JSON.stringify(list.slice(0, ALERT_HISTORY_MAX)));
}
function clearAlertHistory() {
  lsSetSafe(ALERT_HISTORY_KEY, '[]');
  showToast('Historial de alertas borrado', 'info');
  renderReport();
}

function notifyIfNewAlert(ticker, priceAlert) {
  const curr = priceAlert?.type ?? null;
  const isStrong = curr && !priceAlert.pending && (priceAlert.confidence === 'alta' || priceAlert.confidence === 'media');
  const prev = lastAlertByTicker[ticker] ?? null;
  if (isStrong) lastAlertByTicker[ticker] = curr;
  else if (!curr) lastAlertByTicker[ticker] = null;
  if (!alertsEnabled || !isStrong || curr === prev) return;
  logAlertHistory(ticker, curr, priceAlert.confidence, priceAlert.confirmations);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  const meta = ALERT_META[curr];
  new Notification(`${ticker}: ${meta.label}`, { body: `Investment Copilot AI — confianza ${priceAlert.confidence} (${priceAlert.confirmations.join(', ')})`, tag: `icp-${ticker}` });
}

/** Ruptura de estructura (BOS/CHoCH, ver marketStructure en indicators.js):
 *  una señal independiente de las zonas de precio — un cambio de estructura
 *  puede anticipar un giro de tendencia antes de que el precio llegue a un
 *  soporte/resistencia. Solo navegador por ahora: no está conectada al cron
 *  de Telegram (quedó fuera de este alcance para no abrir otro frente en la
 *  misma tanda). */
function notifyStructureChange(ticker, structure) {
  const prevShort = lastStructureByTicker[ticker] ?? null;
  const changed = structureChanged(prevShort, structure);
  if (structure?.short) lastStructureByTicker[ticker] = structure.short;
  if (!alertsEnabled || !changed) return;
  logAlertHistory(ticker, 'structure', null, [structure.label]);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  new Notification(`${ticker}: cambio de estructura`, { body: structure.label, tag: `icp-structure-${ticker}` });
}

// Aviso de ex-dividend próximo (≤ EXDIV_ALERT_DAYS) para una tenencia, una
// sola vez por combinación (ticker, fecha ex) — se recuerda en localStorage
// para no repetir el aviso en cada refresco.
const EXDIV_ALERT_DAYS = 4;
const EXDIV_NOTIFIED_KEY = 'icp_exdiv_notified';
function notifyExDividend(ticker, div) {
  if (!alertsEnabled || !div?.nextExDate) return;
  const days = daysUntil(div.nextExDate);
  if (days == null || days < 0 || days > EXDIV_ALERT_DAYS) return;
  let seen;
  try { seen = JSON.parse(localStorage.getItem(EXDIV_NOTIFIED_KEY) || '{}'); } catch { seen = {}; }
  const key = `${ticker}:${div.nextExDate}`;
  if (seen[key]) return;
  seen[key] = Date.now();
  lsSetSafe(EXDIV_NOTIFIED_KEY, JSON.stringify(seen));
  logAlertHistory(ticker, 'exdiv', null, [`Ex-dividend estimado ${div.nextExDate}${div.lastAmount != null ? ` · ${fmtUsd(div.lastAmount)}` : ''}`]);
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return;
  new Notification(`${ticker}: ex-dividend en ${days === 0 ? 'hoy' : days + ' día(s)'}`, { body: `Para cobrar el dividendo tenés que tener ${ticker} antes del ${div.nextExDate} (estimado)`, tag: `icp-exdiv-${ticker}` });
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

/* ───────────────────────── alertas por Telegram (fuera del navegador) ───────────────────────── */
// El chat_id vinculado hace las veces de "cuenta" (esta plataforma no tiene
// login) — se guarda en localStorage y todas las suscripciones del lado del
// servidor (Redis, ver alertsStore.js) quedan indexadas por ese chat_id.
const telegramState = {
  chatId: lsGetSafe('icp_telegram_chat_id', ''),
  botUsername: null, configured: null, // null = todavía no se consultó /api/alerts?action=config
  linking: false, code: null, pollTimer: null, pollDeadline: 0,
  subscriptions: [], subsLoaded: false, subsLoading: false,
};

async function loadTelegramConfig() {
  try {
    const d = await (await fetch('/api/alerts?action=config')).json();
    telegramState.configured = Boolean(d.configured);
    telegramState.botUsername = d.botUsername;
  } catch (_) {
    telegramState.configured = false;
  }
  if (state.view === 'alerts' && !state.asset) renderReport();
}

async function loadTelegramSubscriptions() {
  if (!telegramState.chatId) return;
  telegramState.subsLoading = true;
  try {
    const d = await (await fetch(`/api/alerts?action=subscriptions&chatId=${encodeURIComponent(telegramState.chatId)}`)).json();
    telegramState.subscriptions = Array.isArray(d.tickers) ? d.tickers : [];
    telegramState.subsLoaded = true;
  } catch (e) {
    console.warn('[telegram] no se pudieron cargar las suscripciones', e.message);
  } finally {
    telegramState.subsLoading = false;
    if (state.view === 'alerts' && !state.asset) renderReport();
  }
}

function stopTelegramPolling() {
  if (telegramState.pollTimer) clearInterval(telegramState.pollTimer);
  telegramState.pollTimer = null;
}

function startTelegramLink() {
  const code = Array.from({ length: 6 }, () => 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'[Math.floor(Math.random() * 32)]).join('');
  telegramState.code = code;
  telegramState.linking = true;
  telegramState.pollDeadline = Date.now() + 5 * 60 * 1000; // 5 min: tiempo razonable para abrir Telegram y tocar Start
  stopTelegramPolling();
  telegramState.pollTimer = setInterval(async () => {
    if (Date.now() > telegramState.pollDeadline) { stopTelegramPolling(); telegramState.linking = false; renderReport(); return; }
    try {
      const d = await (await fetch(`/api/alerts?action=link-status&code=${code}`)).json();
      if (d.chatId) {
        stopTelegramPolling();
        telegramState.chatId = d.chatId;
        telegramState.linking = false;
        lsSetSafe('icp_telegram_chat_id', d.chatId);
        showToast('Telegram vinculado correctamente', 'success');
        loadTelegramSubscriptions();
        renderReport();
      }
    } catch (_) { /* red intermitente: se reintenta en el próximo tick */ }
  }, 3000);
  renderReport();
}

function cancelTelegramLink() {
  stopTelegramPolling();
  telegramState.linking = false;
  telegramState.code = null;
  renderReport();
}

function unlinkTelegram() {
  telegramState.chatId = '';
  telegramState.subscriptions = [];
  telegramState.subsLoaded = false;
  lsSetSafe('icp_telegram_chat_id', '');
  showToast('Telegram desvinculado', 'info');
  renderReport();
}

async function toggleTelegramSubscription(ticker) {
  if (!telegramState.chatId) return;
  const isSubbed = telegramState.subscriptions.includes(ticker);
  const action = isSubbed ? 'remove' : 'add';
  // Optimista: refleja el cambio ya, y revierte si el servidor lo rechaza —
  // se ve instantáneo en la UI en vez de esperar el round-trip.
  telegramState.subscriptions = isSubbed ? telegramState.subscriptions.filter(t => t !== ticker) : [...telegramState.subscriptions, ticker];
  renderReport();
  try {
    const r = await fetch('/api/alerts?action=subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chatId: telegramState.chatId, ticker, action }),
    });
    if (!r.ok) throw new Error('rechazado por el servidor');
    showToast(isSubbed ? `Avisos por Telegram desactivados para ${ticker}` : `Te vamos a avisar por Telegram cuando ${ticker} cambie de zona`, 'info');
  } catch (e) {
    telegramState.subscriptions = isSubbed ? [...telegramState.subscriptions, ticker] : telegramState.subscriptions.filter(t => t !== ticker);
    showToast('No se pudo actualizar la alerta, probá de nuevo', 'error');
    renderReport();
  }
}

const CHART_TABS = [
  { key: '45min', label: '45m' },
  { key: '4h', label: '4H' },
  { key: '1day', label: '1D' },
  { key: '1week', label: '1S' },
  { key: '1month', label: '1M' },
  { key: '1year', label: '1A' },
  { key: '5year', label: '5A' },
];
// '1year'/'5year' no son intervalos de vela reales (no existe una "vela de
// un año") — son presets de zoom que piden velas más gruesas (semanales/
// mensuales) con más historial, mismo patrón que usan las plataformas de
// referencia para las pestañas de rango largo.
const CHART_TAB_API = {
  '1month': { interval: '1month', n: 36 },  // ~3 años de velas mensuales
  '1year': { interval: '1week', n: 56 },    // ~1 año+ de velas semanales
  '5year': { interval: '1month', n: 62 },   // ~5 años de velas mensuales
};
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
      studies: ['RSI@tv-basicstudies', 'MACD@tv-basicstudies', 'BB@tv-basicstudies', 'Stochastic@tv-basicstudies'],
    });
  } catch (e) {
    if (document.getElementById(containerId)) el.innerHTML = `<div class="chart-empty">${esc(e.message)}</div>`;
  }
}

/** Gauge "Análisis Técnico" oficial de TradingView (Strong Buy/Buy/Neutral/
 *  Sell/Strong Sell), calculado por ellos en vivo sobre osciladores y medias
 *  móviles — un segundo indicador profesional siempre en vivo, distinto del
 *  motor propio, para el mismo símbolo. Es un widget "auto-inicializable":
 *  el <script> lee su propio texto como config JSON al cargar, así que hay
 *  que crearlo con document.createElement (innerHTML no ejecuta <script>). */
function mountTradingViewTAWidget(containerId, symbol) {
  const el = document.getElementById(containerId);
  if (!el) return;
  el.innerHTML = '';
  const script = document.createElement('script');
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-technical-analysis.js';
  script.async = true;
  script.type = 'text/javascript';
  script.text = JSON.stringify({
    interval: '1D', width: '100%', isTransparent: true, height: '100%',
    symbol, showIntervalTabs: true, displayMode: 'single', locale: 'es', colorTheme: 'dark',
  });
  el.appendChild(script);
}

function chartCardBody(dailyTechnical, plan) {
  const tf = chartState.tf;
  const entry = chartState.cache[tf];
  if (chartState.loading.has(tf) && !entry) return `<div class="skel skel-chart"></div>`;
  if (!entry) return `<div class="chart-empty">Sin datos para este timeframe todavía.</div>`;
  // En modo live, si el proveedor de velas falló y se cayó a datos simulados,
  // no se dibuja el gráfico: mostrarlo con una nota chica al pie no evita que
  // el precio/escala fake se confunda con el real (el motivo de este fix).
  // En ?mode=mock (prueba local explícita) sí se muestra, como siempre.
  if (entry.isReal === false && isLive()) {
    return `<div class="chart-empty chart-empty-degraded">Gráfico no disponible en este momento — el proveedor de velas no respondió o alcanzó su límite diario. No se muestra un gráfico simulado para no confundirlo con datos reales. Probá la pestaña <strong>Análisis Libre (TradingView)</strong> arriba, o volvé a intentar en unos minutos.</div>`;
  }
  const svg = renderPriceChartSVG(entry.candles, { support: dailyTechnical.support, resistance: dailyTechnical.resistance, plan: plan?.raw });
  const staleNote = entry.isReal === false ? `<div class="chart-stale">Datos de demostración — modo de prueba local.</div>` : '';
  return svg + staleNote;
}

/** Columna al lado del gráfico de TradingView (siempre en vivo): el gauge
 *  Análisis Técnico oficial de TradingView (segunda opinión, en vivo, sobre
 *  el mismo símbolo) + tu plan operativo propio, para comparar ambos sin
 *  salir de la pestaña. Si el plan quedó calculado sobre datos de respaldo
 *  (degradedCandles), se avisa explícito en vez de mostrarlo como si fuera
 *  en vivo. */
function tvSidePanelHTML(plan, degradedCandles) {
  return `
    <div class="tv-side">
      <div class="tv-side-block">
        <div class="tv-side-title"><span class="tv-live-dot"></span>Análisis Técnico de TradingView</div>
        <div id="tv-ta-widget" class="tv-ta-widget"></div>
      </div>
      <div class="tv-side-block">
        <div class="tv-side-title">Tu Plan Operativo</div>
        ${degradedCandles ? `<div class="tv-side-degraded">Calculado sobre el último dato disponible, no en vivo — el proveedor de velas no respondió recién.</div>` : ''}
        <div class="tv-plan-compact">
          <div class="tv-plan-row"><span>Zona de compra</span><span class="plan-chip buy small">${esc(plan.compra)}</span></div>
          <div class="tv-plan-row"><span>Zona de venta</span><span class="plan-chip sell small">${esc(plan.venta)}</span></div>
          <div class="tv-plan-row"><span>Stop loss</span><span class="plan-chip stop small">${esc(plan.stopLoss)}</span></div>
          <div class="tv-plan-row"><span>Objetivos</span><span class="tv-plan-tp">${esc(plan.tp1)} · ${esc(plan.tp2)} · ${esc(plan.tp3)}</span></div>
          <div class="tv-plan-row"><span>Risk/Reward</span><span>${esc(plan.riskReward)}</span></div>
        </div>
      </div>
    </div>`;
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
      const mapped = CHART_TAB_API[tf];
      const apiInterval = mapped?.interval ?? tf;
      const n = mapped?.n ?? (tf === '1week' ? 130 : tf === '4h' ? 240 : tf === '45min' ? 220 : 220);
      const res = await getCandles(ticker, apiInterval, n);
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
  flag: `<svg ${ICON_ATTR}><line x1="5" y1="3" x2="5" y2="21"/><path d="M5 4.5h13l-3 4 3 4H5"/></svg>`,
  coins: `<svg ${ICON_ATTR}><ellipse cx="8" cy="6" rx="5.5" ry="2.6"/><path d="M2.5 6v5c0 1.4 2.5 2.6 5.5 2.6"/><path d="M2.5 11v5c0 1.4 2.5 2.6 5.5 2.6"/><ellipse cx="16" cy="14" rx="5.5" ry="2.6"/><path d="M10.5 14v5c0 1.4 2.5 2.6 5.5 2.6s5.5-1.2 5.5-2.6v-5"/></svg>`,
  zap: `<svg ${ICON_ATTR}><polygon points="13,2 4,14 11,14 10,22 20,9 13,9"/></svg>`,
  gap: `<svg ${ICON_ATTR}><line x1="3" y1="15" x2="9" y2="15"/><line x1="9" y1="15" x2="9" y2="7"/><line x1="9" y1="7" x2="15" y2="7"/><line x1="15" y1="7" x2="15" y2="18"/><line x1="15" y1="18" x2="21" y2="18"/><polyline points="12,4 15,7 12,10" opacity="0.55"/></svg>`,
  award: `<svg ${ICON_ATTR}><circle cx="12" cy="9" r="6"/><path d="M8.5 14L7 22l5-3 5 3-1.5-8"/></svg>`,
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
  shuffle: `<svg ${ICON_ATTR}><path d="M3 6h3.5c2.5 0 3.8 1.6 5 3.5"/><path d="M11.5 14.5c1.2 1.9 2.5 3.5 5 3.5H21"/><polyline points="17.5,4.5 21,6 17.5,7.5"/><polyline points="17.5,15 21,16.5 17.5,18"/><path d="M3 18h3.5c2.5 0 3.8-1.6 5-3.5"/><path d="M11.5 9.5C12.7 7.6 14 6 16.5 6"/></svg>`,
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
        <button class="star-btn" data-star="${esc(a.ticker)}" title="${isWatched(a.ticker) ? 'Quitar de seguimiento' : 'Agregar a seguimiento'}" aria-label="${isWatched(a.ticker) ? 'Quitar ' + esc(a.ticker) + ' de seguimiento' : 'Agregar ' + esc(a.ticker) + ' a seguimiento'}" aria-pressed="${isWatched(a.ticker)}">${isWatched(a.ticker) ? '★' : '☆'}</button>
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
    // Beta/correlación vs Bitcoin: solo para activos relacionados con cripto
    // (CEDEARs de mineras/tenedoras y ETFs spot) — BTC se cachea 60s en
    // dataSource, así que no multiplica requests al mirar varios seguidos.
    const wantsBtcBeta = CRYPTO_RELATED.has(ticker) && ticker !== 'BTC';
    const [quote, candles, fundamentals, news, macro, ccl, weeklyNative, spyCandles, btcCandles, earnings, dividends] = await Promise.all([
      getQuote(ticker), getCandles(ticker, '1day', 260), getFundamentals(ticker), getNews(ticker), getMacro(), getCCL(),
      isCripto ? Promise.resolve(null) : getCandles(ticker, '1week', 130),
      ticker === 'SPY' ? Promise.resolve(null) : getCandles('SPY', '1day', 220),
      wantsBtcBeta ? getCandles('BTC', '1day', 220) : Promise.resolve(null),
      getEarnings(ticker),
      getDividends(ticker),
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
    // Fuerza relativa vs SPY (mismas velas ya pedidas arriba, sin requests
    // extra) — no se calcula en las señales livianas del Dashboard/Watchlist
    // (computeLightSignal) para no multiplicar pedidos por decenas de
    // tickers a la vez, mismo criterio que ya se usa ahí con fundamentales.
    const relativeStrength = spyCandles ? relStrength(candles.c, spyCandles.c) : null;
    // Sensibilidad a Bitcoin: mismo cálculo (Pearson + covarianza/varianza)
    // que la correlación/beta vs SPY, contra los cierres de BTC.
    const btcCorrelation = btcCandles ? correlationAndBeta(candles.c, btcCandles.c) : null;

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
    const scoreResult = computeScore({ technical, fundamentals: fundForScore, macro: macroForScore, newsSentiment: news?.sentimentScore ?? null, candles, confluence, sector: asset.sector, earningsSoon, relativeStrength });
    const plan = computePlan(technical, scoreResult.score);

    state.report = {
      asset, quote, candles, fundamentals, news, macro, ccl,
      technical, weeklyTechnical, confluence, marketCorrelation, relativeStrength, btcCorrelation, earnings, daysToEarnings, earningsSoon, dividends, ...scoreResult, plan,
      ts: { quote: now, candles: now, fundamentals: now, news: now },
    };

    // El gráfico arranca en 1D/1S sin pegarle de nuevo a la API: reutiliza
    // las mismas velas que ya se pidieron para el análisis diario/semanal.
    chartState.cache['1day'] = { candles, isReal: candles.isReal };
    if (weeklyCandles) chartState.cache['1week'] = { candles: weeklyCandles, isReal: isCripto ? candles.isReal : (weeklyNative?.isReal ?? false) };
    state.loading = false;
    if (asset.sector) loadPeerRadar(asset.sector, macro); // no bloquea el render del reporte
    loadSeasonality(asset.ticker); // ídem: pide historial extendido aparte, no bloquea el render inicial
  } catch (e) {
    console.error('[app] error cargando reporte', e);
    state.loading = false;
    state.error = 'error_carga';
  }
  renderTopbar();
  renderReport();
}

/* ───────────────────────── asistente IA: contexto grounded ───────────────────────── */
// Extrae un subconjunto compacto de lo YA calculado por la plataforma (nunca
// las velas OHLCV crudas, que inflarían el costo del request sin aportar
// nada que el modelo pueda razonar mejor que el motor de score/plan ya
// hecho) — el mismo principio de "nunca inventar" del resto del sitio
// aplicado al payload que ve el modelo: si no está acá, el asistente debe
// decir que no lo tiene, no adivinarlo.
function round2(n) { return typeof n === 'number' && !isNaN(n) ? Math.round(n * 100) / 100 : null; }
function buildAssistantContext() {
  const ctx = { fecha: new Date().toISOString().slice(0, 10) };
  if (state.asset && state.report) {
    const r = state.report;
    ctx.activo = { ticker: r.asset.ticker, nombre: r.asset.name, sector: r.asset.sector, categoria: r.asset.category };
    if (r.quote) ctx.cotizacion = { usd: round2(r.quote.usd), variacionPct: round2(r.quote.changePct), cedearArs: round2(r.quote.cedearArs), fuenteCedear: r.quote.cedearSource };
    if (r.score != null) {
      ctx.score = {
        valor: r.score, etiqueta: r.scoreLabel, confianza: r.confidence,
        desglose: (r.scoreBreakdown || []).filter(b => b.available).map(b => ({ categoria: b.label, puntosSobre100: b.pct })),
      };
    }
    if (r.plan) {
      ctx.planOperativo = {
        zonaCompra: r.plan.compra, zonaVenta: r.plan.venta, stopLoss: r.plan.stopLoss,
        stopDinamicoChandelier: r.plan.chandelierStop, // trailing stop, solo si ya es más favorable que el stop fijo
        objetivo1: r.plan.tp1, objetivo2: r.plan.tp2, objetivo3: r.plan.tp3,
        riesgoBeneficio: r.plan.riskReward, probabilidad: r.plan.probability, drawdownEsperado: r.plan.drawdown,
      };
    }
    if (r.technical) {
      ctx.tecnico = {
        precio: round2(r.technical.price), rsi: round2(r.technical.rsi), adx: round2(r.technical.adx),
        posicionVsEma200: r.technical.price > r.technical.ema200 ? 'sobre EMA200' : 'bajo EMA200',
        posicionBandasBollinger: r.technical.bbPos, tendenciaVolumenOBV: r.technical.obvTrend,
        soporte: round2(r.technical.support), resistencia: round2(r.technical.resistance),
        puntoControlVolumenPOC: r.technical.volumeProfile?.hasData ? round2(r.technical.volumeProfile.poc) : null,
        divergenciaPrecioRsi: r.technical.divergence?.type ?? null,
        patronDeVela: r.technical.candlePattern?.label ?? null,
        squeezeVolatilidad: r.technical.squeeze?.active ? (r.technical.squeeze.justFired ? 'recién liberado' : 'activo') : 'sin compresión',
        indiceFuerzaTendencia: r.technical.trendStrength ? `${r.technical.trendStrength.value}/100 (${r.technical.trendStrength.label})` : null,
      };
    }
    if (r.confluence) {
      ctx.confluenciaSemanal = {
        señalesAFavor: `${r.confluence.agreeCount}/${r.confluence.checksAvailable}`,
        deAcuerdoConTendenciaDiaria: r.confluence.agree,
      };
    }
    if (r.relativeStrength) {
      ctx.fuerzaRelativaVsSPY = {
        liderandoAlMercado: r.relativeStrength.trend === 'up',
        enMaximoDeFuerzaRelativa: r.relativeStrength.isNewHigh,
      };
    }
    const seasonalityEntry = seasonalityState.byTicker[r.asset.ticker]?.seasonality;
    if (seasonalityEntry) {
      const withData = seasonalityEntry.rows.filter(row => row.avgReturnPct != null);
      const best = withData.slice().sort((a, b) => b.avgReturnPct - a.avgReturnPct)[0];
      const worst = withData.slice().sort((a, b) => a.avgReturnPct - b.avgReturnPct)[0];
      ctx.estacionalidad = {
        añosDeHistorial: seasonalityEntry.totalYears,
        mejorMesHistorico: best ? `${best.label} (+${best.avgReturnPct.toFixed(1)}%)` : null,
        peorMesHistorico: worst ? `${worst.label} (${worst.avgReturnPct.toFixed(1)}%)` : null,
      };
    }
    if (r.fundamentals?.hasData) {
      ctx.fundamentales = {
        crecimientoIngresosPct: r.fundamentals.revenueGrowth, crecimientoEpsPct: r.fundamentals.epsGrowth,
        peTTM: r.fundamentals.peTTM, peg: r.fundamentals.peg, roePct: r.fundamentals.roe,
        margenNetoPct: r.fundamentals.netMargin, dividendYieldPct: r.fundamentals.dividendYield,
      };
    }
    if (r.macro) {
      ctx.macro = {
        riesgoPaisArgentina: r.macro.riesgoPaisArg, vix: r.macro.vix,
        fearGreedCripto: r.macro.fearGreed?.value ?? null, dolarCCL: r.macro.dolares?.ccl ?? null,
      };
    }
    ctx.earnings = { diasParaProximoReporte: r.daysToEarnings, reporteInminente: r.earningsSoon };
    if (r.dividends?.items?.length) ctx.ultimoDividendoPagado = r.dividends.items[0];
    if (r.news?.items?.length) ctx.noticiasRecientes = r.news.items.slice(0, 4).map(n => ({ titular: n.text, tonoHeuristico: n.tag }));
  } else {
    ctx.vistaActual = state.view; // sin ticker puntual: dashboard, portfolio, watchlist, etc.
    const holdings = getPortfolio();
    if (holdings.length) ctx.carteraDelUsuario = holdings.map(h => ({ ticker: h.ticker, cantidad: h.shares, costoPromedio: h.avgCost, moneda: h.costCurrency }));
  }
  return ctx;
}

const assistantState = { open: false, messages: [], loading: false, error: null };

function assistantContextLabel() {
  return state.asset ? `sobre ${state.asset.ticker}` : 'sobre tu cartera / la plataforma';
}

function renderAssistantPanel() {
  if (!els.assistantPanel) return;
  if (!assistantState.open) { els.assistantPanel.style.display = 'none'; els.assistantPanel.innerHTML = ''; return; }

  els.assistantPanel.innerHTML = `
    <div class="assistant-card">
      <div class="assistant-header">
        <div>
          <div class="assistant-title">Asistente IA</div>
          <div class="assistant-subtitle">Pregúntale ${esc(assistantContextLabel())} — solo responde con datos ya calculados por la plataforma.</div>
        </div>
        <button class="assistant-close" id="assistant-close" aria-label="Cerrar asistente">✕</button>
      </div>
      <div class="assistant-messages" id="assistant-messages">
        ${assistantState.messages.length === 0 ? `<div class="assistant-empty">Preguntá algo como "¿por qué el score es ${state.report ? esc(String(state.report.score)) : 'este'}?" o "¿cuál es el plan operativo?".</div>` : ''}
        ${assistantState.messages.map(m => `
          <div class="assistant-msg assistant-msg-${m.role}">
            <div class="assistant-msg-bubble">${esc(m.text)}</div>
          </div>`).join('')}
        ${assistantState.loading ? `<div class="assistant-msg assistant-msg-assistant"><div class="assistant-msg-bubble assistant-typing">Pensando…</div></div>` : ''}
        ${assistantState.error ? `<div class="assistant-error">${esc(assistantState.error)}</div>` : ''}
      </div>
      <form class="assistant-inputrow" id="assistant-form">
        <input type="text" id="assistant-input" class="assistant-input" placeholder="Escribí tu pregunta…" autocomplete="off" maxlength="600" />
        <button type="submit" class="assistant-send" id="assistant-send" ${assistantState.loading ? 'disabled' : ''}>Enviar</button>
      </form>
    </div>`;
  els.assistantPanel.style.display = 'flex';

  document.getElementById('assistant-close')?.addEventListener('click', () => { assistantState.open = false; renderAssistantPanel(); });
  document.getElementById('assistant-form')?.addEventListener('submit', (e) => {
    e.preventDefault();
    const input = document.getElementById('assistant-input');
    const question = input.value.trim();
    if (!question || assistantState.loading) return;
    input.value = '';
    sendAssistantQuestion(question);
  });
  const msgsEl = document.getElementById('assistant-messages');
  if (msgsEl) msgsEl.scrollTop = msgsEl.scrollHeight;
  document.getElementById('assistant-input')?.focus();
}

async function sendAssistantQuestion(question) {
  assistantState.messages.push({ role: 'user', text: question });
  assistantState.loading = true;
  assistantState.error = null;
  renderAssistantPanel();
  try {
    const context = buildAssistantContext();
    const r = await fetch('/api/assistant', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ question, context }),
    });
    const d = await r.json();
    if (!r.ok) throw new Error(d?.detail || d?.error || 'no se pudo obtener respuesta');
    assistantState.messages.push({ role: 'assistant', text: d.answer });
  } catch (e) {
    console.error('[assistant] error', e);
    assistantState.error = 'No se pudo conectar con el asistente. Probá de nuevo en un momento.';
  } finally {
    assistantState.loading = false;
    renderAssistantPanel();
  }
}

els.assistantFab?.addEventListener('click', () => {
  assistantState.open = !assistantState.open;
  renderAssistantPanel();
});

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

/* ───────────────────────── estacionalidad mensual ───────────────────────── */
// Pedido aparte (historial extendido, ~3 años) porque el reporte principal
// solo trae ~1 año de velas — no bloquea el render inicial de la ficha,
// aparece cuando termina de calcularse (igual que el radar de sector).
const seasonalityState = { byTicker: {}, loadingTicker: null };
async function loadSeasonality(ticker) {
  const cached = seasonalityState.byTicker[ticker];
  if (cached && Date.now() - cached.at < 60 * 60 * 1000) { if (state.asset?.ticker === ticker) renderReport(); return; }
  if (seasonalityState.loadingTicker === ticker) return;
  seasonalityState.loadingTicker = ticker;
  try {
    const candles = await getCandles(ticker, '1day', 750);
    const seasonality = monthlySeasonality(candles);
    seasonalityState.byTicker[ticker] = { at: Date.now(), seasonality };
  } catch (e) {
    console.warn('[seasonality] no se pudo cargar', ticker, e.message);
    seasonalityState.byTicker[ticker] = { at: Date.now(), seasonality: null };
  } finally {
    seasonalityState.loadingTicker = null;
    if (state.asset?.ticker === ticker) renderReport();
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
const ALERT_BT_TYPE_LABEL = { buy: 'En zona de compra', sell: 'En zona de venta', stop: 'Tocó el stop loss' };
const ALERT_BT_CONFIDENCE_ORDER = { alta: 0, media: 1, baja: 2 };
// Comprar da ganancia si el precio sube después; vender/stop "acierta" si el
// precio efectivamente cae después (son señales bajistas/de salida).
function alertBacktestWin(type, r) { return type === 'buy' ? r > 0 : r < 0; }
const FACTOR_HORIZON = 20; // ~1 mes de rueda — horizonte usado para medir qué sub-factores del score realmente correlacionaron con el retorno futuro de ESTE activo

/** Correlación de Pearson genérica — se reusa para validar empíricamente
 *  cada sub-factor del score contra el retorno futuro real (no inventa
 *  pesos nuevos: mide, sobre los mismos datos ya calculados del backtest,
 *  qué tan bien predijo cada factor lo que pasó después). */
function pearsonCorr(xs, ys) {
  const n = xs.length;
  if (n < 15) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n, my = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, vx = 0, vy = 0;
  for (let i = 0; i < n; i++) { const dx = xs[i] - mx, dy = ys[i] - my; cov += dx * dy; vx += dx * dx; vy += dy * dy; }
  if (vx <= 0 || vy <= 0) return null;
  return cov / Math.sqrt(vx * vy);
}

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
  const factorSamples = {}; // factorKey -> { label, values: [pct histórico], returns: [retorno fwd real] }
  const alertBuckets = {}; // "type:confidence" -> { h -> [retorno fwd real] }
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
    const fwd20 = candles.c[i + FACTOR_HORIZON];
    if (fwd20 != null) {
      const ret20 = (fwd20 - priceNow) / priceNow;
      for (const sb of scoreResult.scoreBreakdown) {
        if (!sb.available) continue; // sin fundamentales/macro/noticias en el backtest — no ensucia la correlación con ceros artificiales
        (factorSamples[sb.key] ??= { label: sb.label, values: [], returns: [] });
        factorSamples[sb.key].values.push(sb.pct);
        factorSamples[sb.key].returns.push(ret20);
      }
    }
    // Misma lógica de detectPriceAlert que usa el usuario en vivo (con las
    // mismas ~3 velas previas para el filtro anti-whipsaw), para medir qué
    // tan bien predijo cada combinación (tipo, confianza) el retorno real
    // que vino después — la "confianza" que calcula el motor, puesta a prueba.
    const priceAlert = detectPriceAlert(priceNow, technical, { recentCloses: slice.c.slice(-3) });
    if (priceAlert && !priceAlert.pending) {
      const key = `${priceAlert.type}:${priceAlert.confidence}`;
      if (!alertBuckets[key]) alertBuckets[key] = {};
      for (const h of BACKTEST_HORIZONS) {
        const fwd = candles.c[i + h];
        if (fwd == null) continue;
        (alertBuckets[key][h] ??= []).push((fwd - priceNow) / priceNow);
      }
    }
    sampleCount++;
  }

  const factorCorrelations = Object.values(factorSamples)
    .map(d => ({ label: d.label, n: d.values.length, correlation: pearsonCorr(d.values, d.returns) }))
    .filter(f => f.correlation != null)
    .sort((a, b) => Math.abs(b.correlation) - Math.abs(a.correlation));

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

  const alertRows = Object.keys(alertBuckets).map(key => {
    const [type, confidence] = key.split(':');
    const byH = alertBuckets[key];
    const horizons = BACKTEST_HORIZONS.map(h => {
      const arr = byH[h] || [];
      if (!arr.length) return { h, n: 0, avgPct: null, winRate: null };
      const avg = arr.reduce((a, b) => a + b, 0) / arr.length;
      const wins = arr.filter(r => alertBacktestWin(type, r)).length;
      return { h, n: arr.length, avgPct: avg * 100, winRate: Math.round((wins / arr.length) * 100) };
    });
    return {
      type, confidence, label: `${ALERT_BT_TYPE_LABEL[type] ?? type} · confianza ${confidence}`,
      horizons, occurrences: horizons.reduce((max, x) => Math.max(max, x.n), 0),
    };
  }).sort((a, b) => a.type.localeCompare(b.type) || (ALERT_BT_CONFIDENCE_ORDER[a.confidence] ?? 9) - (ALERT_BT_CONFIDENCE_ORDER[b.confidence] ?? 9));

  return {
    ticker, isReal: candles.isReal, insufficientData: false, candleCount: n, sampleCount,
    from: candles.t[BACKTEST_WARMUP], to: candles.t[n - 1], rows, factorCorrelations, factorHorizon: FACTOR_HORIZON,
    alertRows,
  };
}

/* ───────────────────────── render del reporte ───────────────────────── */
const VIEW_PAGES = {
  dashboard: { html: dashboardHTML, wire: wireDashboardEvents, load: () => { if (!dashState.started) loadDashboardData(); loadPortfolioData(); } },
  portfolio: { html: portfolioHTML, wire: wirePortfolioEvents, load: loadPortfolioData },
  simulator: { html: simulatorHTML, wire: wireSimulatorEvents, load: loadSimulatorData },
  watchlist: { html: watchlistPageHTML, wire: wireWatchlistEvents, load: () => {} },
  macro: { html: macroNewsPageHTML, wire: wireMacroNewsEvents, load: loadMacroNewsData },
  alerts: { html: alertsPageHTML, wire: wireAlertsEvents, load: () => { if (telegramState.chatId && !telegramState.subsLoaded && !telegramState.subsLoading) loadTelegramSubscriptions(); } },
  backtest: { html: backtestPageHTML, wire: wireBacktestEvents, load: () => {} },
  calendar: { html: calendarPageHTML, wire: wireCalendarEvents, load: loadCalendarData },
  screener: { html: screenerPageHTML, wire: wireScreenerEvents, load: () => { if (!dashState.started) loadDashboardData(); } },
  shorttrades: { html: shortTradesPageHTML, wire: wireShortTradesEvents, load: () => { if (!dashState.started) loadDashboardData(); loadWatchlistData(); } },
  gaps: { html: gapsPageHTML, wire: wireGapsEvents, load: () => { if (!dashState.started) loadDashboardData(); loadWatchlistData(); } },
  trackrecord: { html: trackRecordPageHTML, wire: wireTrackRecordEvents, load: () => { if (!trackState.started) loadTrackRecord(); } },
  dividends: { html: dividendsPageHTML, wire: wireDividendsEvents, load: loadDividendsData },
  compare: { html: comparePageHTML, wire: wireCompareEvents, load: () => {} },
  settings: { html: settingsPageHTML, wire: wireSettingsEvents, load: () => {} },
  bonds: { html: bondsPageHTML, wire: wireBondsEvents, load: loadBondsData },
};

function renderReport() {
  renderReportImpl();
  triggerReportTransition();
}

/** Anima SOLO cuando cambió lo que se está mostrando (otra vista, u otro
 *  ticker) — no en cada renderReport(), porque muchas actualizaciones son
 *  refrescos silenciosos de fondo sobre la MISMA pantalla ya visible (el
 *  batch del universo del Dashboard, polling de watchlist/portfolio/macro):
 *  animarlas también hacía "titilar" toda la página cada vez que llegaba un
 *  dato nuevo, aunque el usuario no hubiera tocado nada. */
let lastRenderKey = null;
function triggerReportTransition() {
  if (state.loading) return; // el skeleton no necesita su propio fade
  const key = state.asset && state.report ? `ticker:${state.asset.ticker}` : !state.asset ? `view:${state.view}` : null;
  if (key === null || key === lastRenderKey) return;
  lastRenderKey = key;

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
  const { asset, quote, technical: t, fundamentals: f, news, macro, ccl, score, scoreLabel, confidence, scoreBreakdown, plan, ts, coverageWeight, fullWeight, confluence, marketCorrelation, relativeStrength, btcCorrelation, earnings, daysToEarnings, earningsSoon, dividends } = r;

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
  // Acá sí se pasa confluence semanal (a diferencia de computeLightSignal y
  // el cron de Telegram): es un solo ticker, no hay riesgo de multiplicar
  // pedidos por decenas de activos a la vez.
  const priceAlert = detectPriceAlert(quote.usd, t, { confluence, recentCloses: r.candles.c.slice(-3) });
  const priceAlertMeta = priceAlert ? ALERT_META[priceAlert.type] : null;

  const { risks, catalysts } = risksAndCatalysts(r);
  const w52 = fiftyTwoWeekRange(r.candles);
  const volStats = volumeStats(r.candles);

  const effectiveRatio = quote.ratio ?? asset.ratio;
  const isCedear = (asset.category === 'CEDEAR' || asset.category === 'ETF') && effectiveRatio;
  const cedearPriceTxt = quote.cedearArs != null ? `AR$${Math.round(quote.cedearArs).toLocaleString('es-AR')} por CEDEAR` : 'N/D';
  const cedearSourceTxt = quote.cedearSource === 'live'
    ? 'precio real operado hoy en BYMA'
    : `estimación vía CCL${ccl?.value ? ` ≈ $${Math.round(ccl.value).toLocaleString('es-AR')}` : ''} — sin cotización real disponible para este símbolo`;
  // Dólar implícito: solo se puede calcular con precio real de BYMA (no vale
  // la pena con la estimación vía CCL, que ya ES el CCL por construcción).
  const cclImpliedTxt = quote.cclImplied != null && quote.cclRef != null ? (() => {
    const spread = (quote.cclImplied / quote.cclRef - 1) * 100;
    const read = Math.abs(spread) < 1.5 ? 'en línea con el CCL' : spread > 0 ? 'más caro que el CCL' : 'más barato que el CCL';
    return ` Dólar implícito en este CEDEAR: ${fmtArs(quote.cclImplied)} (CCL de referencia ${fmtArs(quote.cclRef)}, ${spread >= 0 ? '+' : ''}${spread.toFixed(1)}% — ${read}).`;
  })() : '';
  const ratioNote = quote.ratioSource === 'implied' ? ` (ratio actualizado automáticamente contra el precio real de BYMA — el estático del universo estaba desactualizado)` : '';
  const cedearNote = isCedear ? `
    <div class="cedear-note">
      <strong>Referencia CEDEAR (solo informativa):</strong> el análisis completo se realizó sobre ${esc(asset.name)} (${esc(asset.ticker)}) cotizando en USD. El CEDEAR argentino replica esta acción con ratio de referencia 1:${effectiveRatio}${ratioNote}. Equivalente: ${cedearPriceTxt} (${cedearSourceTxt}).${cclImpliedTxt} Ninguna recomendación de esta sección se basa en el precio en pesos.
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

  // Si el proveedor de velas (Twelve Data) no respondió o agotó su cupo
  // diario, dataSource.js cae a velas simuladas ancladas a un precio de
  // referencia estático — score, RSI, EMAs, soporte/resistencia y el gráfico
  // quedan calculados sobre ESE precio simulado, que puede no tener ninguna
  // relación con el precio real de arriba (que sí sigue siendo real, viene
  // de Finnhub). Se avisa explícito acá en vez de mostrarlo silenciosamente
  // como si fuera un análisis en vivo confiable.
  const degradedCandles = isLive() && r.candles.isReal === false;
  const degradedNote = degradedCandles ? `
    <div class="card degraded-note">
      ${ICONS.warning}
      <div><strong>Score, gráfico e indicadores técnicos no disponibles en este momento.</strong> El proveedor de velas (Twelve Data) no respondió o alcanzó su límite diario — para no mostrar un análisis calculado sobre datos simulados como si fuera real, esta sección usa un precio de referencia que puede no coincidir con el precio actual de ${esc(asset.ticker)} (arriba, ese sí es real). Volvé a intentar en unos minutos, o mirá la pestaña <strong>Análisis Libre (TradingView)</strong> más abajo para un gráfico en vivo mientras tanto.</div>
    </div>` : '';

  els.report.innerHTML = `
    <div class="breadcrumbs">Análisis <span>›</span> ${esc(breadcrumbLabel)} <span>›</span> <strong>${esc(asset.ticker)}</strong></div>
    ${degradedNote}
    ${sectionTitleHTML('Resumen Ejecutivo', 'briefcase')}
    <div class="exec-grid">
      <div class="card exec-card">
        <div class="exec-name-row">
          <div class="exec-name">${esc(asset.name)}</div>
          <div class="exec-tickersector">${esc(asset.ticker)} · ${esc(asset.sector)}</div>
          <button class="star-btn star-btn-lg" id="exec-star" title="${isWatched(asset.ticker) ? 'Quitar de seguimiento' : 'Agregar a seguimiento'}" aria-label="${isWatched(asset.ticker) ? 'Quitar ' + esc(asset.ticker) + ' de seguimiento' : 'Agregar ' + esc(asset.ticker) + ' a seguimiento'}" aria-pressed="${isWatched(asset.ticker)}">${isWatched(asset.ticker) ? '★' : '☆'}</button>
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
        ${subScores.length ? `
        <div class="gauge-subscores">
          ${subScores.map(sb => `
            <div class="gauge-subscore-col" title="${esc(subScoreLabels[sb.key])}: ${sb.available ? Math.round(sb.pct) : 'sin datos'}">
              <span class="gauge-subscore-label">${esc(subScoreLabels[sb.key])}</span>
              <div class="score-bar-bg"><div class="score-bar-fill" style="width:${sb.pct}%; opacity:${sb.available ? 1 : 0.25};"></div></div>
              <span class="gauge-subscore-value">${sb.available ? Math.round(sb.pct) : 'N/D'}</span>
            </div>`).join('')}
        </div>` : ''}
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
        <div class="stat-card-label">Fuerza Relativa (vs SPY)</div>
        <div class="stat-card-value ${relativeStrength ? (relativeStrength.trend === 'up' ? 'up' : 'down') : ''}">${relativeStrength ? (relativeStrength.trend === 'up' ? 'Liderando' : 'Rezagando') : 'N/D'}</div>
        <div class="stat-card-sub">${relativeStrength?.isNewHigh ? '★ Máximo de RS — liderazgo' : relativeStrength ? `${relativeStrength.slopePct >= 0 ? '+' : ''}${relativeStrength.slopePct.toFixed(1)}% en 20 ruedas` : ''}</div>
      </div>
      ${CRYPTO_RELATED.has(asset.ticker) && asset.ticker !== 'BTC' ? `
      <div class="card stat-card" title="Cuánto se movió esta acción por cada 1% de Bitcoin, sobre las últimas ~220 ruedas">
        <div class="stat-card-label">Beta (vs BTC)</div>
        <div class="stat-card-value">${btcCorrelation?.beta != null ? btcCorrelation.beta.toFixed(2) : 'N/D'}</div>
        <div class="stat-card-sub">${btcCorrelation?.correlation != null ? `correlación ${btcCorrelation.correlation.toFixed(2)}` : ''}</div>
      </div>` : ''}
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
      <div class="chart-mode-tabs" role="tablist">
        <button class="chart-mode-tab ${chartState.mode === 'institucional' ? 'active' : ''}" data-mode="institucional" role="tab" aria-selected="${chartState.mode === 'institucional'}">Análisis Institucional</button>
        <button class="chart-mode-tab ${chartState.mode === 'libre' ? 'active' : ''}" data-mode="libre" role="tab" aria-selected="${chartState.mode === 'libre'}">Análisis Libre (TradingView)</button>
      </div>
      ${chartState.mode === 'libre' ? `
      <div class="tv-note">Widget gratuito de TradingView con sus propios datos e indicadores, siempre en vivo — usalo para tu propio análisis técnico libre. El símbolo puede no coincidir 1:1 con el precio de CEDEAR en pesos que calculamos arriba (esa parte del análisis siempre es sobre ${esc(asset.name)} en USD).</div>
      <div class="tv-layout">
        <div id="tv-widget-container" class="tv-widget-container"></div>
        ${tvSidePanelHTML(plan, degradedCandles)}
      </div>
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
          <div class="panel-title">${ICONS.chart}<span>¿Cómo viene el precio?</span></div>
          <div class="freshness" style="color:${freshTechnical.color};"><span class="dot" style="background:${freshTechnical.color};"></span>${esc(freshTechnical.text)}</div>
        </div>
        <div class="card panel-card didactic-card">
          ${didacticTechnicalCards(t, confluence, relativeStrength, plan, quote).map(didacticCardHTML).join('')}
          <div class="narrative">${esc(technicalNarrative(t, confluence))}</div>
          <details class="advanced-details">
            <summary>Ver todos los indicadores técnicos (avanzado)</summary>
            <div class="metrics-grid" style="margin-top:12px;">
              ${technicalMetricRows(t, confluence, marketCorrelation, relativeStrength).map(m => `<div class="metric-row"><span class="metric-label">${esc(m.label)}</span><span class="metric-value">${esc(m.value)}</span></div>`).join('')}
            </div>
          </details>
        </div>
      </div>
      <div>
        <div class="panel-header">
          <div class="panel-title">${ICONS.building}<span>¿Cómo está la empresa?</span></div>
          <div class="freshness" style="color:${freshFundamental.color};"><span class="dot" style="background:${freshFundamental.color};"></span>${esc(freshFundamental.text)}</div>
        </div>
        <div class="card panel-card didactic-card">
          ${(() => {
            const cards = didacticFundamentalCards(f, earnings, daysToEarnings, dividends, asset);
            if (!cards) return `<div class="didactic-empty">No hay datos fundamentales (balance, ganancias, deuda) para este activo en la fuente gratuita — suele pasar con CEDEARs de empresas menos seguidas, ETFs y cripto. El análisis técnico de al lado sí está disponible.</div>`;
            return cards.map(didacticCardHTML).join('') + `<div class="narrative">${esc(fundamentalNarrative(f, asset.sector))}</div>
            <details class="advanced-details">
              <summary>Ver todos los datos fundamentales (avanzado)</summary>
              <div class="metrics-grid" style="margin-top:12px;">
                ${fundamentalMetricRows(f, earnings, daysToEarnings, dividends).map(m => `<div class="metric-row"><span class="metric-label">${esc(m.label)}</span><span class="metric-value">${esc(m.value)}</span></div>`).join('')}
              </div>
            </details>`;
          })()}
        </div>
      </div>
    </div>

    ${insiderFlowCardHTML(f?.insider, asset)}

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

    ${sectionTitleHTML('Riesgos & Catalizadores', 'warning')}
    <div class="card rc-combined-card">
      <div class="rc-combined-grid">
        <div class="rc-combined-col rc-combined-risks">
          <div class="rc-combined-title">${ICONS.warning}<span>Riesgos</span></div>
          <ul class="rc-list">${risks.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>
        <div class="rc-combined-col rc-combined-catalysts">
          <div class="rc-combined-title">${ICONS.bulb}<span>Catalizadores</span></div>
          <ul class="rc-list">${catalysts.map(x => `<li>${esc(x)}</li>`).join('')}</ul>
        </div>
      </div>
    </div>

    ${radarHTML(asset, scoreBreakdown)}

    ${seasonalityHTML(asset.ticker)}

    <div class="panel-header">
      ${sectionTitleHTML('Plan Operativo', 'target', 'margin-bottom:0;')}
      <div style="display:flex; align-items:center; gap:10px;">
        ${priceAlertMeta ? `<div class="watch-alert plan-alert-badge" style="color:${priceAlertMeta.color};"${alertTitleAttr(priceAlert)}>⚡ ${esc(priceAlertMeta.label)}${alertConfidenceSuffix(priceAlert)}</div>` : ''}
        <div class="freshness" style="color:${freshPlan.color};"><span class="dot" style="background:${freshPlan.color};"></span>${esc(freshPlan.text)}</div>
      </div>
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
        ${plan.volumeProfilePoc ? `<div class="plan-footer-item" title="Precio con más volumen operado — soporte/resistencia real, no solo un extremo puntual">POC (volumen): <span>${esc(plan.volumeProfilePoc)}</span></div>` : ''}
        ${plan.chandelierStop ? `<div class="plan-footer-item" title="Trailing stop (Chandelier Exit): sube con nuevos máximos, nunca baja — usar una vez adentro de la posición, no como stop inicial">Stop dinámico (trailing): <span>${esc(plan.chandelierStop)}</span></div>` : ''}
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
  // Mismos opts que el render (support/resistance/plan diarios) para que la
  // escala de precio del crosshair coincida exactamente con lo dibujado.
  if (chartWrap && chartEntry) wireChartHover(chartWrap, chartEntry.candles, { support: t.support, resistance: t.resistance, plan: plan?.raw });

  els.report.querySelectorAll('.chart-mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      if (chartState.mode === btn.dataset.mode) return;
      chartState.mode = btn.dataset.mode;
      renderReport();
    });
  });
  if (chartState.mode === 'libre' && state.asset) {
    const symbol = tvSymbolFor(state.asset);
    mountTradingViewWidget('tv-widget-container', symbol);
    mountTradingViewTAWidget('tv-ta-widget', symbol);
  }
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

function seasonalityHTML(ticker) {
  const entry = seasonalityState.byTicker[ticker];
  if (!entry) {
    return `${sectionTitleHTML('Estacionalidad Mensual', 'calendar')}
      <div class="card dash-loading-note" style="margin-bottom:36px;">Calculando estacionalidad sobre historial extendido…</div>`;
  }
  const s = entry.seasonality;
  if (!s) {
    return `${sectionTitleHTML('Estacionalidad Mensual', 'calendar')}
      <div class="card watch-empty" style="margin-bottom:36px;">No hay suficiente historial (se necesitan al menos 2 años) para calcular estacionalidad real de ${esc(ticker)} — se omite antes que mostrar un patrón inventado.</div>`;
  }
  const maxAbs = Math.max(...s.rows.map(r => Math.abs(r.avgReturnPct ?? 0)), 1);
  return `
    ${sectionTitleHTML('Estacionalidad Mensual', 'calendar')}
    <div class="dash-intro" style="margin-bottom:14px;">Retorno promedio histórico por mes calendario, sobre ${s.totalYears} año(s) de datos reales disponibles — no es una predicción, es lo que pasó en el pasado (y el pasado no garantiza el futuro).</div>
    <div class="card seasonality-card" style="margin-bottom:36px;">
      <div class="seasonality-grid">
        ${s.rows.map(r => {
          const heightPct = r.avgReturnPct == null ? 0 : Math.max(6, Math.round((Math.abs(r.avgReturnPct) / maxAbs) * 100));
          const up = (r.avgReturnPct ?? 0) >= 0;
          return `<div class="seasonality-col">
            <div class="seasonality-bar-track">
              <div class="seasonality-bar ${up ? 'up' : 'down'}" style="height:${r.avgReturnPct == null ? 0 : heightPct}%;" title="${esc(r.label)}: ${r.avgReturnPct == null ? 'sin datos' : (r.avgReturnPct >= 0 ? '+' : '') + r.avgReturnPct.toFixed(1) + '%'}"></div>
            </div>
            <div class="seasonality-pct ${r.avgReturnPct == null ? '' : up ? 'up' : 'down'}">${r.avgReturnPct == null ? '—' : `${r.avgReturnPct >= 0 ? '+' : ''}${r.avgReturnPct.toFixed(1)}%`}</div>
            <div class="seasonality-month">${esc(r.label)}</div>
          </div>`;
        }).join('')}
      </div>
    </div>`;
}

/* ── análisis "en criollo": tarjetas didácticas para el usuario que explora ──
 * Traducen los indicadores técnicos y fundamentales a veredictos simples con
 * un semáforo (verde/amarillo/rojo) y una frase en lenguaje llano. Derivan de
 * los MISMOS datos reales que las tablas avanzadas — no simplifican inventando.
 */
const VERDICT_COLOR = { good: GREEN, warn: AMBER, bad: RED, neutral: 'oklch(0.62 0.02 262)' };
const VERDICT_ICON = { good: '👍', warn: '⚠️', bad: '👎', neutral: '➖' };

function didacticTechnicalCards(t, confluence, relativeStrength, plan, quote) {
  const rows = [];
  // Tendencia
  if (t.bullishAlign) rows.push({ level: 'good', title: 'Tendencia alcista', text: 'El precio viene subiendo de forma sostenida (las medias de 20, 50, 100 y 200 días están ordenadas hacia arriba).' });
  else if (t.bearishAlign) rows.push({ level: 'bad', title: 'Tendencia bajista', text: 'El precio viene cayendo de forma sostenida. Las medias móviles apuntan hacia abajo.' });
  else if (t.price > t.ema200) rows.push({ level: 'warn', title: 'Alcista de fondo, floja de corto', text: 'A largo plazo sigue arriba de su promedio de 200 días, pero de corto plazo está indeciso.' });
  else rows.push({ level: 'warn', title: 'Bajo su promedio de largo plazo', text: 'Está por debajo de la media de 200 días — todavía no confirma un cambio a alcista.' });
  // Momentum (RSI)
  if (!isNaN(t.rsi)) {
    if (t.rsi > 70) rows.push({ level: 'warn', title: 'Subió mucho y rápido', text: `El RSI está en ${t.rsi.toFixed(0)} (sobrecomprado): puede tomarse un respiro o corregir.` });
    else if (t.rsi < 30) rows.push({ level: 'good', title: 'Muy castigado, puede rebotar', text: `El RSI está en ${t.rsi.toFixed(0)} (sobrevendido): cayó fuerte y suele haber rebotes desde acá.` });
    else rows.push({ level: 'neutral', title: 'Momentum equilibrado', text: `El RSI está en ${t.rsi.toFixed(0)}: ni sobrecomprado ni sobrevendido, sin extremos.` });
  }
  // Fuerza relativa vs mercado
  if (relativeStrength) {
    if (relativeStrength.trend === 'up') rows.push({ level: 'good', title: 'Le gana al mercado', text: `Viene rindiendo mejor que el índice S&P 500${relativeStrength.isNewHigh ? ' — en máximos de fuerza relativa, señal de liderazgo' : ''}.` });
    else rows.push({ level: 'warn', title: 'Va más lento que el mercado', text: 'Rinde por debajo del S&P 500 — el dinero está prefiriendo otros activos.' });
  }
  // Volumen
  if (t.obvConfirms === true) rows.push({ level: 'good', title: 'El volumen acompaña', text: 'El movimiento del precio viene con volumen que lo respalda — más confiable.' });
  else if (t.obvConfirms === false) rows.push({ level: 'bad', title: 'El volumen no acompaña', text: 'El precio se mueve pero el volumen no lo respalda — puede ser un movimiento en falso.' });
  // Dónde está el precio
  if (plan?.raw) {
    const { supportRef, resistanceRef, safeAtr } = plan.raw;
    if (quote.usd <= supportRef + 0.6 * safeAtr) rows.push({ level: 'good', title: 'Cerca de un piso', text: `Está cerca de un soporte técnico (~${fmtUsd(supportRef)}): zona donde suele frenar caídas.` });
    else if (quote.usd >= resistanceRef - 0.6 * safeAtr) rows.push({ level: 'warn', title: 'Cerca de un techo', text: `Está cerca de una resistencia (~${fmtUsd(resistanceRef)}): zona donde suele frenar subas.` });
    else rows.push({ level: 'neutral', title: 'En zona intermedia', text: `Entre el soporte (~${fmtUsd(supportRef)}) y la resistencia (~${fmtUsd(resistanceRef)}).` });
  }
  return rows;
}

/* ───────────────────────── flujo de insiders ───────────────────────────
 * Muestra qué hicieron los insiders (directivos y dueños con >10%) en los
 * últimos ~6 meses: compras vs ventas en mercado abierto. La compra de un
 * insider es una de las pocas señales con valor predictivo documentado —
 * alguien que conoce la empresa por dentro pone SU plata. Las ventas pesan
 * menos (venden por mil razones: impuestos, diversificación, un auto nuevo).
 * Datos reales de Finnhub (formularios 3/4/5 de la SEC); si no hay cobertura
 * para el símbolo, la tarjeta no se muestra — nunca se inventan operaciones. */
function fmtShares(n) {
  const a = Math.abs(n);
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e7 ? 0 : 1) + 'M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e4 ? 0 : 1) + 'K';
  return String(Math.round(n));
}
function insiderFlowCardHTML(ins, asset) {
  if (!ins || (!ins.buyCount && !ins.sellCount)) return ''; // sin operaciones de mercado abierto → no se muestra
  const biasMeta = ins.bias === 'compra'
    ? { color: GREEN, icon: '▲', label: 'Sesgo comprador', txt: 'Los insiders compraron más de lo que vendieron — señal de convicción interna.' }
    : ins.bias === 'venta'
      ? { color: RED, icon: '▼', label: 'Sesgo vendedor', txt: 'Los insiders vendieron más de lo que compraron. Ojo: pueden vender por muchas razones ajenas al negocio.' }
      : { color: AMBER, icon: '≈', label: 'Sin sesgo claro', txt: 'Compras y ventas de insiders más o menos parejas — sin una señal direccional fuerte.' };
  const codeLabel = (c) => c === 'P' ? 'Compra' : c === 'S' ? 'Venta' : c;
  return `
    ${sectionTitleHTML('Flujo de Insiders', 'briefcase')}
    <div class="card insider-card">
      <div class="insider-head">
        <div class="insider-bias" style="color:${biasMeta.color};">
          <span class="insider-bias-icon">${biasMeta.icon}</span>
          <div>
            <div class="insider-bias-label">${biasMeta.label}</div>
            <div class="insider-bias-sub">Directivos y dueños · últimos 6 meses en ${esc(asset.ticker)}</div>
          </div>
        </div>
        <div class="insider-summary">
          <div class="insider-stat"><span>Compraron</span><b class="up">${fmtShares(ins.boughtShares)}</b><small>${ins.buyCount} op. · ${ins.distinctBuyers} insider${ins.distinctBuyers === 1 ? '' : 's'}</small></div>
          <div class="insider-stat"><span>Vendieron</span><b class="down">${fmtShares(ins.soldShares)}</b><small>${ins.sellCount} op. · ${ins.distinctSellers} insider${ins.distinctSellers === 1 ? '' : 's'}</small></div>
          <div class="insider-stat"><span>Neto (mercado abierto)</span><b class="${ins.netOpenMarket >= 0 ? 'up' : 'down'}">${ins.netOpenMarket >= 0 ? '+' : '−'}${fmtShares(Math.abs(ins.netOpenMarket))}</b><small>acciones</small></div>
        </div>
      </div>
      <div class="insider-note">${biasMeta.txt}</div>
      ${ins.transactions.length ? `
      <details class="advanced-details insider-details">
        <summary>Ver operaciones recientes (${ins.transactions.length})</summary>
        <table class="insider-table">
          <thead><tr><th>Insider</th><th>Fecha</th><th>Tipo</th><th>Acciones</th><th>Precio</th></tr></thead>
          <tbody>
            ${ins.transactions.map(t => `
              <tr>
                <td>${esc(t.name)}</td>
                <td>${esc(t.date ?? '—')}</td>
                <td class="${t.code === 'P' ? 'up' : t.code === 'S' ? 'down' : ''}">${esc(codeLabel(t.code))}</td>
                <td>${t.change >= 0 ? '+' : '−'}${fmtShares(Math.abs(t.change))}</td>
                <td>${t.price != null ? fmtUsd(t.price) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </details>` : ''}
      <div class="insider-disclaimer">Fuente: formularios 3/4/5 de la SEC vía Finnhub. Solo se cuentan compras/ventas de mercado abierto (códigos P/S) — se excluyen ejercicios de opciones, grants y regalos, que no son decisiones de mercado. La compra de insiders tiene valor de señal; la venta, mucho menos.</div>
    </div>`;
}

function didacticFundamentalCards(f, earnings, daysToEarnings, dividends, asset) {
  if (!f?.hasData) return null;
  const rows = [];
  // Crecimiento
  if (f.revenueGrowth != null) {
    if (f.revenueGrowth >= 10) rows.push({ level: 'good', title: 'Crece fuerte', text: `Sus ingresos crecen ${f.revenueGrowth.toFixed(0)}% al año — la empresa se está expandiendo.` });
    else if (f.revenueGrowth >= 0) rows.push({ level: 'neutral', title: 'Crecimiento moderado', text: `Sus ingresos crecen ${f.revenueGrowth.toFixed(1)}% al año — avanza, pero despacio.` });
    else rows.push({ level: 'bad', title: 'Ingresos en baja', text: `Sus ingresos caen ${Math.abs(f.revenueGrowth).toFixed(1)}% al año — la empresa se está achicando.` });
  }
  // Rentabilidad
  if (f.roe != null || f.netMargin != null) {
    const roe = f.roe, nm = f.netMargin;
    if ((roe != null && roe >= 15) || (nm != null && nm >= 15)) rows.push({ level: 'good', title: 'Muy rentable', text: `Gana buena plata con lo que tiene${nm != null ? ` (margen neto ${nm.toFixed(0)}%)` : ''}${roe != null ? `, ROE ${roe.toFixed(0)}%` : ''}.` });
    else if ((roe != null && roe > 0) || (nm != null && nm > 0)) rows.push({ level: 'neutral', title: 'Rentabilidad normal', text: `Es rentable pero sin destacarse${nm != null ? ` (margen neto ${nm.toFixed(0)}%)` : ''}.` });
    else rows.push({ level: 'bad', title: 'Poco o nada rentable', text: 'Hoy no gana dinero con su operación — mayor riesgo.' });
  }
  // ¿Cara o barata?
  if (f.peTTM != null) {
    const range = SECTOR_PE_RANGE?.[asset.sector];
    let level = 'neutral', text = `Cotiza a ${f.peTTM.toFixed(0)} veces sus ganancias (PE).`;
    if (range) {
      if (f.peTTM < range[0]) { level = 'good'; text = `Cotiza a ${f.peTTM.toFixed(0)}x ganancias, barata para su sector (${asset.sector}).`; }
      else if (f.peTTM > range[1]) { level = 'warn'; text = `Cotiza a ${f.peTTM.toFixed(0)}x ganancias, cara para su sector (${asset.sector}) — el mercado espera mucho de ella.`; }
      else text = `Cotiza a ${f.peTTM.toFixed(0)}x ganancias, en línea con su sector (${asset.sector}).`;
    } else {
      if (f.peTTM < 15) { level = 'good'; text = `Cotiza a ${f.peTTM.toFixed(0)}x ganancias — relativamente barata.`; }
      else if (f.peTTM > 30) { level = 'warn'; text = `Cotiza a ${f.peTTM.toFixed(0)}x ganancias — cara, el mercado espera mucho crecimiento.`; }
    }
    rows.push({ level, title: '¿Cara o barata?', text });
  }
  // Deuda
  if (f.debtEquity != null) {
    if (f.debtEquity <= 1) rows.push({ level: 'good', title: 'Deuda sana', text: `Su deuda es baja respecto a su capital (${f.debtEquity.toFixed(1)}x) — situación financiera cómoda.` });
    else if (f.debtEquity <= 2.5) rows.push({ level: 'neutral', title: 'Deuda moderada', text: `Deuda razonable (${f.debtEquity.toFixed(1)}x su capital) — normal en muchos sectores.` });
    else rows.push({ level: 'warn', title: 'Deuda alta', text: `Tiene bastante deuda (${f.debtEquity.toFixed(1)}x su capital) — más sensible a subas de tasas.` });
  }
  // Dividendos
  if (dividends?.items?.length && dividends.ttm > 0) {
    const yld = f.dividendYield;
    rows.push({ level: 'good', title: 'Paga dividendos', text: `Reparte ganancias entre sus accionistas${yld != null ? ` (rinde ~${yld.toFixed(1)}% al año)` : ''}${dividends.nextExDate ? ` · próximo pago estimado ${dividends.nextExDate}` : ''}.` });
  } else {
    rows.push({ level: 'neutral', title: 'No paga dividendos', text: 'Reinvierte sus ganancias en crecer en vez de repartirlas — típico de empresas en expansión.' });
  }
  // Próximo balance
  if (earnings?.nextDate && daysToEarnings != null && daysToEarnings >= 0 && daysToEarnings <= 14) {
    rows.push({ level: 'warn', title: 'Reporta balance pronto', text: `Presenta resultados ${daysToEarnings === 0 ? 'hoy' : `en ${daysToEarnings} día(s)`} (${earnings.nextDate}) — suele haber más volatilidad alrededor.` });
  }
  return rows;
}

function didacticCardHTML(row) {
  return `<div class="didactic-row">
    <span class="didactic-dot" style="background:${VERDICT_COLOR[row.level]};">${VERDICT_ICON[row.level]}</span>
    <div><div class="didactic-title">${esc(row.title)}</div><div class="didactic-text">${esc(row.text)}</div></div>
  </div>`;
}

function technicalMetricRows(t, confluence, marketCorrelation, relativeStrength) {
  const nearestFib = Object.entries(t.fib.levels).sort((a, b) => Math.abs(a[1] - t.price) - Math.abs(b[1] - t.price))[0];
  const confluenceValue = !confluence ? 'N/D — historial semanal insuficiente'
    : `${confluence.agreeCount}/${confluence.checksAvailable} señales (EMA/RSI/MACD) a favor de ${BIAS_LABEL[confluence.dailyBias]}`;
  const corrValue = !marketCorrelation || marketCorrelation.correlation == null ? 'N/D'
    : `${marketCorrelation.correlation.toFixed(2)} (beta ${marketCorrelation.beta.toFixed(2)})`;
  const rsValue = !relativeStrength ? 'N/D'
    : `${relativeStrength.trend === 'up' ? 'Liderando al mercado' : 'Rezagando vs. mercado'}${relativeStrength.isNewHigh ? ' — ★ máximo de fuerza relativa' : ''}`;
  const pocValue = t.volumeProfile?.hasData ? `$${t.volumeProfile.poc.toFixed(2)} (zona ${t.volumeProfile.vaLow.toFixed(2)}–${t.volumeProfile.vaHigh.toFixed(2)})` : 'N/D — sin volumen';
  const squeezeValue = !t.squeeze ? 'N/D'
    : t.squeeze.justFired ? `⚡ Liberado (tras ${t.squeeze.barsInSqueeze} ruedas comprimido)`
    : t.squeeze.active ? `Activo (${t.squeeze.barsInSqueeze} ruedas comprimido)`
    : 'Sin compresión';
  return [
    { label: 'Confirmación semanal (multi-TF)', value: confluenceValue },
    { label: 'Fuerza Relativa vs SPY', value: rsValue },
    { label: 'Correlación / Beta vs SPY', value: corrValue },
    { label: 'Punto de Control de Volumen (POC)', value: pocValue },
    { label: 'Patrón de vela', value: t.candlePattern ? t.candlePattern.label : 'Sin patrón detectado' },
    { label: 'Squeeze de volatilidad (Bollinger/Keltner)', value: squeezeValue },
    { label: 'Índice de Fuerza de Tendencia', value: t.trendStrength ? `${t.trendStrength.value}/100 — ${t.trendStrength.label}` : 'N/D' },
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

function lastDividendLabel(dividends) {
  const items = dividends?.items ?? [];
  if (!items.length) return 'Sin pagos registrados';
  const last = items[0];
  const freq = dividends.frequency ? ` · ${dividends.frequency}` : '';
  return `${fmtUsd(last.amount)} el ${last.date}${freq}`;
}

function fundamentalMetricRows(f, earnings, daysToEarnings, dividends) {
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
    { label: 'PEG', value: f.peg == null ? 'N/D' : `${f.peg.toFixed(1)}x${f.pegComputed ? ' (calc.)' : ''}` },
    { label: 'PB / PS', value: `${x(f.pb)} / ${x(f.ps)}` },
    { label: 'EV/EBITDA', value: x(f.evEbitda) },
    { label: 'ROE / ROIC', value: `${pct(f.roe)} / ${pct(f.roi)}` },
    { label: 'Margen bruto / neto', value: `${pct(f.grossMargin)} / ${pct(f.netMargin)}` },
    { label: 'Debt/Equity', value: f.debtEquity != null ? f.debtEquity.toFixed(2) : 'N/D' },
    { label: 'Dividend Yield (TTM)', value: pct(f.dividendYield) },
    { label: 'Último dividendo pagado', value: lastDividendLabel(dividends) },
    { label: 'Próximo ex-dividend (est.)', value: dividends?.items?.length && dividends.nextExDate ? `${dividends.nextExDate} (estimado por cadencia)` : 'N/D' },
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
  { view: 'simulator', label: 'Simulador "¿Y si...?"', icon: 'shuffle' },
  { view: 'watchlist', label: 'Watchlist', icon: 'bookmark' },
  { view: 'bonds', label: 'Bonos Argentinos', icon: 'building' },
  { view: 'screener', label: 'Screener', icon: 'filter' },
  { view: 'shorttrades', label: 'Trades Cortos', icon: 'zap' },
  { view: 'gaps', label: 'Radar de Gaps', icon: 'gap' },
  { view: 'dividends', label: 'Dividendos', icon: 'coins' },
  { view: 'compare', label: 'Comparador', icon: 'compare' },
  { view: 'macro', label: 'Noticias & Macro', icon: 'globe' },
  { view: 'alerts', label: 'Alertas', icon: 'warning' },
  { view: 'calendar', label: 'Calendario Económico', icon: 'calendar' },
  { view: 'backtest', label: 'Backtesting', icon: 'trend' },
  { view: 'trackrecord', label: 'Track Record del Motor', icon: 'award' },
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
        <button class="sidebar-nav-btn ${activeView === item.view ? 'active' : ''}" data-view="${item.view}" ${activeView === item.view ? 'aria-current="page"' : ''}>
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
      closeMobileSidebar();
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
  return `<div class="watch-card ${am ? 'has-alert' : ''} ${d.alert?.pending ? 'is-pending' : ''}" data-dash-ticker="${esc(ticker)}" style="${am ? `border-color:${am.color};` : ''}">
    <div class="watch-ticker">${esc(ticker)}${d.isReal === false ? ' <span class="watch-stale">demo</span>' : ''}</div>
    <div class="watch-name">${esc(d.name ?? '')}</div>
    <div class="watch-price">${fmtUsd(d.price)}</div>
    <div class="watch-change ${up ? 'up' : 'down'}">${fmtPct(d.changePct)}</div>
    ${sparklineSVG(d.sparkline, up)}
    <div class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(d.scoreLabel)} · ${d.score}</div>
    ${d.highlight ? `<div class="watch-highlight">${esc(d.highlight)}</div>` : ''}
    ${am ? `<div class="watch-alert" style="color:${am.color};"${alertTitleAttr(d.alert)}>⚡ ${esc(am.label)}${alertConfidenceSuffix(d.alert)}</div>` : ''}
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

  // Heatmap sectorial: performance PROMEDIO DEL DÍA (%change), no el score —
  // es una vista de "rotación sectorial" (qué sectores lideran/rezagan hoy),
  // complementaria al ranking de score promedio de arriba. Mismos datos ya
  // cargados del universo curado, sin pedidos nuevos.
  const bySectorChange = {};
  for (const e of loaded) {
    if (!e.d.sector) continue;
    if (!bySectorChange[e.d.sector]) bySectorChange[e.d.sector] = { sum: 0, count: 0 };
    bySectorChange[e.d.sector].sum += e.d.changePct; bySectorChange[e.d.sector].count++;
  }
  const heatmapRows = Object.entries(bySectorChange)
    .map(([sector, s]) => ({ sector, avgChange: s.sum / s.count, count: s.count }))
    .sort((a, b) => b.avgChange - a.avgChange);

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

    ${dashCustomizeButtonHTML()}
    ${dashWidgetState.customizeOpen ? dashCustomizePanelHTML() : ''}

    ${(() => {
      const widgetHtml = {
        opportunities: `
          ${sectionTitleHTML('Oportunidades del Día', 'trend', 'margin-top:28px;')}
          ${!opportunities.length ? `<div class="card watch-empty">Cargando universo curado…</div>` : `<div class="watch-grid">${opportunities.map(({ ticker, d }) => dashCardHTML(ticker, d)).join('')}</div>`}
          ${loadingCount > 0 ? `<div class="dash-loading-note">Cargando ${loadingCount} activo(s) más del universo curado…</div>` : ''}
        `,
        buyzone: `
          ${sectionTitleHTML('En Zona de Compra Ahora', 'target')}
          <div class="dash-intro" style="margin-bottom:14px;">Activos del universo curado cuyo precio está, ahora mismo, en zona de compra o recién rompió el soporte según el análisis técnico (mismo criterio que las alertas de Seguimiento) — no es una recomendación, es dónde está el precio respecto al plan operativo de cada uno.</div>
          ${!loaded.length ? `<div class="card watch-empty">Cargando universo curado…</div>` : !buyZone.length ? `<div class="card watch-empty">Ningún activo del universo curado está en zona de compra en este momento.</div>` : `<div class="watch-grid">${buyZone.map(({ ticker, d }) => dashCardHTML(ticker, d)).join('')}</div>`}
        `,
        argentina: (() => {
          const arRows = loaded.filter(e => AR_TICKERS.has(e.ticker)).sort((a, b) => b.d.changePct - a.d.changePct);
          const rp = dashState.macro?.riesgoPaisArg;
          const cclRef = dashState.ccl?.value ?? arRows.find(e => e.d.cclRef)?.d.cclRef ?? null;
          return `
          ${sectionTitleHTML('Panel Argentina', 'flag')}
          <div class="dash-intro" style="margin-bottom:14px;">Todas las empresas argentinas con cotización real en NYSE/Nasdaq (análisis sobre el ADR en USD, precio local BYMA en vivo cuando está disponible).${rp != null ? ` Riesgo país: <strong>${Math.round(rp)} pb</strong>.` : ''}${cclRef ? ` CCL de referencia: <strong>${fmtArs(cclRef)}</strong>.` : ''} El "dólar implícito" es a cuánto está comprando dólar quien paga el precio en pesos de cada papel — si está muy por encima del CCL, el papel está caro en pesos hoy.</div>
          ${!arRows.length ? `<div class="card watch-empty">Cargando panel argentino…</div>` : `
          <div class="card bt-table-card">
            <div class="bt-table-wrap">
              <table class="bt-table">
                <thead><tr><th>Ticker</th><th>USD</th><th>% día</th><th>ARS (BYMA)</th><th>Dólar implícito</th><th>Señal</th></tr></thead>
                <tbody>
                  ${arRows.map(({ ticker, d }) => {
                    const sig = scoreLabelColor(d.scoreLabel);
                    const spread = d.cclImplied != null && cclRef ? (d.cclImplied / cclRef - 1) * 100 : null;
                    return `<tr class="port-row" data-dash-ticker="${esc(ticker)}">
                      <td class="bt-label-cell" style="font-weight:700;">${esc(ticker)} <span class="port-pnl-abs">${esc(d.name)}</span></td>
                      <td>${fmtUsd(d.price)}</td>
                      <td class="${d.changePct >= 0 ? 'bt-pos' : 'bt-neg'}">${fmtPct(d.changePct)}</td>
                      <td>${d.cedearArs != null ? `${fmtArs(d.cedearArs)} ${d.cedearSource === 'live' ? '●' : '≈'}` : '—'}</td>
                      <td>${d.cclImplied != null ? `${fmtArs(d.cclImplied)}${spread != null ? ` <span class="${Math.abs(spread) < 1.5 ? 'bt-nd' : spread > 0 ? 'bt-neg' : 'bt-pos'}" title="Diferencia vs CCL de referencia — positivo: caro en pesos; negativo: barato en pesos">(${spread >= 0 ? '+' : ''}${spread.toFixed(1)}%)</span>` : ''}` : '—'}
                      <td><span class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(d.scoreLabel)} · ${d.score}</span></td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>`}
        `;
        })(),
        cripto: (() => {
          const rows = loaded.filter(e => CRYPTO_RELATED.has(e.ticker));
          const btc = dashState.data['BTC'];
          const ordered = rows.slice().sort((a, b) => (a.ticker === 'BTC' ? -1 : b.ticker === 'BTC' ? 1 : b.d.score - a.d.score));
          return `
          ${sectionTitleHTML('Termómetro Cripto', 'zap')}
          <div class="dash-intro" style="margin-bottom:14px;">Bitcoin/Ethereum, los CEDEARs de empresas cripto que operan en BYMA (MSTR, RIOT, HUT, IREN) y los ETFs spot. La correlación y el beta vs BTC (últimas ~220 ruedas) miden cuánto amplifica cada acción los movimientos de bitcoin — beta 2 significa que históricamente se movió ~2% por cada 1% de BTC.</div>
          ${!ordered.length ? `<div class="card watch-empty">Cargando activos cripto…</div>` : `
          <div class="card bt-table-card">
            <div class="bt-table-wrap">
              <table class="bt-table">
                <thead><tr><th>Activo</th><th>Precio</th><th>% día</th><th>Correlación vs BTC</th><th>Beta vs BTC</th><th>Señal</th></tr></thead>
                <tbody>
                  ${ordered.map(({ ticker, d }) => {
                    const sig = scoreLabelColor(d.scoreLabel);
                    const cb = ticker !== 'BTC' && btc?.closes && d.closes ? correlationAndBeta(d.closes, btc.closes) : null;
                    return `<tr class="port-row" data-dash-ticker="${esc(ticker)}">
                      <td class="bt-label-cell" style="font-weight:700;">${esc(ticker)} <span class="port-pnl-abs">${esc(d.name)}</span></td>
                      <td>${fmtUsd(d.price)}</td>
                      <td class="${d.changePct >= 0 ? 'bt-pos' : 'bt-neg'}">${fmtPct(d.changePct)}</td>
                      <td>${ticker === 'BTC' ? '<span class="bt-nd">—</span>' : cb?.correlation != null ? cb.correlation.toFixed(2) : '<span class="bt-nd">N/D</span>'}</td>
                      <td>${ticker === 'BTC' ? '<span class="bt-nd">—</span>' : cb?.beta != null ? `<span class="${Math.abs(cb.beta) >= 1.5 ? 'bt-neg' : ''}">${cb.beta.toFixed(2)}</span>` : '<span class="bt-nd">N/D</span>'}</td>
                      <td><span class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(d.scoreLabel)} · ${d.score}</span></td>
                    </tr>`;
                  }).join('')}
                </tbody>
              </table>
            </div>
          </div>`}
        `;
        })(),
        heatmap: `
          ${sectionTitleHTML('Heatmap Sectorial', 'grid')}
          <div class="dash-intro" style="margin-bottom:14px;">Performance promedio del día por sector, sobre el mismo universo curado — panorama de rotación sectorial de un vistazo (qué sectores lideran/rezagan hoy, no el score).</div>
          ${!heatmapRows.length ? `<div class="card watch-empty">Cargando universo curado…</div>` : `
          <div class="heatmap-grid">
            ${heatmapRows.map(s => {
              const pct = clampNum(s.avgChange, -5, 5);
              const intensity = Math.min(1, Math.abs(pct) / 5);
              const bg = s.avgChange >= 0 ? `oklch(${0.30 + intensity * 0.12} ${0.05 + intensity * 0.10} 152)` : `oklch(${0.30 + intensity * 0.12} ${0.05 + intensity * 0.12} 23)`;
              const fg = s.avgChange >= 0 ? `oklch(${0.80 + intensity * 0.08} ${0.10 + intensity * 0.08} 152)` : `oklch(${0.80 + intensity * 0.08} ${0.10 + intensity * 0.08} 23)`;
              return `<div class="heatmap-cell" style="background:${bg}; color:${fg};">
                <div class="heatmap-cell-sector">${esc(s.sector)}</div>
                <div class="heatmap-cell-pct">${s.avgChange >= 0 ? '+' : ''}${s.avgChange.toFixed(1)}%</div>
                <div class="heatmap-cell-count">${s.count} activo${s.count === 1 ? '' : 's'}</div>
              </div>`;
            }).join('')}
          </div>`}
        `,
        radar: `
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
        `,
      };
      return dashWidgetState.order
        .filter(k => widgetHtml[k] && !dashWidgetState.hidden.has(k))
        .map(k => widgetHtml[k]).join('');
    })()}

    ${dashBottomWidgetsHTML()}`;
}

function dashCustomizeButtonHTML() {
  return `<button class="dash-customize-btn" id="dash-customize-toggle" aria-expanded="${dashWidgetState.customizeOpen}">
    ${ICONS.gear}<span>Personalizar Dashboard</span>
  </button>`;
}

function dashCustomizePanelHTML() {
  return `
  <div class="dash-customize-panel" role="region" aria-label="Personalizar widgets del dashboard">
    <div class="dash-customize-hint">Mostrá, ocultá o reordená las secciones del Dashboard. La preferencia se guarda solo en este navegador.</div>
    <div class="dash-customize-list">
      ${dashWidgetState.order.map((key, i) => {
        const w = DASH_WIDGETS.find(x => x.key === key);
        if (!w) return '';
        const hidden = dashWidgetState.hidden.has(key);
        return `<div class="dash-customize-row ${hidden ? 'is-hidden' : ''}">
          <label class="dash-customize-check">
            <input type="checkbox" data-widget-toggle="${key}" ${hidden ? '' : 'checked'} />
            <span>${esc(w.label)}</span>
          </label>
          <div class="dash-customize-move">
            <button data-widget-up="${key}" ${i === 0 ? 'disabled' : ''} aria-label="Subir ${esc(w.label)}" title="Subir">↑</button>
            <button data-widget-down="${key}" ${i === dashWidgetState.order.length - 1 ? 'disabled' : ''} aria-label="Bajar ${esc(w.label)}" title="Bajar">↓</button>
          </div>
        </div>`;
      }).join('')}
    </div>
    <button class="dash-customize-reset" id="dash-customize-reset">Restablecer orden y visibilidad</button>
  </div>`;
}

function dashBottomWidgetsHTML() {
  const watchTickers = getWatchlist().slice(0, 6);
  const holdings = getPortfolio();
  const stats = holdings.length ? computePortfolioStats(holdings) : null;

  const blocks = {
    watchlist: `
      <div>
        <div class="panel-header">
          ${sectionTitleHTML('Watchlist Rápido', 'bookmark', 'margin-bottom:0;')}
          <a class="dash-widget-link" data-goto-view="watchlist">Ver Watchlist completa ›</a>
        </div>
        ${!watchTickers.length ? emptyStateHTML('bookmark', 'Todavía no agregaste activos a tu Watchlist.') : `
        <div class="watch-grid watch-grid-compact">${watchTickers.map(watchCardHTML).join('')}</div>`}
      </div>`,
    portfolio: `
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
      </div>`,
  };

  const visible = dashWidgetState.order.filter(k => blocks[k] && !dashWidgetState.hidden.has(k));
  if (!visible.length) return '';
  return `<div class="grid2 ${visible.length === 1 ? 'grid2-single' : ''}">${visible.map(k => blocks[k]).join('')}</div>`;
}

function wireDashboardEvents() {
  els.report.querySelectorAll('[data-dash-ticker]').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.dashTicker));
  });
  // Las tarjetas de "Oportunidades del Día"/"En Zona de Compra" (dashCardHTML)
  // también tienen la clase .watch-card pero usan data-dash-ticker, no
  // data-ticker — sin este filtro, el handler de abajo (pensado para las
  // tarjetas de Watchlist Rápido) también se enganchaba a esas mismas
  // tarjetas y disparaba selectTicker(undefined) justo después del click
  // correcto, pisándolo.
  els.report.querySelectorAll('.watch-card').forEach(el => {
    if (el.dataset.dashTicker) return;
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

  const customizeBtn = document.getElementById('dash-customize-toggle');
  if (customizeBtn) customizeBtn.addEventListener('click', () => {
    dashWidgetState.customizeOpen = !dashWidgetState.customizeOpen;
    renderReport();
  });
  els.report.querySelectorAll('[data-widget-toggle]').forEach(cb => {
    cb.addEventListener('change', () => {
      const key = cb.dataset.widgetToggle;
      if (cb.checked) dashWidgetState.hidden.delete(key); else dashWidgetState.hidden.add(key);
      saveDashWidgetState();
      renderReport();
    });
  });
  els.report.querySelectorAll('[data-widget-up]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.widgetUp;
      const idx = dashWidgetState.order.indexOf(key);
      if (idx > 0) {
        [dashWidgetState.order[idx - 1], dashWidgetState.order[idx]] = [dashWidgetState.order[idx], dashWidgetState.order[idx - 1]];
        saveDashWidgetState();
        renderReport();
      }
    });
  });
  els.report.querySelectorAll('[data-widget-down]').forEach(btn => {
    btn.addEventListener('click', () => {
      const key = btn.dataset.widgetDown;
      const idx = dashWidgetState.order.indexOf(key);
      if (idx < dashWidgetState.order.length - 1) {
        [dashWidgetState.order[idx + 1], dashWidgetState.order[idx]] = [dashWidgetState.order[idx], dashWidgetState.order[idx + 1]];
        saveDashWidgetState();
        renderReport();
      }
    });
  });
  const resetBtn = document.getElementById('dash-customize-reset');
  if (resetBtn) resetBtn.addEventListener('click', () => {
    dashWidgetState.order = DASH_WIDGET_KEYS.slice();
    dashWidgetState.hidden = new Set();
    saveDashWidgetState();
    renderReport();
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
const screenerState = { minScore: 0, category: 'all', sector: 'all', signal: 'all', rsiFilter: 'all', sortBy: 'score', quick: 'all' };
const SCREENER_QUICK_FILTERS = [
  { key: 'all', label: 'Todo el universo' },
  { key: 'argentina', label: '🇦🇷 Argentina' },
  { key: 'cripto', label: '₿ Cripto' },
];

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
  if (screenerState.quick === 'argentina') rows = rows.filter(e => AR_TICKERS.has(e.ticker));
  else if (screenerState.quick === 'cripto') rows = rows.filter(e => CRYPTO_RELATED.has(e.ticker));
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
    <div class="screener-quick-filters">
      ${SCREENER_QUICK_FILTERS.map(q => `<button class="screener-quick-chip ${screenerState.quick === q.key ? 'active' : ''}" data-quick="${q.key}">${esc(q.label)}</button>`).join('')}
    </div>
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
  els.report.querySelectorAll('.screener-quick-chip').forEach(el => {
    el.addEventListener('click', () => { screenerState.quick = el.dataset.quick; renderReport(); });
  });
  els.report.querySelectorAll('.screener-row').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.ticker));
  });
}

/* ───────────────────────── dividendos + ex-dividend ─────────────────────────
 * Universo curado de pagadores de dividendos conocidos. Se carga el historial
 * real (Yahoo, vía /api/dividends) de cada uno para el calendario de próximos
 * ex-dividends, el ranking por yield y el detalle por activo. Las acciones que
 * no pagan dividendos (MELI, NVDA marginal, cripto) no van acá. */
const DIVIDEND_UNIVERSE = [
  'KO', 'JNJ', 'PG', 'PEP', 'MCD', 'WMT', 'HD', 'MMM', 'CL', 'KMB', 'GIS', 'MDLZ', 'MO', 'PM',
  'XOM', 'CVX', 'COP', 'KMI', 'VZ', 'T', 'IBM', 'CSCO', 'TXN', 'AVGO', 'QCOM', 'AAPL', 'MSFT',
  'JPM', 'BAC', 'WFC', 'C', 'GS', 'MS', 'AXP', 'BLK', 'PFE', 'MRK', 'ABBV', 'AMGN', 'JNJ',
  'CAT', 'DE', 'LMT', 'RTX', 'HON', 'UPS', 'NKE', 'SBUX', 'LOW', 'TGT', 'GGAL', 'BMA', 'SPY', 'DIA',
];
const divState = { data: {}, prices: {}, loading: new Set(), started: false, sortBy: 'nextEx', detailTicker: '', detail: null, detailLoading: false };

function dividendPrice(ticker) {
  return dashState.data[ticker]?.price ?? watchState.data[ticker]?.price ?? portState.data[ticker]?.price ?? divState.prices[ticker] ?? null;
}
function dividendYield(ticker, ttm) {
  const price = dividendPrice(ticker);
  return price && ttm > 0 ? (ttm / price) * 100 : null;
}
function daysUntil(isoDate) {
  if (!isoDate) return null;
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  return Math.round((new Date(isoDate + 'T00:00:00Z') - today) / 86400000);
}
function fmtShortDate(iso) {
  if (!iso) return 'N/D';
  const M = ['ene', 'feb', 'mar', 'abr', 'may', 'jun', 'jul', 'ago', 'sep', 'oct', 'nov', 'dic'];
  const d = new Date(iso + 'T00:00:00Z');
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}
const MONTHS_ES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];

/** Consistencia de dividendos sobre el historial disponible (hasta 5 años):
 *  cuántos años pagó, si el total anual viene creciendo (o al menos no cae) y
 *  si hubo recortes. Devuelve un score 0-100 determinístico y sus partes.
 *  No pretende identificar "aristócratas" de 25 años (no hay dato gratuito de
 *  esa profundidad) — mide la consistencia en la ventana real disponible. */
function dividendConsistency(items) {
  if (!items?.length) return null;
  const byYear = {};
  for (const x of items) { const y = x.date.slice(0, 4); byYear[y] = (byYear[y] || 0) + x.amount; }
  // Solo años completos: se descarta el año en curso (parcial) para no
  // contar un año a medias como "recorte".
  const thisYear = String(new Date().getUTCFullYear());
  const years = Object.keys(byYear).filter(y => y !== thisYear).sort();
  if (years.length < 2) return { score: null, years: years.length, insufficient: true };
  const totals = years.map(y => byYear[y]);
  let ups = 0, cuts = 0;
  for (let i = 1; i < totals.length; i++) {
    if (totals[i] >= totals[i - 1] * 0.999) ups++;
    if (totals[i] < totals[i - 1] * 0.9) cuts++;
  }
  const growthFrac = ups / (totals.length - 1);
  const yearsScore = Math.min(1, years.length / 5);
  const cagr = totals[0] > 0 ? Math.pow(totals[totals.length - 1] / totals[0], 1 / (totals.length - 1)) - 1 : 0;
  const score = Math.round((yearsScore * 0.35 + growthFrac * 0.45 + (cuts === 0 ? 0.2 : 0)) * 100);
  return { score, years: years.length, growthFrac, cuts, cagr: cagr * 100, annualTotals: years.map((y, i) => ({ year: y, total: totals[i] })) };
}

/** Cuántas unidades del activo SUBYACENTE representa una tenencia: si se cargó
 *  en CEDEARs (costo ARS), se divide por el ratio; si son acciones (USD), es
 *  la cantidad tal cual. */
function underlyingShares(r) {
  const isCedearUnits = r.costCurrency === 'ARS';
  return isCedearUnits && r.d?.ratio ? r.shares / r.d.ratio : r.shares;
}

/** Proyección de ingresos por dividendos de la cartera para los próximos 12
 *  meses, mes a mes: para cada tenencia con datos de dividendos se proyectan
 *  las fechas ex-dividend (desde la próxima estimada, por la cadencia) y se
 *  imputa monto × unidades subyacentes al mes correspondiente. */
function projectDividendIncome(holdings) {
  const now = new Date();
  const buckets = Array.from({ length: 12 }, (_, i) => {
    const d = new Date(now.getFullYear(), now.getMonth() + i, 1);
    return { key: `${d.getFullYear()}-${d.getMonth()}`, label: MONTHS_ES[d.getMonth()], year: d.getFullYear(), amount: 0, byTicker: {} };
  });
  const bucketIndex = (dt) => (dt.getFullYear() - now.getFullYear()) * 12 + (dt.getMonth() - now.getMonth());
  let total = 0, covered = 0, uncovered = [];
  for (const h of holdings) {
    const div = divState.data[h.ticker] ?? portState.dividends?.[h.ticker];
    const d = h.d ?? dashState.data[h.ticker] ?? portState.data[h.ticker];
    if (!div?.items?.length || !div.nextExDate || !div.medianIntervalDays || div.lastAmount == null) { uncovered.push(h.ticker); continue; }
    const units = underlyingShares({ ...h, d });
    if (!(units > 0)) continue;
    covered++;
    let t = new Date(div.nextExDate + 'T00:00:00Z');
    const horizon = new Date(now.getFullYear(), now.getMonth() + 12, 1);
    let guard = 0;
    while (t < horizon && guard < 15) {
      const idx = bucketIndex(t);
      if (idx >= 0 && idx < 12) {
        const inc = div.lastAmount * units;
        buckets[idx].amount += inc;
        buckets[idx].byTicker[h.ticker] = (buckets[idx].byTicker[h.ticker] || 0) + inc;
        total += inc;
      }
      t = new Date(t.getTime() + div.medianIntervalDays * 86400000);
      guard++;
    }
  }
  return { buckets, total, covered, uncovered };
}

/** DRIP: proyección simple de la diferencia entre reinvertir los dividendos y
 *  cobrarlos, sobre N años, a yield y crecimiento constantes (supuestos
 *  explícitos: precio estable, reinversión al mismo precio, antes de
 *  impuestos). No es una promesa de retorno — es el efecto del interés
 *  compuesto del dividendo, aislado. */
function dripProjection(value, yieldPct, growthPct, years) {
  if (!value || !yieldPct) return null;
  const y = yieldPct / 100, g = (growthPct ?? 0) / 100;
  let reinvested = value, cashPile = 0, base = value;
  for (let k = 0; k < years; k++) {
    const yld = y * Math.pow(1 + g, k);
    reinvested *= (1 + yld);           // dividendo reinvertido compone
    cashPile += base * yld * Math.pow(1 + g, k); // dividendo cobrado, se acumula sin componer
  }
  const reinvestedGain = reinvested - value;
  return { reinvestedGain, cashGain: cashPile, extra: reinvestedGain - cashPile, finalValue: reinvested };
}

// Comisión de custodia típica que cobran los agentes locales sobre el
// dividendo acreditado de un CEDEAR (aproximada — varía por bróker).
const CEDEAR_DIVIDEND_FEE = 0.005;
function netCedearPesoDividend(amountUsdPerShare, ratio, cclValue) {
  if (amountUsdPerShare == null || !ratio || !cclValue) return null;
  const perCedearUsd = amountUsdPerShare / ratio;
  const grossArs = perCedearUsd * cclValue;
  return { grossArs, netArs: grossArs * (1 - CEDEAR_DIVIDEND_FEE), perCedearUsd };
}

async function loadDividendsData() {
  divState.started = true;
  if (!dashState.started) loadDashboardData(); // precios para calcular el yield
  if (!portState.ccl) { try { portState.ccl = await getCCL(); } catch (_) {} } // para el neto por CEDEAR en pesos
  // Universo de pagadores + las tenencias de la cartera del usuario (para la
  // proyección de ingresos), sin duplicar.
  const wanted = [...new Set([...DIVIDEND_UNIVERSE, ...getPortfolio().map(h => h.ticker)])];
  const pending = wanted.filter(t => !(t in divState.data) && !divState.loading.has(t));
  for (let i = 0; i < pending.length; i += 6) {
    const batch = pending.slice(i, i + 6);
    await Promise.all(batch.map(async (ticker) => {
      divState.loading.add(ticker);
      try {
        divState.data[ticker] = await getDividends(ticker);
        // Precio para el yield: si el ticker no está en el universo del
        // Dashboard (no tiene precio cacheado), se pide su quote — cacheada
        // 60s, sin multiplicar pedidos entre renders.
        if (dividendPrice(ticker) == null) {
          try { divState.prices[ticker] = (await getQuote(ticker))?.usd ?? null; } catch (_) {}
        }
      } catch (e) { divState.data[ticker] = { items: [], error: true }; }
      finally {
        divState.loading.delete(ticker);
        if (!state.asset && state.view === 'dividends') renderReport();
      }
    }));
    if (i + 6 < pending.length) await new Promise(res => setTimeout(res, 250));
  }
}

/** Backtest de "captura de dividendo": para cada ex-dividend histórico simula
 *  comprar al cierre del día previo al ex-date y medir el resultado neto
 *  (variación del precio + dividendo cobrado) a distintos horizontes, más
 *  cuántas ruedas tardó el precio en recuperar la caída del ex-date. Todo con
 *  velas reales, sin look-ahead más allá del horizonte medido. */
function dividendCaptureStats(candles, items) {
  const idxByDate = {};
  for (let i = 0; i < candles.t.length; i++) idxByDate[candles.t[i]] = i;
  const HORIZONS = [1, 5, 10];
  const results = HORIZONS.map(h => ({ h, nets: [] }));
  let recoveryDays = [];
  let events = 0;
  for (const x of items) {
    let exIdx = idxByDate[x.date];
    if (exIdx == null) { // buscar la primera rueda >= ex-date
      for (let i = 0; i < candles.t.length; i++) if (candles.t[i] >= x.date) { exIdx = i; break; }
    }
    if (exIdx == null || exIdx < 1) continue;
    const entry = candles.c[exIdx - 1];
    if (!(entry > 0)) continue;
    events++;
    for (const r of results) {
      const out = candles.c[exIdx + r.h];
      if (out == null) continue;
      r.nets.push((out - entry + x.amount) / entry);
    }
    // recuperación: ruedas hasta volver al precio de entrada (máx 40)
    for (let k = exIdx; k < Math.min(candles.c.length, exIdx + 40); k++) {
      if (candles.c[k] >= entry) { recoveryDays.push(k - exIdx); break; }
    }
  }
  if (!events) return null;
  const rows = results.filter(r => r.nets.length).map(r => {
    const avg = r.nets.reduce((s, v) => s + v, 0) / r.nets.length;
    const wins = r.nets.filter(v => v > 0).length;
    return { h: r.h, n: r.nets.length, avgPct: avg * 100, winRate: Math.round((wins / r.nets.length) * 100) };
  });
  const avgRecovery = recoveryDays.length ? Math.round(recoveryDays.reduce((s, v) => s + v, 0) / recoveryDays.length) : null;
  return { events, rows, avgRecovery, recoveredFrac: events ? recoveryDays.length / events : 0 };
}

async function loadDividendDetail(ticker) {
  divState.detailTicker = ticker;
  divState.detail = null;
  divState.detailLoading = true;
  renderReport();
  try {
    const [div, quote, asset, candles] = await Promise.all([getDividends(ticker), getQuote(ticker), getAsset(ticker), getCandles(ticker, '1day', 500).catch(() => null)]);
    const capture = candles?.c?.length && div?.items?.length ? dividendCaptureStats(candles, div.items) : null;
    divState.detail = { ticker, div, price: quote?.usd ?? null, cedearArs: quote?.cedearArs ?? null, ratio: quote?.ratio ?? asset?.ratio ?? null, name: asset?.name ?? ticker, capture };
  } catch (e) {
    divState.detail = { ticker, error: String(e) };
  } finally {
    divState.detailLoading = false;
    if (state.view === 'dividends') renderReport();
  }
}

/** Proyección de ingresos por dividendos de la cartera real, 12 meses. */
function dividendIncomeCardHTML() {
  const holdings = getPortfolio();
  if (!holdings.length) return '';
  const rows = holdings.map(h => ({ ...h, d: portState.data[h.ticker] ?? dashState.data[h.ticker] }));
  const proj = projectDividendIncome(rows);
  if (proj.total <= 0) {
    const anyLoading = holdings.some(h => !(h.ticker in divState.data) && !(portState.dividends && h.ticker in portState.dividends));
    return `
    ${sectionTitleHTML('Ingresos por Dividendos — tu Cartera (12 meses)', 'coins')}
    <div class="card watch-empty">${anyLoading ? 'Cargando dividendos de tu cartera…' : 'Ninguna de tus tenencias paga dividendos (o todavía no hay historial). Cargá pagadores en Portfolio Advisor para ver la proyección.'}</div>`;
  }
  const maxM = Math.max(...proj.buckets.map(b => b.amount));
  return `
    ${sectionTitleHTML('Ingresos por Dividendos — tu Cartera (12 meses)', 'coins')}
    <div class="card port-notes-card">
      <div class="port-ops-summary" style="margin-bottom:16px;">
        <div class="risk-metric"><div class="risk-metric-label">Ingreso proyectado (12 meses)</div><div class="risk-metric-value up">${fmtUsd(proj.total)}</div><div class="risk-metric-hint">${proj.covered} tenencia(s) pagadora(s)</div></div>
        <div class="risk-metric"><div class="risk-metric-label">Promedio mensual</div><div class="risk-metric-value">${fmtUsd(proj.total / 12)}</div></div>
      </div>
      <div class="div-bars" style="height:130px;">
        ${proj.buckets.map(b => `<div class="div-bar-col" title="${b.label} ${b.year}: ${fmtUsd(b.amount)}${Object.keys(b.byTicker).length ? ' · ' + Object.entries(b.byTicker).map(([t, v]) => `${t} ${fmtUsd(v)}`).join(', ') : ''}"><div class="div-bar" style="height:${maxM > 0 ? Math.max(2, Math.round((b.amount / maxM) * 100)) : 2}px;"></div><div class="div-bar-label">${b.label}</div></div>`).join('')}
      </div>
      <div class="bt-disclaimer">Proyección sobre las fechas ex-dividend estimadas y el último monto por pago × tus unidades — antes de comisiones y retenciones. ${proj.uncovered.length ? `Sin datos de dividendos para: ${proj.uncovered.slice(0, 8).join(', ')}.` : ''}</div>
    </div>`;
}

/** Ranking de consistencia de pago sobre el historial disponible (hasta 5a). */
function dividendConsistencyCardHTML(loaded) {
  const rows = loaded.map(({ t, d }) => {
    const c = dividendConsistency(d.items);
    return c && c.score != null ? { ticker: t, name: universe.find(a => a.ticker === t)?.name ?? t, ...c, isAr: AR_TICKERS.has(t) } : null;
  }).filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 12);
  if (!rows.length) return '';
  return `
    ${sectionTitleHTML('Consistencia de Dividendos', 'check')}
    <div class="dash-intro" style="margin-bottom:14px;">Qué tan consistente fue cada pagador en el historial disponible (hasta 5 años): años que pagó, si el total anual viene creciendo y si hubo recortes. No es la lista de "aristócratas" de 25 años (no hay dato gratuito de esa profundidad) — es la consistencia en la ventana real.</div>
    <div class="card bt-table-card">
      <div class="bt-table-wrap">
        <table class="bt-table">
          <thead><tr><th>Activo</th><th>Consistencia</th><th>Años</th><th>Crecimiento anual</th><th>Recortes</th></tr></thead>
          <tbody>
            ${rows.map(r => `
              <tr class="port-row" data-div-ticker="${esc(r.ticker)}">
                <td class="bt-label-cell" style="font-weight:700;">${esc(r.ticker)}${r.isAr ? ' 🇦🇷' : ''} <span class="port-pnl-abs">${esc(r.name)}</span></td>
                <td><span class="bt-label-dot" style="background:${r.score >= 70 ? 'var(--up-text)' : r.score >= 45 ? 'var(--gold-text)' : 'var(--down-text)'};"></span>${r.score}/100</td>
                <td>${r.years}</td>
                <td class="${r.cagr >= 0 ? 'bt-pos' : 'bt-neg'}">${r.cagr >= 0 ? '+' : ''}${r.cagr.toFixed(1)}%/año</td>
                <td class="${r.cuts === 0 ? 'bt-pos' : 'bt-neg'}">${r.cuts === 0 ? 'ninguno' : `${r.cuts}`}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function dividendsPageHTML() {
  const loaded = DIVIDEND_UNIVERSE.filter((t, i) => DIVIDEND_UNIVERSE.indexOf(t) === i).map(t => ({ t, d: divState.data[t] })).filter(e => e.d && e.d.items?.length);
  const loadingCount = new Set(DIVIDEND_UNIVERSE).size - loaded.length;

  // Filas enriquecidas para las tablas.
  const rows = loaded.map(({ t, d }) => ({
    ticker: t, name: universe.find(a => a.ticker === t)?.name ?? t,
    yield: dividendYield(t, d.ttm), ttm: d.ttm, frequency: d.frequency,
    nextEx: d.nextExDate, daysTo: daysUntil(d.nextExDate), lastAmount: d.lastAmount, cagr: d.cagr3y,
  }));

  const upcoming = rows.filter(r => r.daysTo != null && r.daysTo >= -3).sort((a, b) => a.daysTo - b.daysTo).slice(0, 14);
  const byYield = rows.filter(r => r.yield != null).sort((a, b) => b.yield - a.yield).slice(0, 12);

  return `
    ${sectionTitleHTML('Dividendos & Ex-Dividend', 'coins')}
    <div class="dash-intro">Calendario de próximos ex-dividends, mejores pagadores y el historial real de pagos de cada activo (Yahoo Finance — fechas ex-dividend reales). <strong>Ex-dividend</strong>: para cobrar el próximo dividendo tenés que tener la acción <em>antes</em> de esa fecha; si comprás en el ex-date o después, el dividendo lo cobra el vendedor. Las fechas próximas son <strong>estimadas según la cadencia histórica</strong> (mediana de intervalos entre pagos) — no son una fecha confirmada por la empresa.${loadingCount > 0 ? ` Cargando ${loadingCount} activo(s) más…` : ''}</div>

    <div class="cedear-note" style="margin-bottom:22px;">
      <strong>CEDEARs y dividendos:</strong> el tenedor de un CEDEAR también cobra los dividendos del activo subyacente, ajustados por el ratio de conversión, acreditados en dólares/pesos por el agente — habitualmente con una pequeña comisión de custodia y la retención impositiva que corresponda. El yield mostrado es el del activo subyacente en USD.
    </div>

    ${sectionTitleHTML('Próximos Ex-Dividends', 'calendar')}
    ${!upcoming.length ? `<div class="card watch-empty">${loadingCount > 0 ? 'Cargando calendario de dividendos…' : 'No hay ex-dividends próximos estimados en el universo cargado.'}</div>` : `
    <div class="card bt-table-card">
      <div class="bt-table-wrap">
        <table class="bt-table">
          <thead><tr><th>Activo</th><th>Próx. ex-dividend (est.)</th><th>Falta</th><th>Monto</th><th>Frecuencia</th><th>Yield (TTM)</th></tr></thead>
          <tbody>
            ${upcoming.map(r => `
              <tr class="port-row ${r.daysTo >= 0 && r.daysTo <= 7 ? 'div-soon' : ''}" data-div-ticker="${esc(r.ticker)}">
                <td class="bt-label-cell" style="font-weight:700;">${esc(r.ticker)} <span class="port-pnl-abs">${esc(r.name)}</span></td>
                <td>${fmtShortDate(r.nextEx)}</td>
                <td>${r.daysTo < 0 ? '<span class="bt-nd">pasó</span>' : r.daysTo === 0 ? '<span class="div-today">hoy</span>' : `${r.daysTo}d`}</td>
                <td>${r.lastAmount != null ? fmtUsd(r.lastAmount) : 'N/D'}</td>
                <td>${esc(r.frequency ?? 'N/D')}</td>
                <td class="${r.yield != null && r.yield >= 4 ? 'bt-pos' : ''}">${r.yield != null ? r.yield.toFixed(2) + '%' : 'N/D'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="bt-disclaimer">Fechas estimadas proyectando la cadencia histórica real de cada activo — confirmá el ex-date oficial con tu bróker antes de operar por el dividendo.</div>
    </div>`}

    ${dividendIncomeCardHTML()}

    ${sectionTitleHTML('Mejores Pagadores (Yield TTM)', 'trend')}
    ${!byYield.length ? `<div class="card watch-empty">Cargando ranking de dividendos…</div>` : `
    <div class="card bt-table-card">
      <div class="bt-table-wrap">
        <table class="bt-table">
          <thead><tr><th>Activo</th><th>Yield (TTM)</th><th>Pago anual</th><th>Frecuencia</th><th>Crec. 3a (CAGR)</th><th>Próx. ex (est.)</th></tr></thead>
          <tbody>
            ${byYield.map(r => `
              <tr class="port-row" data-div-ticker="${esc(r.ticker)}">
                <td class="bt-label-cell" style="font-weight:700;">${esc(r.ticker)} <span class="port-pnl-abs">${esc(r.name)}</span></td>
                <td style="font-weight:700;" class="${r.yield >= 4 ? 'bt-pos' : ''}">${r.yield.toFixed(2)}%</td>
                <td>${fmtUsd(r.ttm)}</td>
                <td>${esc(r.frequency ?? 'N/D')}</td>
                <td class="${r.cagr != null ? (r.cagr >= 0 ? 'bt-pos' : 'bt-neg') : 'bt-nd'}">${r.cagr != null ? `${r.cagr >= 0 ? '+' : ''}${r.cagr.toFixed(1)}%/año` : '—'}</td>
                <td>${fmtShortDate(r.nextEx)}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`}

    ${dividendConsistencyCardHTML(loaded)}

    ${sectionTitleHTML('Detalle por Activo', 'chart')}
    <div class="card port-form-card">
      <div class="port-form">
        <input list="div-ticker-list" id="div-ticker" class="port-input" placeholder="Ticker (ej. KO)" aria-label="Ticker para ver dividendos" autocomplete="off" style="text-transform:uppercase;" value="${esc(divState.detailTicker)}" />
        <datalist id="div-ticker-list">${universe.filter(a => a.category !== 'Cripto').map(a => `<option value="${esc(a.ticker)}">${esc(a.name)}</option>`).join('')}</datalist>
        <button class="port-add-btn" id="div-detail-run">${divState.detailLoading ? 'Cargando…' : 'Ver dividendos'}</button>
      </div>
    </div>
    ${dividendDetailHTML()}
  `;
}

function dividendDetailHTML() {
  if (divState.detailLoading) return `<div class="card watch-empty">Cargando historial de dividendos…</div>`;
  const dt = divState.detail;
  if (!dt) return '';
  if (dt.error || !dt.div?.items?.length) {
    return `<div class="card watch-empty">${esc(dt.ticker)} no registra pagos de dividendos en los últimos 3 años (o no hay datos disponibles).</div>`;
  }
  const d = dt.div;
  const yld = dt.price && d.ttm > 0 ? (d.ttm / dt.price) * 100 : null;
  const net = dt.ratio ? netCedearPesoDividend(d.lastAmount, dt.ratio, portState.ccl?.value ?? null) : null;
  const cons = dividendConsistency(d.items);
  const stat = (label, value, sub) => `<div class="risk-metric"><div class="risk-metric-label">${label}</div><div class="risk-metric-value">${value}</div>${sub ? `<div class="risk-metric-hint">${sub}</div>` : ''}</div>`;
  // Mini-gráfico de barras del monto por pago (últimos ~12).
  const recent = d.items.slice(0, 12).reverse();
  const maxAmt = Math.max(...recent.map(x => x.amount));
  // DRIP: sobre una posición de referencia de US$10.000 al yield y crecimiento actuales.
  const drip = yld != null ? dripProjection(10000, yld, d.cagr3y, 10) : null;
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">${esc(dt.name)} (${esc(dt.ticker)}) — dividendos</div>
      <div class="risk-metrics-grid" style="margin-bottom:18px;">
        ${stat('Yield (TTM)', yld != null ? `${yld.toFixed(2)}%` : 'N/D', d.ttm > 0 ? `${fmtUsd(d.ttm)}/acción al año` : '')}
        ${stat('Frecuencia', esc(d.frequency ?? 'N/D'), d.medianIntervalDays ? `cada ~${d.medianIntervalDays} días` : '')}
        ${stat('Próx. ex-dividend', fmtShortDate(d.nextExDate), 'estimado por cadencia')}
        ${stat('Consistencia', cons?.score != null ? `${cons.score}/100` : 'N/D', cons?.years ? `${cons.years} años, ${cons.cuts === 0 ? 'sin recortes' : cons.cuts + ' recorte(s)'}` : '')}
      </div>
      ${net != null ? `<div class="port-note" style="padding-bottom:12px;">Por CEDEAR (ratio 1:${dt.ratio}) el último pago fue ~${fmtUsd(net.perCedearUsd)}${portState.ccl?.value ? ` ≈ ${fmtArs(net.grossArs)} bruto · <strong>${fmtArs(net.netArs)} neto</strong> (estimado, tras ~${(CEDEAR_DIVIDEND_FEE * 100).toFixed(1)}% de comisión de custodia, antes de retención impositiva)` : ' (esperando CCL para el neto en pesos)'}.</div>` : ''}
      <div class="div-bars">
        ${recent.map(x => `<div class="div-bar-col" title="${esc(x.date)}: ${fmtUsd(x.amount)}"><div class="div-bar" style="height:${Math.max(4, Math.round((x.amount / maxAmt) * 90))}px;"></div><div class="div-bar-label">${x.date.slice(2, 7)}</div></div>`).join('')}
      </div>
      ${drip ? `<div class="port-note" style="padding:12px 0 4px;"><strong>DRIP (reinversión):</strong> US$10.000 en ${esc(dt.ticker)}, reinvirtiendo los dividendos 10 años al yield actual (${yld.toFixed(2)}%)${d.cagr3y != null ? ` y crecimiento ${d.cagr3y >= 0 ? '+' : ''}${d.cagr3y.toFixed(1)}%/año` : ''}, generaría <strong class="up">${fmtUsd(drip.reinvestedGain)}</strong> en dividendos compuestos vs ${fmtUsd(drip.cashGain)} cobrándolos — <strong>${fmtUsd(drip.extra)}</strong> extra por reinvertir. Supone precio estable y es antes de impuestos; aísla el efecto del interés compuesto del dividendo.</div>` : ''}
      ${dt.capture ? `
      <div class="port-note" style="padding:10px 0 4px;"><strong>Backtest de captura de dividendo</strong> (${dt.capture.events} ex-dividends históricos): comprar al cierre previo al ex-date y medir el resultado neto (precio + dividendo) después.</div>
      <div class="bt-table-wrap" style="margin-bottom:10px;">
        <table class="bt-table">
          <thead><tr><th>Horizonte</th><th>Resultado neto prom.</th><th>Positivos</th></tr></thead>
          <tbody>
            ${dt.capture.rows.map(r => `<tr><td>${r.h} rueda${r.h === 1 ? '' : 's'} post ex</td><td class="${r.avgPct >= 0 ? 'bt-pos' : 'bt-neg'}">${r.avgPct >= 0 ? '+' : ''}${r.avgPct.toFixed(2)}%</td><td>${r.winRate}%</td></tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="bt-disclaimer">${dt.capture.avgRecovery != null ? `El precio recuperó la caída del ex-date en ~${dt.capture.avgRecovery} ruedas en promedio (${Math.round(dt.capture.recoveredFrac * 100)}% de las veces dentro de 40 ruedas). ` : ''}La captura de dividendo rara vez es "gratis": el precio suele caer cerca del monto del dividendo en el ex-date. Resultado histórico, no garantía.</div>` : ''}
      <div class="div-history-list">
        ${d.items.slice(0, 10).map(x => `<div class="port-ops-row"><span class="port-reco-ticker">${fmtShortDate(x.date)}</span><span class="port-ops-detail">ex-dividend</span><span class="port-ops-realized">${fmtUsd(x.amount)}</span></div>`).join('')}
      </div>
      <div class="bt-disclaimer">Historial real de fechas ex-dividend (Yahoo Finance). El próximo ex-dividend es una estimación por la cadencia histórica, no una fecha confirmada.</div>
    </div>`;
}

function wireDividendsEvents() {
  els.report.querySelectorAll('[data-div-ticker]').forEach(el => {
    el.addEventListener('click', () => loadDividendDetail(el.dataset.divTicker));
  });
  const runBtn = document.getElementById('div-detail-run');
  const input = document.getElementById('div-ticker');
  if (runBtn && input) {
    const run = () => {
      const t = input.value.trim().toUpperCase();
      if (t && universe.some(a => a.ticker === t)) loadDividendDetail(t);
      else showToast('Ticker desconocido — elegí uno de la lista.', 'info');
    };
    runBtn.addEventListener('click', run);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }
}

/* ───────────────────────── radar de trades cortos (página) ───────────────────────── */
const SHORT_CONF_COLOR = { 'muy alta': GREEN, alta: 'oklch(0.72 0.16 152)', media: AMBER, baja: 'oklch(0.62 0.02 262)' };

function shortTradesPageHTML() {
  // Combina universo curado + watchlist (sin duplicar), tomando el setup ya
  // calculado por computeLightSignal — sin pedidos extra.
  const seen = new Set();
  const rows = [];
  const pushFrom = (map) => {
    for (const [ticker, d] of Object.entries(map)) {
      if (!d || seen.has(ticker) || !d.setup?.qualifies) continue;
      seen.add(ticker);
      rows.push({ ticker, d });
    }
  };
  pushFrom(dashState.data);
  pushFrom(watchState.data);
  rows.sort((a, b) => b.d.setup.score - a.d.setup.score);

  const loadingCurated = dashState.started && DASHBOARD_UNIVERSE.some(t => !dashState.data[t]);

  return `
    ${sectionTitleHTML('Radar de Trades Cortos', 'zap')}
    <div class="dash-intro">Activos del universo curado y tu Watchlist con un <strong>setup técnico alcista de corto plazo (1-3 días)</strong> de alta confianza AHORA: squeeze de volatilidad recién liberado, ruptura de máximos con volumen, cruce de MACD, divergencia alcista, salida de sobreventa en tendencia, etc. Cada uno con entrada, stop ajustado y objetivos. ${loadingCurated ? 'Cargando el universo…' : ''}</div>
    <div class="cedear-note" style="margin-bottom:22px; border-color:oklch(0.55 0.15 23 / 0.4);">
      <strong>⚠ Riesgo alto:</strong> el trading de corto plazo es especulativo y de alto riesgo. Esto es un <strong>tamiz técnico</strong>, no una recomendación ni una garantía de suba — muchos setups fallan. Operá siempre con un stop, arriesgá solo lo que puedas perder, y recordá que un balance (earnings) cercano puede disparar movimientos que ningún indicador anticipa.
    </div>
    ${!rows.length ? `<div class="card watch-empty">${loadingCurated ? 'Analizando setups de corto plazo…' : 'No hay setups de corto plazo de alta confianza en este momento. El mercado no siempre ofrece entradas claras — volvé más tarde.'}</div>` : `
    <div class="short-grid">
      ${rows.map(({ ticker, d }) => shortTradeCardHTML(ticker, d)).join('')}
    </div>`}
  `;
}

function shortTradeCardHTML(ticker, d) {
  const s = d.setup;
  const conf = SHORT_CONF_COLOR[s.confidence] ?? AMBER;
  const primary = s.triggers.filter(t => t.primary);
  const secondary = s.triggers.filter(t => !t.primary);
  return `
    <div class="card short-card" data-short-ticker="${esc(ticker)}">
      <div class="short-head">
        <div>
          <div class="short-ticker">${esc(ticker)} <span class="watch-stale">${esc(d.category ?? '')}</span></div>
          <div class="short-name">${esc(d.name ?? '')}</div>
        </div>
        <div class="short-conf" style="color:${conf};">
          <div class="short-conf-score">${s.score}</div>
          <div class="short-conf-label">confianza ${esc(s.confidence)}</div>
        </div>
      </div>
      <div class="short-price"><span class="short-price-usd">${fmtUsd(d.price)}</span> <span class="${d.changePct >= 0 ? 'up' : 'down'}">${fmtPct(d.changePct)} hoy</span>${d.cedearArs != null ? ` · <span class="port-pnl-abs">CEDEAR ${fmtArs(d.cedearArs)}</span>` : ''}</div>
      <div class="short-triggers">
        ${primary.map(t => `<span class="short-chip primary">⚡ ${esc(t.label)}</span>`).join('')}
        ${secondary.map(t => `<span class="short-chip">${esc(t.label)}</span>`).join('')}
      </div>
      <div class="short-plan">
        <div class="short-plan-cell"><span>Entrada</span><b>${fmtUsd(s.entry)}</b></div>
        <div class="short-plan-cell"><span>Stop</span><b class="down">${fmtUsd(s.stop)}</b></div>
        <div class="short-plan-cell"><span>Objetivo 1</span><b class="up">${fmtUsd(s.target1)}</b></div>
        <div class="short-plan-cell"><span>Objetivo 2</span><b class="up">${fmtUsd(s.target2)}</b></div>
        <div class="short-plan-cell"><span>Riesgo/Beneficio</span><b>${s.rr != null ? s.rr.toFixed(1) + ':1' : 'N/D'}</b></div>
        <div class="short-plan-cell"><span>Rango diario típ.</span><b>±${s.expectedMovePct.toFixed(1)}%</b></div>
      </div>
      ${s.risks.length ? `<div class="short-risks">${s.risks.map(r => `<div>⚠ ${esc(r)}</div>`).join('')}</div>` : ''}
    </div>`;
}

function wireShortTradesEvents() {
  els.report.querySelectorAll('[data-short-ticker]').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.shortTicker));
  });
}

/* ───────────────────────── radar de gaps de apertura ─────────────────────
 * Ranking del universo curado + Watchlist por el hueco (gap) de apertura de
 * la última rueda, calculado por computeGap dentro de computeLightSignal (sin
 * requests extra). Un gap grande señala que el mercado repreció el activo de
 * un salto por un catalizador; separamos gaps alcistas y bajistas, mostramos
 * el tamaño en % y en ATR, si sostiene la apertura o ya se rellenó, y —
 * cuando hay— el setup de trade corto asociado. */
function gapsPageHTML() {
  const seen = new Set();
  const rows = [];
  const pushFrom = (map) => {
    for (const [ticker, d] of Object.entries(map)) {
      if (!d || seen.has(ticker) || !d.gap) continue;
      seen.add(ticker);
      rows.push({ ticker, d });
    }
  };
  pushFrom(dashState.data);
  pushFrom(watchState.data);
  const ups = rows.filter(r => r.d.gap.direction === 'up').sort((a, b) => b.d.gap.pct - a.d.gap.pct);
  const downs = rows.filter(r => r.d.gap.direction === 'down').sort((a, b) => a.d.gap.pct - b.d.gap.pct);

  const loadingCurated = dashState.started && DASHBOARD_UNIVERSE.some(t => !dashState.data[t]);
  const total = ups.length + downs.length;

  return `
    ${sectionTitleHTML('Radar de Gaps de Apertura', 'gap')}
    <div class="dash-intro">Activos del universo curado y tu Watchlist que abrieron con un <strong>hueco (gap)</strong> respecto al cierre anterior — la señal de que el mercado repreció el activo de un salto (balance, noticia, guidance). Se mide el tamaño del gap en % y en múltiplos de ATR (para saber si es grande <em>para ese activo</em>), si <strong>sostiene</strong> la apertura o ya se <strong>rellenó</strong> intradía. ${loadingCurated ? 'Cargando el universo…' : ''}</div>
    <div class="cedear-note" style="margin-bottom:22px;">
      <strong>ℹ Cómo leerlo:</strong> un gap alcista que <strong>sostiene</strong> la apertura suele indicar fuerza real; uno que se <strong>rellena</strong> rápido (el precio vuelve al cierre previo) suele ser menos sostenible. El tamaño en <strong>ATR</strong> importa más que el %: un gap de +2% es enorme en un activo tranquilo y normal en uno volátil. No es una recomendación — es un tamiz de dónde está pasando algo hoy.
    </div>
    ${!total ? `<div class="card watch-empty">${loadingCurated ? 'Analizando huecos de apertura…' : 'No hay gaps de apertura relevantes en el universo en este momento — el mercado abrió sin huecos significativos.'}</div>` : `
      <div class="gap-cols">
        <div class="gap-col">
          <div class="gap-col-title up">▲ Gaps alcistas <span>${ups.length}</span></div>
          ${ups.length ? `<div class="short-grid gap-grid">${ups.map(({ ticker, d }) => gapCardHTML(ticker, d)).join('')}</div>` : `<div class="card watch-empty gap-empty">Ningún activo abrió con gap alcista relevante.</div>`}
        </div>
        <div class="gap-col">
          <div class="gap-col-title down">▼ Gaps bajistas <span>${downs.length}</span></div>
          ${downs.length ? `<div class="short-grid gap-grid">${downs.map(({ ticker, d }) => gapCardHTML(ticker, d)).join('')}</div>` : `<div class="card watch-empty gap-empty">Ningún activo abrió con gap bajista relevante.</div>`}
        </div>
      </div>`}
  `;
}

function gapCardHTML(ticker, d) {
  const g = d.gap;
  const up = g.direction === 'up';
  const col = up ? GREEN : RED;
  const statusChip = g.filled
    ? `<span class="gap-status filled">Rellenó ${Math.round(g.fillFrac * 100)}%</span>`
    : g.holding
      ? `<span class="gap-status holding">Sostiene la apertura</span>`
      : `<span class="gap-status partial">Rellenó ${Math.round(g.fillFrac * 100)}%</span>`;
  return `
    <div class="card short-card gap-card" data-gap-ticker="${esc(ticker)}">
      <div class="short-head">
        <div>
          <div class="short-ticker">${esc(ticker)} <span class="watch-stale">${esc(d.category ?? '')}</span></div>
          <div class="short-name">${esc(d.name ?? '')}</div>
        </div>
        <div class="short-conf" style="color:${col};">
          <div class="short-conf-score">${g.pct >= 0 ? '+' : ''}${g.pct.toFixed(1)}%</div>
          <div class="short-conf-label">gap de apertura</div>
        </div>
      </div>
      <div class="short-price"><span class="short-price-usd">${fmtUsd(d.price)}</span> <span class="${d.changePct >= 0 ? 'up' : 'down'}">${fmtPct(d.changePct)} hoy</span>${d.cedearArs != null ? ` · <span class="port-pnl-abs">CEDEAR ${fmtArs(d.cedearArs)}</span>` : ''}</div>
      <div class="gap-metrics">
        <div class="gap-metric"><span>Cierre previo</span><b>${fmtUsd(g.prevClose)}</b></div>
        <div class="gap-metric"><span>Apertura</span><b style="color:${col};">${fmtUsd(g.open)}</b></div>
        <div class="gap-metric"><span>Tamaño en ATR</span><b>${g.atr != null ? (g.atr >= 0 ? '+' : '') + g.atr.toFixed(1) + '×' : 'N/D'}</b></div>
        <div class="gap-metric"><span>Estado</span>${statusChip}</div>
      </div>
      ${g.significant ? `<div class="gap-tag ${up ? 'up' : 'down'}">⚡ Gap grande para este activo (${g.atr != null ? Math.abs(g.atr).toFixed(1) + '× ATR' : Math.abs(g.pct).toFixed(1) + '%'})</div>` : ''}
      ${d.setup?.qualifies ? `<div class="gap-setup-note">También aparece en Trades Cortos con setup alcista (confianza ${esc(d.setup.confidence)}).</div>` : ''}
    </div>`;
}

function wireGapsEvents() {
  els.report.querySelectorAll('[data-gap-ticker]').forEach(el => {
    el.addEventListener('click', () => selectTicker(el.dataset.gapTicker));
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
          <input list="cmp-ticker-list" data-cmp-slot="${i}" class="port-input cmp-input" placeholder="Ticker ${i + 1}${i < 2 ? '' : ' (opcional)'}" aria-label="Ticker ${i + 1} a comparar${i < 2 ? '' : ' (opcional)'}" autocomplete="off" style="text-transform:uppercase;" value="${esc(v)}" />`).join('')}
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

/** Factor de inflación acumulada (IPC Argentina, ArgentinaDatos) entre dos
 *  fechas, componiendo las variaciones mensuales reales de ese rango — sin
 *  prorratear dentro del mes de compra/hoy (granularidad mensual real, no
 *  inventada). Devuelve null si no hay al menos un mes de datos en el rango. */
function computeInflationFactor(items, fromDateStr, toDateStr) {
  if (!items?.length || !fromDateStr || !toDateStr) return null;
  const from = new Date(fromDateStr + 'T00:00:00Z');
  const to = new Date(toDateStr + 'T00:00:00Z');
  if (isNaN(from) || isNaN(to) || to <= from) return null;
  const fromKey = from.toISOString().slice(0, 7);
  const toKey = to.toISOString().slice(0, 7);
  let factor = 1, monthsUsed = 0;
  for (const it of items) {
    const key = it.fecha.slice(0, 7);
    if (key > fromKey && key <= toKey) { factor *= (1 + it.valorPct / 100); monthsUsed++; }
  }
  return monthsUsed ? { factor, monthsUsed } : null;
}

/** Extrae el punto medio de un rango de tasa tipo "4.25%–4.50%" (macro.json,
 *  snapshot manual real, ya mostrado en la sección Macro) — se usa como
 *  referencia de tasa libre de riesgo para el Sharpe. */
function parseFedRateMid(label) {
  if (!label) return null;
  const nums = String(label).match(/[\d.]+/g);
  if (!nums || !nums.length) return null;
  const vals = nums.map(Number);
  return (vals.reduce((a, b) => a + b, 0) / vals.length) / 100;
}

const TRADING_DAYS_YEAR = 252;

/** Volatilidad, máximo drawdown y Sharpe ratio de la cartera — calculados
 *  sobre la serie de cierres reales de cada holding (ya obtenida por
 *  computeLightSignal, sin pedidos extra), combinados con el PESO ACTUAL de
 *  cada posición (no el peso histórico real día a día, que no tenemos —
 *  se aclara en la UI). Si una posición no tiene suficiente historial, se
 *  excluye y se recalculan los pesos solo entre las que sí lo tienen —
 *  nunca se inventa una serie de precios para completar. */
function computePortfolioRiskMetrics(rows, macro, spyCloses = null) {
  const MIN_DAYS = 60;
  const withCloses = rows.filter(r => r.d?.closes?.length >= MIN_DAYS && r.weight != null && r.weight > 0);
  const totalWithWeight = rows.filter(r => r.weight != null && r.weight > 0).length;
  if (!withCloses.length) return null;

  const minLen = Math.min(...withCloses.map(r => r.d.closes.length));
  const totalW = withCloses.reduce((s, r) => s + r.weight, 0);
  const series = withCloses.map(r => ({ ticker: r.ticker, weight: r.weight / totalW, closes: r.d.closes.slice(-minLen), category: r.d.category ?? null }));

  const returnsOf = (closes) => {
    const out = [];
    for (let i = 1; i < closes.length; i++) out.push((closes[i] - closes[i - 1]) / closes[i - 1]);
    return out;
  };
  const assetReturns = series.map(s => returnsOf(s.closes));
  const portfolioReturns = [];
  for (let i = 0; i < minLen - 1; i++) {
    let ret = 0;
    for (let k = 0; k < series.length; k++) ret += series[k].weight * assetReturns[k][i];
    portfolioReturns.push(ret);
  }
  const mean = portfolioReturns.reduce((a, b) => a + b, 0) / portfolioReturns.length;
  const variance = portfolioReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, portfolioReturns.length - 1);
  const dailyStd = Math.sqrt(variance);
  const annualizedReturn = Math.pow(1 + mean, TRADING_DAYS_YEAR) - 1;
  const annualizedVol = dailyStd * Math.sqrt(TRADING_DAYS_YEAR);
  const riskFree = parseFedRateMid(macro?.fedRateLabel) ?? 0;
  const sharpe = annualizedVol > 0 ? (annualizedReturn - riskFree) / annualizedVol : null;

  let equity = 1, peak = 1, maxDD = 0;
  for (const r of portfolioReturns) {
    equity *= (1 + r);
    if (equity > peak) peak = equity;
    maxDD = Math.max(maxDD, (peak - equity) / peak);
  }

  // Aporte al riesgo por posición: peso × covarianza(activo, cartera) /
  // varianza(cartera) — la descomposición estándar de la varianza total.
  // Una posición chica pero muy volátil y correlacionada puede aportar más
  // riesgo que una grande y estable; esto lo hace visible.
  const cov = (xs, ys) => {
    const n = Math.min(xs.length, ys.length);
    if (n < 2) return null;
    const mx = xs.slice(0, n).reduce((a, b) => a + b, 0) / n, my = ys.slice(0, n).reduce((a, b) => a + b, 0) / n;
    let c = 0;
    for (let i = 0; i < n; i++) c += (xs[i] - mx) * (ys[i] - my);
    return c / (n - 1);
  };
  const riskContributions = variance > 0 ? series.map((s, k) => {
    const c = cov(assetReturns[k], portfolioReturns);
    return { ticker: s.ticker, weight: s.weight, riskShare: c != null ? (s.weight * c) / variance : null };
  }).filter(x => x.riskShare != null).sort((a, b) => b.riskShare - a.riskShare) : [];

  // Peor semana (5 ruedas) y peor mes (21 ruedas) de ESTA cartera con los
  // pesos actuales, sobre el historial real — retorno compuesto rodante.
  const worstWindow = (win) => {
    if (portfolioReturns.length < win) return null;
    let worst = Infinity;
    for (let i = 0; i + win <= portfolioReturns.length; i++) {
      let acc = 1;
      for (let j = i; j < i + win; j++) acc *= (1 + portfolioReturns[j]);
      worst = Math.min(worst, acc - 1);
    }
    return worst === Infinity ? null : worst;
  };
  const worstWeek = worstWindow(5);
  const worstMonth = worstWindow(21);

  // Beta y comparación vs SPY, sobre la ventana común de datos.
  let beta = null, portfolioTotalReturn = null, spyTotalReturn = null;
  const assetBetas = []; // beta por posición vs SPY — para el estrés de mercado
  if (spyCloses?.length >= MIN_DAYS) {
    const spyReturns = returnsOf(spyCloses);
    const n = Math.min(portfolioReturns.length, spyReturns.length);
    const p = portfolioReturns.slice(-n), s = spyReturns.slice(-n);
    const cps = cov(p, s), vs = cov(s, s);
    beta = cps != null && vs > 0 ? cps / vs : null;
    portfolioTotalReturn = p.reduce((acc, r) => acc * (1 + r), 1) - 1;
    spyTotalReturn = s.reduce((acc, r) => acc * (1 + r), 1) - 1;
    // Beta de cada posición: cuánto se mueve ESE activo cuando el mercado
    // (SPY) se mueve 1 — la sensibilidad real de cada tenencia al índice.
    if (vs > 0) {
      for (let k = 0; k < series.length; k++) {
        const ar = assetReturns[k].slice(-n);
        const cas = cov(ar, s.slice(-ar.length));
        assetBetas.push({ ticker: series[k].ticker, weight: series[k].weight, category: series[k].category, beta: cas != null ? cas / vs : null });
      }
    }
  }

  // Solapamiento: pares de tenencias cuyos retornos van >0.8 correlacionados
  // — se mueven casi igual, la diversificación entre ellos es ilusoria.
  const pearson = (xs, ys) => {
    const c = cov(xs, ys), vx = cov(xs, xs), vy = cov(ys, ys);
    return c != null && vx > 0 && vy > 0 ? c / Math.sqrt(vx * vy) : null;
  };
  const overlaps = [];
  const corrM = series.map(() => series.map(() => null));
  for (let a = 0; a < series.length; a++) {
    corrM[a][a] = 1;
    for (let b = a + 1; b < series.length; b++) {
      const corr = pearson(assetReturns[a], assetReturns[b]);
      corrM[a][b] = corrM[b][a] = corr;
      if (corr != null && corr > 0.8) overlaps.push({ a: series[a].ticker, b: series[b].ticker, corr });
    }
  }
  overlaps.sort((x, y) => y.corr - x.corr);
  const corrMatrix = series.length >= 2 ? { tickers: series.map(s => s.ticker), m: corrM } : null;

  return {
    coveredHoldings: withCloses.length, totalHoldings: totalWithWeight, days: minLen,
    annualizedReturn, annualizedVol, sharpe, maxDrawdown: maxDD, riskFreeUsed: riskFree,
    riskContributions, worstWeek, worstMonth, beta, portfolioTotalReturn, spyTotalReturn, overlaps,
    dailyMean: mean, dailyStd, portfolioReturns, assetBetas, corrMatrix,
    series: series.map(s => ({ ticker: s.ticker, weight: s.weight, category: s.category })),
  };
}

/** Score de salud de la cartera (0-100): fórmula determinística y visible
 *  sobre métricas ya calculadas — no es una opinión de IA. Cada componente
 *  aporta puntos según umbrales documentados en su etiqueta. */
function computePortfolioHealth(stats, risk) {
  if (!stats?.rows?.length) return null;
  const items = [];
  const linear = (value, best, worst, maxPts) => {
    if (value == null) return null;
    if (value <= best) return maxPts;
    if (value >= worst) return 0;
    return Math.round(maxPts * (worst - value) / (worst - best));
  };

  const topW = stats.topHolding?.weight ?? null;
  const pConc = linear(topW, 0.15, 0.5, 25);
  items.push({ label: 'Concentración por activo', detail: topW != null ? `mayor posición ${Math.round(topW * 100)}% (ideal ≤15%, crítico ≥50%)` : 'sin datos', pts: pConc, max: 25 });

  const topSector = stats.sectorRows?.[0]?.pct ?? null;
  const pSector = linear(topSector, 0.3, 0.7, 20);
  items.push({ label: 'Concentración sectorial', detail: topSector != null ? `mayor sector ${Math.round(topSector * 100)}% (ideal ≤30%, crítico ≥70%)` : 'sin datos', pts: pSector, max: 20 });

  const sellWeight = stats.rows.filter(r => stats.sellSignals.includes(r)).reduce((s, r) => s + (r.weight ?? 0), 0);
  const pSell = linear(sellWeight, 0, 0.5, 20);
  items.push({ label: 'Posiciones en Venta/Reducir', detail: `${stats.sellSignals.length} posición(es), ${Math.round(sellWeight * 100)}% del peso`, pts: pSell, max: 20 });

  const pVol = risk ? linear(risk.annualizedVol, 0.15, 0.5, 20) : null;
  items.push({ label: 'Volatilidad', detail: risk ? `${(risk.annualizedVol * 100).toFixed(1)}% anualizada (ideal ≤15%, crítico ≥50%)` : 'sin historial suficiente', pts: pVol, max: 20 });

  const pOverlap = risk ? Math.max(0, 15 - (risk.overlaps?.length ?? 0) * 5) : null;
  items.push({ label: 'Solapamiento entre tenencias', detail: risk ? `${risk.overlaps?.length ?? 0} par(es) con correlación >0.8 (−5 pts c/u)` : 'sin historial suficiente', pts: pOverlap, max: 15 });

  const applicable = items.filter(i => i.pts != null);
  if (!applicable.length) return null;
  const got = applicable.reduce((s, i) => s + i.pts, 0);
  const max = applicable.reduce((s, i) => s + i.max, 0);
  return { score: Math.round((got / max) * 100), items };
}

function riskMetricsCardHTML(risk, holdingsCount) {
  if (!holdingsCount) return '';
  if (!risk) {
    return `
      <div class="card port-notes-card">
        <div class="dash-radar-title">Riesgo de la cartera</div>
        <div class="dash-loading-note">Hace falta al menos ~60 ruedas de historial en alguna posición para calcular volatilidad, drawdown y Sharpe — probá de nuevo en un momento.</div>
      </div>`;
  }
  const coverageNote = risk.coveredHoldings < risk.totalHoldings
    ? `Calculado sobre ${risk.coveredHoldings}/${risk.totalHoldings} posiciones con historial suficiente (peso re-normalizado entre esas), con el peso ACTUAL de cada una — no reconstruye cómo varió tu cartera día a día en el pasado.`
    : `Calculado sobre las ${risk.coveredHoldings} posiciones de tu cartera, con el peso ACTUAL de cada una — no reconstruye cómo varió tu cartera día a día en el pasado.`;
  const sharpeTone = risk.sharpe == null ? '' : risk.sharpe >= 1 ? 'up' : risk.sharpe < 0 ? 'down' : '';
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Riesgo de la cartera <span class="risk-days-note">— últimas ${risk.days} ruedas</span></div>
      <div class="risk-metrics-grid">
        <div class="risk-metric">
          <div class="risk-metric-label">Volatilidad anualizada</div>
          <div class="risk-metric-value">${(risk.annualizedVol * 100).toFixed(1)}%</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Máximo drawdown</div>
          <div class="risk-metric-value down">-${(risk.maxDrawdown * 100).toFixed(1)}%</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Retorno anualizado</div>
          <div class="risk-metric-value ${risk.annualizedReturn >= 0 ? 'up' : 'down'}">${risk.annualizedReturn >= 0 ? '+' : ''}${(risk.annualizedReturn * 100).toFixed(1)}%</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Sharpe ratio (aprox.)</div>
          <div class="risk-metric-value ${sharpeTone}">${risk.sharpe == null ? 'N/D' : risk.sharpe.toFixed(2)}</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Beta vs SPY</div>
          <div class="risk-metric-value">${risk.beta == null ? 'N/D' : risk.beta.toFixed(2)}</div>
          ${risk.beta != null ? `<div class="risk-metric-hint">si SPY cae 10%, tu cartera tiende a ${risk.beta >= 0 ? 'caer' : 'subir'} ~${Math.abs(risk.beta * 10).toFixed(1)}%</div>` : ''}
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Peor semana histórica</div>
          <div class="risk-metric-value ${risk.worstWeek != null && risk.worstWeek < 0 ? 'down' : ''}">${risk.worstWeek == null ? 'N/D' : fmtPct(risk.worstWeek * 100)}</div>
          <div class="risk-metric-hint">5 ruedas, pesos actuales</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Peor mes histórico</div>
          <div class="risk-metric-value ${risk.worstMonth != null && risk.worstMonth < 0 ? 'down' : ''}">${risk.worstMonth == null ? 'N/D' : fmtPct(risk.worstMonth * 100)}</div>
          <div class="risk-metric-hint">21 ruedas, pesos actuales</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Tu cartera vs SPY</div>
          <div class="risk-metric-value ${risk.portfolioTotalReturn != null && risk.spyTotalReturn != null ? (risk.portfolioTotalReturn >= risk.spyTotalReturn ? 'up' : 'down') : ''}">${risk.portfolioTotalReturn == null || risk.spyTotalReturn == null ? 'N/D' : `${fmtPct(risk.portfolioTotalReturn * 100)} vs ${fmtPct(risk.spyTotalReturn * 100)}`}</div>
          ${risk.portfolioTotalReturn != null && risk.spyTotalReturn != null ? `<div class="risk-metric-hint">${risk.portfolioTotalReturn >= risk.spyTotalReturn ? 'le venís ganando al índice' : 'todo en SPY habría rendido más'} en la ventana analizada</div>` : ''}
        </div>
      </div>
      <div class="port-note" style="margin-top:14px;">${esc(coverageNote)} El Sharpe usa ${(risk.riskFreeUsed * 100).toFixed(2)}% como tasa libre de riesgo de referencia (punto medio de la tasa de la FED, snapshot macro). La comparación vs SPY usa los pesos ACTUALES sobre la misma ventana — no reconstruye compras pasadas.</div>
    </div>`;
}

/** Salud de la cartera 0-100 — fórmula determinística sobre métricas ya
 *  calculadas (concentración, sector, señales de venta, volatilidad,
 *  solapamiento), con el desglose de puntos visible. */
function portfolioHealthCardHTML(health) {
  if (!health) return '';
  const tone = health.score >= 70 ? 'up' : health.score >= 45 ? '' : 'down';
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Salud de la cartera</div>
      <div class="port-health-head">
        <div class="port-health-score ${tone}">${health.score}<span class="port-health-max">/100</span></div>
        <div class="port-health-rows">
          ${health.items.map(i => `
            <div class="score-row" style="grid-template-columns: 210px 1fr 60px;">
              <span class="score-label" title="${esc(i.detail)}">${esc(i.label)}</span>
              <div class="score-bar-bg"><div class="score-bar-fill" style="width:${i.pts == null ? 0 : Math.round((i.pts / i.max) * 100)}%;"></div></div>
              <span class="score-fraction">${i.pts == null ? 'N/D' : `${i.pts}/${i.max}`}</span>
            </div>`).join('')}
        </div>
      </div>
      <div class="port-note" style="margin-top:10px;">Fórmula fija y visible (pasá el mouse por cada componente para ver el umbral) — no es una opinión: mide concentración, señales activas, volatilidad y solapamiento con los datos de arriba.</div>
    </div>`;
}

/** Aporte al riesgo por posición: peso vs. porción de la varianza total que
 *  esa posición explica — hace visible cuando una posición "chica" concentra
 *  el riesgo real de la cartera. */
function riskContributionCardHTML(risk) {
  if (!risk?.riskContributions?.length || risk.riskContributions.length < 2) return '';
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Aporte al riesgo por posición</div>
      <div class="port-note" style="padding:0 0 10px;">Peso en cartera vs. porción del riesgo total (varianza) que aporta cada posición — pueden diferir mucho: una posición volátil y correlacionada aporta más riesgo del que pesa.</div>
      ${risk.riskContributions.map(rc => `
        <div class="risk-contrib-row">
          <span class="port-reco-ticker">${esc(rc.ticker)}</span>
          <div class="risk-contrib-bars">
            <div class="score-row" style="grid-template-columns: 52px 1fr 46px; margin:0;">
              <span class="risk-contrib-label">peso</span>
              <div class="score-bar-bg"><div class="score-bar-fill" style="width:${Math.round(rc.weight * 100)}%;"></div></div>
              <span class="score-fraction">${Math.round(rc.weight * 100)}%</span>
            </div>
            <div class="score-row" style="grid-template-columns: 52px 1fr 46px; margin:0;">
              <span class="risk-contrib-label">riesgo</span>
              <div class="score-bar-bg"><div class="score-bar-fill risk-contrib-fill ${rc.riskShare > rc.weight * 1.3 ? 'hot' : ''}" style="width:${Math.max(0, Math.min(100, Math.round(rc.riskShare * 100)))}%;"></div></div>
              <span class="score-fraction">${Math.round(rc.riskShare * 100)}%</span>
            </div>
          </div>
        </div>`).join('')}
    </div>`;
}

/** Bienes Personales — escalas oficiales AFIP/ARCA, período fiscal 2025
 *  (vencimiento 2026), verificadas contra la fuente oficial:
 *  https://www.afip.gob.ar/gananciasYBienes/bienes-personales/conceptos-basicos/alicuotas.asp
 *  Es una ESTIMACIÓN educativa sobre el valor de la cartera cargada, no
 *  asesoramiento impositivo — no contempla el resto del patrimonio del
 *  usuario (inmuebles, otras cuentas, etc.) ni la distinción entre bienes
 *  del país y del exterior (los CEDEARs, al representar acciones extranjeras,
 *  podrían tener un tratamiento distinto — se aclara en la UI). */
const BP_MNI = 384728044.57;
const BP_BRACKETS_GENERAL = [
  { lower: 0, upper: 52664283.73, base: 0, rate: 0.005 },
  { lower: 52664283.73, upper: 114105948.16, base: 263321.42, rate: 0.0075 },
  { lower: 114105948.16, upper: Infinity, base: 724133.89, rate: 0.01 },
];
const BP_BRACKETS_CUMPLIDOR = [
  { lower: 0, upper: 52664283.73, base: 0, rate: 0 },
  { lower: 52664283.73, upper: 114105948.16, base: 0, rate: 0.0025 },
  { lower: 114105948.16, upper: Infinity, base: 153604.17, rate: 0.005 },
];
function computeBienesPersonales(totalArs, cumplidor) {
  const excess = totalArs - BP_MNI;
  if (excess <= 0) return { taxable: false, tax: 0, excess: 0 };
  const brackets = cumplidor ? BP_BRACKETS_CUMPLIDOR : BP_BRACKETS_GENERAL;
  const b = brackets.find(x => excess <= x.upper);
  const tax = b.base + b.rate * (excess - b.lower);
  return { taxable: true, tax, excess, effectiveRate: totalArs > 0 ? tax / totalArs : 0 };
}

function taxImpactCardHTML(totalUsdValue, ccl) {
  if (!totalUsdValue) return '';
  const cclValue = ccl?.value ?? null;
  const totalArs = cclValue ? totalUsdValue * cclValue : null;
  const bp = totalArs != null ? computeBienesPersonales(totalArs, taxState.cumplidor) : null;

  return `
    <div class="card port-notes-card">
      <div class="panel-header" style="margin-bottom:12px;">
        <div class="dash-radar-title" style="margin-bottom:0;">Impacto fiscal estimado (Argentina)</div>
        <label class="tax-cumplidor-toggle">
          <input type="checkbox" id="tax-cumplidor" ${taxState.cumplidor ? 'checked' : ''} />
          Soy contribuyente cumplidor
        </label>
      </div>
      ${!totalArs ? `<div class="dash-loading-note">Esperando cotización del CCL para convertir tu cartera a pesos…</div>` : `
      <div class="tax-bp-row">
        <div>
          <div class="risk-metric-label">Bienes Personales — estimado</div>
          <div class="risk-metric-value ${bp.taxable ? 'down' : 'up'}">${bp.taxable ? fmtArs(bp.tax) : 'No alcanza el mínimo'}</div>
          <div class="port-note" style="padding:4px 0 0;">Cartera valuada en ${fmtArs(totalArs)} (a CCL ${fmtArs(cclValue)}) contra un mínimo no imponible de ${fmtArs(BP_MNI)}${bp.taxable ? ` — tasa efectiva estimada ${(bp.effectiveRate * 100).toFixed(2)}%` : ''}.</div>
        </div>
      </div>
      <div class="tax-ganancias-note">
        <strong>Ganancias:</strong> la compraventa de CEDEARs está exenta de Impuesto a las Ganancias para personas humanas; los <strong>dividendos</strong> que paguen sí tributan (tratamiento cedular). No calculamos un monto acá porque depende de tu situación particular — consultá a tu contador.
      </div>
      `}
      <div class="tax-disclaimer">Estimación educativa sobre el valor de esta cartera únicamente — no contempla el resto de tu patrimonio (inmuebles, otras cuentas) ni distingue bienes del país vs. del exterior (los CEDEARs, al representar acciones extranjeras, podrían tener otro tratamiento). Escalas: AFIP/ARCA, período fiscal 2025 (vencimiento 2026). No es asesoramiento impositivo — consultá a un contador para tu declaración real.</div>
    </div>`;
}

/** Agrega los holdings con su señal ya resuelta en portState.data: valor
 *  total, score ponderado por peso en la cartera, concentración por activo
 *  y por sector, y qué posiciones tienen señal de Venta/Reducir. Todo a
 *  partir de datos reales — nada se inventa si falta el precio de un ticker. */
function computePortfolioStats(holdings) {
  const rows = holdings.map(h => {
    const d = portState.data[h.ticker];
    const price = d?.price ?? null;
    // La "cantidad" sigue a la moneda del costo: si el costo está en ARS, son
    // CEDEARs; si está en USD, son acciones del subyacente. El ratio real del
    // CEDEAR (universe.json) convierte entre unidades sin pasar por el CCL —
    // mezclar unidades daba valores corridos por el ratio (ej. 1:20 en AAPL).
    const isCedearUnits = h.costCurrency === 'ARS';
    let value = null, valueArs = null;
    if (isCedearUnits && d?.ratio) {
      value = price != null ? (price / d.ratio) * h.shares : null;
      valueArs = d?.cedearArs != null ? d.cedearArs * h.shares : null;
    } else {
      value = price != null ? price * h.shares : null;
      valueArs = d?.cedearArs != null && d?.ratio ? d.cedearArs * d.ratio * h.shares : null;
    }
    return { ...h, d, value, valueArs };
  });
  const totalValue = rows.reduce((s, r) => s + (r.value ?? 0), 0);
  const arsEligibleRows = rows.filter(r => r.valueArs != null);
  const totalValueArs = arsEligibleRows.length ? arsEligibleRows.reduce((s, r) => s + r.valueArs, 0) : null;
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
        // Retorno REAL (ajustado por inflación): solo tiene sentido para el
        // costo cargado en ARS, contra el IPC argentino — ajustar un costo en
        // USD por inflación argentina daría un número sin significado real,
        // así que esa combinación queda deliberadamente sin calcular.
        if (isArs && r.purchaseDate && portState.inflacion?.items?.length) {
          const infl = computeInflationFactor(portState.inflacion.items, r.purchaseDate, new Date().toISOString().slice(0, 10));
          if (infl) {
            r.inflationFactor = infl.factor;
            r.inflationMonths = infl.monthsUsed;
            r.realGainPct = (1 + r.gainPct) / infl.factor - 1;
          }
        }
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

  // Retorno real agregado (ARS, ajustado por IPC) — solo entre las posiciones
  // que tienen fecha de compra cargada; si ninguna la tiene, queda null (no
  // se estima con una fecha inventada).
  const arsRowsWithReal = arsRows.filter(r => r.realGainPct != null);
  const totalRealGainArs = arsRowsWithReal.length ? arsRowsWithReal.reduce((s, r) => s + r.avgCost * r.shares * r.realGainPct, 0) : null;
  const totalRealCostArs = arsRowsWithReal.length ? sumCost(arsRowsWithReal) : null;

  return {
    rows, totalValue, totalValueArs, arsEligibleCount: arsEligibleRows.length,
    weightedScore, sectorRows, topHolding, concentrationRisk, sectorRisk, sellSignals,
    totalGainUsd, totalCostUsd, totalGainArs, totalCostArs, totalRealGainArs, totalRealCostArs,
  };
}

function portfolioRiskNotes(stats, risk = null) {
  const notes = [];
  if (stats.concentrationRisk) notes.push({ type: 'risk', text: `${stats.topHolding.ticker} representa ${Math.round(stats.topHolding.weight * 100)}% de la cartera — concentración alta en un solo activo.` });
  if (stats.sectorRisk) notes.push({ type: 'risk', text: `El sector ${stats.sectorRisk.sector} concentra ${Math.round(stats.sectorRisk.pct * 100)}% de la cartera.` });
  if (stats.sellSignals.length) notes.push({ type: 'risk', text: `${stats.sellSignals.length} posición(es) con señal de Venta/Reducir: ${stats.sellSignals.map(r => r.ticker).join(', ')}.` });
  for (const o of risk?.overlaps ?? []) {
    notes.push({ type: 'risk', text: `${o.a} y ${o.b} se mueven casi igual (correlación ${o.corr.toFixed(2)}) — tenerlos a ambos diversifica menos de lo que parece.` });
  }
  if (!notes.length && stats.rows.length) notes.push({ type: 'ok', text: 'Sin señales de concentración excesiva, solapamiento ni posiciones en zona de Venta/Reducir en este momento.' });
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
  const header = 'ticker,shares,avgCost,costCurrency,purchaseDate';
  const lines = holdings.map(h => `${h.ticker},${h.shares},${h.avgCost ?? ''},${h.costCurrency ?? 'USD'},${h.purchaseDate ?? ''}`);
  return [header, ...lines].join('\n');
}

function parseHoldingsCsv(text) {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const out = [];
  for (const line of lines) {
    const [ticker, shares, avgCost, costCurrency, purchaseDate] = line.split(',').map(x => x?.trim());
    if (!ticker || ticker.toLowerCase() === 'ticker') continue; // salteo encabezado
    const sharesNum = parseFloat(shares);
    if (!sharesNum || sharesNum <= 0) continue;
    const costNum = avgCost ? parseFloat(avgCost) : null;
    const dateOk = purchaseDate && /^\d{4}-\d{2}-\d{2}$/.test(purchaseDate) ? purchaseDate : null;
    out.push({ ticker: ticker.toUpperCase(), shares: sharesNum, avgCost: costNum != null && !isNaN(costNum) ? costNum : null, costCurrency: costCurrency === 'ARS' ? 'ARS' : 'USD', purchaseDate: dateOk });
  }
  return out;
}

/* ── modo privacidad: oculta montos absolutos (los % siempre se ven) ── */
function pv(formatted) { return portState.privacy ? '•••' : formatted; }

/* ── registro de operaciones (compras/ventas) — localStorage, este navegador ── */
const PORT_OPS_KEY = 'icp_port_ops';
const PORT_OPS_MAX = 100;
function getPortOps() {
  try { const v = JSON.parse(localStorage.getItem(PORT_OPS_KEY) || '[]'); return Array.isArray(v) ? v : []; } catch { return []; }
}
function logPortOp(op) {
  const list = getPortOps();
  list.unshift({ ...op, ts: Date.now() });
  lsSetSafe(PORT_OPS_KEY, JSON.stringify(list.slice(0, PORT_OPS_MAX)));
}

/** P&L realizado (ventas registradas) vs. no realizado (posiciones abiertas),
 *  separado por moneda — nunca se suman pesos con dólares. */
function opsCardHTML(stats) {
  const ops = getPortOps();
  const realized = { USD: 0, ARS: 0 };
  let realizedCount = 0;
  for (const op of ops) {
    if (op.type === 'sell' && op.realized != null) { realized[op.currency === 'ARS' ? 'ARS' : 'USD'] += op.realized; realizedCount++; }
  }
  const fmtCur = (cur, n) => cur === 'ARS' ? fmtArs(n) : fmtUsd(n);
  const recent = ops.slice(0, 8);
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Operaciones y P&amp;L realizado</div>
      <div class="port-ops-summary">
        <div class="risk-metric">
          <div class="risk-metric-label">Realizado (ventas registradas)</div>
          <div class="risk-metric-value">${realizedCount ? [realized.USD ? `<span class="${realized.USD >= 0 ? 'up' : 'down'}">${realized.USD >= 0 ? '+' : ''}${pv(fmtUsd(realized.USD))}</span>` : '', realized.ARS ? `<span class="${realized.ARS >= 0 ? 'up' : 'down'}">${realized.ARS >= 0 ? '+' : ''}${pv(fmtArs(realized.ARS))}</span>` : ''].filter(Boolean).join(' · ') : 'Sin ventas registradas'}</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">No realizado (posiciones abiertas)</div>
          <div class="risk-metric-value">${[stats?.totalGainUsd != null ? `<span class="${stats.totalGainUsd >= 0 ? 'up' : 'down'}">${stats.totalGainUsd >= 0 ? '+' : ''}${pv(fmtUsd(stats.totalGainUsd))}</span>` : '', stats?.totalGainArs != null ? `<span class="${stats.totalGainArs >= 0 ? 'up' : 'down'}">${stats.totalGainArs >= 0 ? '+' : ''}${pv(fmtArs(stats.totalGainArs))}</span>` : ''].filter(Boolean).join(' · ') || 'N/D (cargá costo promedio)'}</div>
        </div>
      </div>
      ${recent.length ? `
      <div class="port-ops-list">
        ${recent.map(op => `
          <div class="port-ops-row">
            <span class="port-ops-type ${op.type === 'sell' ? 'sell' : 'buy'}">${op.type === 'sell' ? 'VENTA' : 'COMPRA'}</span>
            <span class="port-reco-ticker">${esc(op.ticker)}</span>
            <span class="port-ops-detail">${op.shares} × ${op.price != null ? pv(fmtCur(op.currency, op.price)) : 's/precio'}</span>
            <span class="port-ops-realized ${op.realized != null ? (op.realized >= 0 ? 'up' : 'down') : ''}">${op.realized != null ? `${op.realized >= 0 ? '+' : ''}${pv(fmtCur(op.currency, op.realized))}` : ''}</span>
            <span class="alert-history-time">${esc(relativeTime(op.ts))}</span>
          </div>`).join('')}
      </div>` : `<div class="port-note" style="padding-top:8px;">Registrá una venta con el botón ⤓ de cada fila (o agregá posiciones nuevas con costo) para construir tu historial de operaciones y separar ganancia realizada de no realizada. Solo se guarda en este navegador.</div>`}
    </div>`;
}

/* ── historial de cambios de recomendación por posición ── */
const PORT_RECO_HIST_KEY = 'icp_port_reco_hist';
const PORT_RECO_LAST_KEY = 'icp_port_reco_last';
function trackRecoChanges(rows) {
  let last, hist;
  try { last = JSON.parse(localStorage.getItem(PORT_RECO_LAST_KEY) || '{}'); } catch { last = {}; }
  try { hist = JSON.parse(localStorage.getItem(PORT_RECO_HIST_KEY) || '[]'); } catch { hist = []; }
  let changed = false;
  for (const r of rows) {
    if (!r.d) continue;
    const reco = portfolioRecommendation(r);
    if (!reco) continue;
    const prev = last[r.ticker];
    if (prev && prev !== reco.label) { hist.unshift({ ticker: r.ticker, from: prev, to: reco.label, ts: Date.now() }); changed = true; }
    if (prev !== reco.label) { last[r.ticker] = reco.label; changed = true; }
  }
  if (changed) {
    lsSetSafe(PORT_RECO_LAST_KEY, JSON.stringify(last));
    lsSetSafe(PORT_RECO_HIST_KEY, JSON.stringify(hist.slice(0, 50)));
  }
  return hist;
}
function recoHistoryCardHTML(hist) {
  if (!hist.length) return '';
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Cambios de recomendación</div>
      <div class="port-note" style="padding:0 0 8px;">Cuándo cambió la recomendación de cada posición, según lo que este navegador observó — sirve para revisar si los cambios anticiparon movimientos.</div>
      ${hist.slice(0, 8).map(h => `
        <div class="port-ops-row">
          <span class="port-reco-ticker">${esc(h.ticker)}</span>
          <span class="port-ops-detail">${esc(h.from)} → <strong>${esc(h.to)}</strong></span>
          <span class="alert-history-time">${esc(relativeTime(h.ts))}</span>
        </div>`).join('')}
    </div>`;
}

/* ── rebalanceo sugerido según el perfil de riesgo (Configuración) ── */
function rebalanceSuggestions(stats) {
  const cap = RISK_PROFILES[settingsState.riskProfile].maxPositionPct / 100;
  const over = stats.rows.filter(r => r.weight != null && r.weight > cap && r.value != null && r.value > 0 && r.shares > 0);
  const suggestions = over.map(r => {
    const perUnitUsd = r.value / r.shares; // USD por unidad TAL COMO la tiene cargada (CEDEAR o acción)
    const excessValue = (r.weight - cap) * stats.totalValue;
    return { ticker: r.ticker, from: r.weight, to: cap, excessValue, units: excessValue / perUnitUsd };
  }).sort((a, b) => b.excessValue - a.excessValue);
  const candidates = stats.rows
    .filter(r => r.weight != null && r.weight < cap && (r.d?.scoreLabel === 'Compra Fuerte' || r.d?.scoreLabel === 'Compra Moderada'))
    .sort((a, b) => b.d.score - a.d.score).slice(0, 3);
  return { cap, suggestions, candidates };
}
function rebalanceCardHTML(stats) {
  const { cap, suggestions, candidates } = rebalanceSuggestions(stats);
  if (!suggestions.length) return '';
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Rebalanceo sugerido — perfil ${esc(RISK_PROFILES[settingsState.riskProfile].label)}</div>
      ${suggestions.map(s => `
        <div class="port-note risk">⚠ <strong>${esc(s.ticker)}</strong>: pesa ${Math.round(s.from * 100)}% y tu perfil sugiere un tope de ${Math.round(cap * 100)}% — para volver al tope habría que vender ~${s.units >= 10 ? Math.round(s.units) : s.units.toFixed(2)} unidades (${pv(fmtUsd(s.excessValue))}).</div>`).join('')}
      ${candidates.length ? `<div class="port-note" style="padding-top:6px;">Candidatos para reasignar (señal de compra y por debajo del tope): ${candidates.map(c => `<strong>${esc(c.ticker)}</strong> (score ${c.d.score}, pesa ${Math.round(c.weight * 100)}%)`).join(' · ')}.</div>` : ''}
      <div class="port-note" style="padding-top:6px; color:var(--text-mute);">Sugerencia determinística basada en el tope por posición de tu perfil de riesgo (Configuración) y el score actual — no es asesoramiento financiero; revisá comisiones e impuestos antes de operar.</div>
    </div>`;
}

/* ── asignador: "¿qué compro con AR$ X?" ── */
function computeAllocation(amountArs, stats, ccl) {
  if (!amountArs || amountArs <= 0) return null;
  const cap = RISK_PROFILES[settingsState.riskProfile].maxPositionPct / 100;
  const cclValue = ccl?.value ?? null;
  const candidates = stats.rows
    .filter(r => r.d && (r.d.scoreLabel === 'Compra Fuerte' || r.d.scoreLabel === 'Compra Moderada'))
    .map(r => {
      const unitArs = r.d.cedearArs ?? (cclValue && r.d.price ? r.d.price * cclValue : null);
      if (!unitArs) return null;
      const isCedear = r.d.cedearArs != null;
      const units = isCedear ? Math.floor(amountArs / unitArs) : amountArs / unitArs;
      if (units <= 0) return null;
      const cost = units * unitArs;
      // USD real gastado: CEDEARs valen precio/ratio en dólares; cripto se
      // compra fraccionado al precio del subyacente.
      const usdPerUnit = isCedear ? (r.d.ratio ? r.d.price / r.d.ratio : (cclValue ? unitArs / cclValue : null)) : r.d.price;
      const usdSpent = usdPerUnit != null ? units * usdPerUnit : null;
      const newValueUsd = usdSpent != null ? (r.value ?? 0) + usdSpent : null;
      const newTotalUsd = usdSpent != null ? stats.totalValue + usdSpent : null;
      const newWeight = newValueUsd != null && newTotalUsd > 0 ? newValueUsd / newTotalUsd : null;
      return {
        ticker: r.ticker, score: r.d.score, scoreLabel: r.d.scoreLabel, unitArs, units, cost,
        leftover: amountArs - cost, isCedear, estimated: !isCedear || r.d.cedearSource !== 'live',
        newWeight, overCap: newWeight != null && newWeight > cap,
      };
    })
    .filter(Boolean)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3);
  return { amountArs, candidates, cap };
}
function allocatorCardHTML(stats) {
  const res = portState.allocResult;
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">¿Qué compro con estos pesos?</div>
      <div class="port-form" style="margin-bottom:${res ? '12px' : '0'};">
        <input type="number" id="port-alloc-amount" class="port-input" placeholder="Monto en AR$ (ej. 100000)" aria-label="Monto en pesos a invertir" min="0" step="any" value="${esc(String(portState.allocAmount || ''))}" />
        <button class="port-add-btn" id="port-alloc-run">Sugerir</button>
      </div>
      ${!res ? '' : !res.candidates.length ? `<div class="port-note">Con ${pv(fmtArs(res.amountArs))} no alcanza ninguna unidad de tus posiciones con señal de compra (o ninguna tiene señal de compra ahora). La sugerencia solo mira TUS tenencias actuales — para ideas nuevas está el Dashboard.</div>` : `
        ${res.candidates.map((c, i) => `
          <div class="port-note ${i === 0 ? 'ok' : ''}">
            ${i === 0 ? '✓' : '·'} <strong>${esc(c.ticker)}</strong> (${esc(c.scoreLabel)} · ${c.score}): ${c.isCedear ? `${c.units} CEDEAR(s)` : `${c.units.toFixed(6)} unidades`} a ${pv(fmtArs(c.unitArs))}${c.estimated ? ' ≈' : ''} = ${pv(fmtArs(c.cost))}${c.isCedear && c.leftover > 0 ? ` (sobran ${pv(fmtArs(c.leftover))})` : ''}${c.overCap ? ` — ⚠ quedaría en ${Math.round(c.newWeight * 100)}%, sobre el tope de ${Math.round(res.cap * 100)}% de tu perfil` : ''}
          </div>`).join('')}
        <div class="port-note" style="padding-top:6px; color:var(--text-mute);">Ranking por score entre TUS posiciones con señal de compra, a la última cotización del CEDEAR (≈ = estimada vía CCL). No es asesoramiento financiero.</div>
      `}
    </div>`;
}

/* ── benchmarks argentinos: cartera en dólares CCL y vs inflación ── */
function cclAtDate(items, dateStr) {
  let best = null;
  for (const it of items) { if (it.fecha <= dateStr) best = it; else break; }
  return best?.venta ?? null;
}
function portfolioBenchmarks(stats) {
  const hist = portState.cclHistory?.items;
  if (!hist?.length) return null;
  const cclNow = portState.ccl?.value ?? hist[hist.length - 1].venta;
  const rows = [];
  for (const r of stats.rows) {
    if (!r.purchaseDate || r.gainPct == null) continue;
    const cclThen = cclAtDate(hist, r.purchaseDate);
    if (!cclThen) continue;
    const cclReturn = cclNow / cclThen - 1;
    // Retorno medido en dólares CCL: para costo en ARS se descuenta lo que
    // subió el CCL; un costo en USD ya está en dólares (no se convierte).
    const usdReturn = r.costCurrency === 'ARS' ? (1 + r.gainPct) / (1 + cclReturn) - 1 : r.gainPct;
    rows.push({
      ticker: r.ticker, purchaseDate: r.purchaseDate, currency: r.gainCurrency,
      nominal: r.gainPct, cclReturn, usdReturn,
      realGainPct: r.realGainPct ?? null, // ya calculado (IPC) solo para costo ARS con fecha
    });
  }
  return rows.length ? { rows, cclNow } : null;
}
function benchmarksCardHTML(stats) {
  const b = portfolioBenchmarks(stats);
  if (!b) {
    const anyDates = stats.rows.some(r => r.purchaseDate);
    // Sin fechas de compra no hay nada que comparar; y si la serie del CCL ya
    // se pidió y vino vacía (modo demo / fuente caída), se oculta la card en
    // vez de fingir que "está cargando" para siempre.
    if (!anyDates || portState.cclHistory != null) return '';
    return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Tu cartera en dólares (CCL) y vs. inflación</div>
      <div class="dash-loading-note">Cargando la serie histórica del CCL (argentinadatos.com)…</div>
    </div>`;
  }
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Tu cartera en dólares (CCL) y vs. inflación</div>
      <div class="port-note" style="padding:0 0 10px;">Ganar en pesos no siempre es ganar: acá cada posición con fecha de compra se mide también en dólares CCL (¿le ganaste al dólar?) y en términos reales (¿le ganaste al IPC?). CCL hoy: ${pv(fmtArs(b.cclNow))}.</div>
      <div class="port-table-wrap">
        <table class="sim-table">
          <thead><tr><th>Ticker</th><th>Desde</th><th>Nominal</th><th>Suba del CCL</th><th>En dólares (CCL)</th><th>Real (IPC)</th></tr></thead>
          <tbody>
            ${b.rows.map(r => `
              <tr>
                <td style="font-weight:700;">${esc(r.ticker)}</td>
                <td>${esc(r.purchaseDate)}</td>
                <td class="${r.nominal >= 0 ? 'bt-pos' : 'bt-neg'}">${fmtPct(r.nominal * 100)} <span class="port-pnl-abs">${r.currency}</span></td>
                <td>${r.currency === 'ARS' ? fmtPct(r.cclReturn * 100) : '<span class="bt-nd">— (costo ya en USD)</span>'}</td>
                <td class="${r.usdReturn >= 0 ? 'bt-pos' : 'bt-neg'}">${fmtPct(r.usdReturn * 100)}</td>
                <td class="${r.realGainPct != null ? (r.realGainPct >= 0 ? 'bt-pos' : 'bt-neg') : 'bt-nd'}">${r.realGainPct != null ? fmtPct(r.realGainPct * 100) : '—'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="port-note" style="padding-top:8px; color:var(--text-mute);">CCL histórico: argentinadatos.com (cotización más cercana anterior a tu fecha de compra). Real (IPC): solo para costos en pesos con fecha, contra el IPC oficial — las posiciones sin fecha de compra no aparecen acá.</div>
    </div>`;
}

/* ── dividendos agregados de la cartera ── */
function portfolioDividendsCardHTML(stats) {
  const cutoff = Date.now() - 365 * 86400000;
  const perHolding = [];
  let pending = 0;
  for (const r of stats.rows) {
    const div = portState.dividends[r.ticker];
    if (div === undefined) { pending++; continue; }
    const items = div?.items ?? [];
    if (!items.length || r.d?.price == null) continue;
    const ttm = items.filter(x => new Date(x.date + 'T00:00:00Z').getTime() >= cutoff).reduce((s, x) => s + x.amount, 0);
    if (ttm <= 0) continue;
    perHolding.push({
      ticker: r.ticker, ttmPerShare: ttm, income: ttm * underlyingShares(r),
      yieldPct: r.d.price > 0 ? (ttm / r.d.price) * 100 : null,
      lastDate: items[0].date, lastAmount: items[0].amount, nextEx: div.nextExDate ?? null,
    });
  }
  if (!perHolding.length && pending) {
    return `<div class="card port-notes-card"><div class="dash-radar-title">Dividendos de la cartera</div><div class="dash-loading-note">Cargando historial de dividendos…</div></div>`;
  }
  if (!perHolding.length) return '';
  perHolding.sort((a, b) => b.income - a.income);
  const totalIncome = perHolding.reduce((s, x) => s + x.income, 0);
  const weightedYield = stats.totalValue > 0 ? (totalIncome / stats.totalValue) * 100 : null;
  return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Dividendos de la cartera</div>
      <div class="port-ops-summary">
        <div class="risk-metric">
          <div class="risk-metric-label">Yield ponderado (TTM)</div>
          <div class="risk-metric-value up">${weightedYield != null ? weightedYield.toFixed(2) + '%' : 'N/D'}</div>
        </div>
        <div class="risk-metric">
          <div class="risk-metric-label">Ingreso anual estimado</div>
          <div class="risk-metric-value">${pv(fmtUsd(totalIncome))}</div>
          <div class="risk-metric-hint">lo pagado en los últimos 12 meses × tu tenencia actual</div>
        </div>
      </div>
      ${perHolding.slice(0, 6).map(h => `
        <div class="port-ops-row">
          <span class="port-reco-ticker">${esc(h.ticker)}</span>
          <span class="port-ops-detail">${pv(fmtUsd(h.income))}/año · yield ${h.yieldPct != null ? h.yieldPct.toFixed(2) + '%' : 'N/D'}${h.nextEx ? ` · próx. ex ${esc(h.nextEx)}` : ''}</span>
          <span class="alert-history-time">último: ${pv(fmtUsd(h.lastAmount))} el ${esc(h.lastDate)}</span>
        </div>`).join('')}
      <div class="port-note" style="padding-top:8px; color:var(--text-mute);">Historial real de fechas ex-dividend (Yahoo Finance). El próximo ex-dividend es una estimación por la cadencia histórica, no una fecha confirmada. Recordá que los dividendos tributan Ganancias (ver Impacto fiscal).</div>
    </div>`;
}

/* ── treemap de la cartera: cajas por peso, color por P&L ── */
function portfolioTreemapSVG(rows) {
  const items = rows.filter(r => r.value != null && r.value > 0).sort((a, b) => b.value - a.value);
  if (items.length < 2) return '';
  const W = 1000, H = 300, GAP = 3;
  let x = 0, y = 0, w = W, h = H;
  let remaining = items.reduce((s, r) => s + r.value, 0);
  const rects = [];
  for (let i = 0; i < items.length; i++) {
    const r = items[i];
    const frac = r.value / remaining;
    let rx = x, ry = y, rw, rh;
    if (i === items.length - 1) { rw = w; rh = h; }
    else if (w >= h) { rw = w * frac; rh = h; x += rw; w -= rw; }
    else { rh = h * frac; rw = w; y += rh; h -= rh; }
    remaining -= r.value;
    rects.push({ r, x: rx, y: ry, w: rw, h: rh });
  }
  const fillFor = (g) => {
    if (g == null) return 'oklch(0.35 0.02 262)';
    const mag = Math.min(1, Math.abs(g) / 0.4);
    return g >= 0 ? `oklch(${0.32 + mag * 0.14} ${0.06 + mag * 0.09} 152)` : `oklch(${0.32 + mag * 0.12} ${0.06 + mag * 0.10} 23)`;
  };
  return `
    <div class="card treemap-card">
      <div class="dash-radar-title">Mapa de la cartera <span class="risk-days-note">— tamaño = peso, color = P&amp;L</span></div>
      <svg class="treemap-svg" viewBox="0 0 ${W} ${H}" role="img" aria-label="Treemap de la cartera">
        ${rects.map(({ r, x, y, w, h }) => {
          const big = w > 90 && h > 46;
          const mid = w > 56 && h > 30;
          return `
          <g>
            <rect x="${(x + GAP / 2).toFixed(1)}" y="${(y + GAP / 2).toFixed(1)}" width="${Math.max(1, w - GAP).toFixed(1)}" height="${Math.max(1, h - GAP).toFixed(1)}" rx="6" fill="${fillFor(r.gainPct)}" stroke="oklch(0.22 0.02 262)" stroke-width="1">
              <title>${esc(r.ticker)} — ${Math.round((r.weight ?? 0) * 100)}% de la cartera${portState.privacy ? '' : ` · ${fmtUsd(r.value)}`}${r.gainPct != null ? ` · P&L ${fmtPct(r.gainPct * 100)}` : ''}</title>
            </rect>
            ${mid ? `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2 + (big ? -8 : 4)).toFixed(1)}" text-anchor="middle" class="treemap-ticker">${esc(r.ticker)}</text>` : ''}
            ${big ? `<text x="${(x + w / 2).toFixed(1)}" y="${(y + h / 2 + 12).toFixed(1)}" text-anchor="middle" class="treemap-sub">${Math.round((r.weight ?? 0) * 100)}%${r.gainPct != null ? ` · ${fmtPct(r.gainPct * 100)}` : ''}</text>` : ''}
          </g>`;
        }).join('')}
      </svg>
    </div>`;
}

/* ═══════════════════ RADIOGRAFÍA DE CARTERA (capa de inteligencia) ═══════════
 * Tres motores nuevos, todos sobre datos ya calculados (stats + risk), sin
 * pedidos extra ni números inventados:
 *   1. Copiloto: nota A-F + diagnóstico ejecutivo + acciones prioritarias.
 *   2. Monte Carlo: proyección a 12 meses por bootstrap de los retornos
 *      diarios REALES de la cartera (no una gaussiana teórica), con bandas.
 *   3. Estrés: impacto de shocks de mercado/cripto/posición, por beta real.
 * ─────────────────────────────────────────────────────────────────────────── */

const PORT_TABS = [
  { key: 'resumen', label: 'Resumen', icon: 'grid' },
  { key: 'riesgo', label: 'Riesgo & Proyección', icon: 'trend' },
  { key: 'operar', label: 'Operar', icon: 'shuffle' },
  { key: 'tenencias', label: 'Tenencias', icon: 'briefcase' },
];

/** Cuenta posiciones con el precio a ≤3% del stop sugerido (decisión inminente). */
function nearStopRows(stats) {
  return stats.rows.filter(r => {
    const pr = r.d?.planRaw;
    return pr?.stopLoss != null && r.d.price > 0 && ((r.d.price - pr.stopLoss) / r.d.price) * 100 <= 3;
  });
}
function isCryptoPos(r) {
  return CRYPTO_RELATED.has(r.ticker) || /crypto|cripto/i.test(r.d?.category ?? '');
}

/** Copiloto de cartera: convierte las métricas ya calculadas en una lectura
 *  ejecutiva en criollo, una nota A-F (derivada del health score, ajustada por
 *  señales críticas) y una lista PRIORIZADA de acciones concretas. No es una
 *  opinión de IA: cada punto sale de un umbral trazable sobre datos reales. */
function portfolioCopilot(stats, risk, health) {
  if (!stats?.rows?.length) return null;
  const points = [], actions = [];
  const topW = stats.topHolding?.weight ?? null;
  const topSector = stats.sectorRows?.[0] ?? null;
  const sells = stats.sellSignals ?? [];
  const near = nearStopRows(stats);

  // Diagnóstico (lecturas)
  if (topW != null) {
    if (topW >= 0.4) { points.push({ tone: 'bad', text: `Muy concentrada: ${esc(stats.topHolding.ticker)} es el ${Math.round(topW * 100)}% de la cartera. Un mal día de ese activo te pega de lleno.` }); actions.push({ pri: 1, text: `Bajá el peso de ${stats.topHolding.ticker} (hoy ${Math.round(topW * 100)}%) hacia ≤15-20% para no depender de un solo activo.` }); }
    else if (topW >= 0.25) points.push({ tone: 'warn', text: `Algo concentrada: tu mayor posición (${esc(stats.topHolding.ticker)}) pesa ${Math.round(topW * 100)}%.` });
    else points.push({ tone: 'good', text: `Bien distribuida por activo: ninguna posición domina (la mayor es ${Math.round(topW * 100)}%).` });
  }
  if (topSector && topSector.pct >= 0.5) { points.push({ tone: 'bad', text: `Muy expuesta a un sector: ${esc(topSector.sector)} es el ${Math.round(topSector.pct * 100)}% de la cartera.` }); actions.push({ pri: 2, text: `Diversificá fuera de ${topSector.sector} (${Math.round(topSector.pct * 100)}%): sumá activos de otros sectores para no jugarte a una sola industria.` }); }
  else if (topSector && topSector.pct >= 0.35) points.push({ tone: 'warn', text: `${esc(topSector.sector)} concentra el ${Math.round(topSector.pct * 100)}% — el sector más pesado.` });

  if (risk) {
    if (risk.annualizedVol >= 0.4) points.push({ tone: 'bad', text: `Volatilidad alta: ${(risk.annualizedVol * 100).toFixed(0)}% anual. Esperá swings fuertes de valor.` });
    else if (risk.annualizedVol >= 0.25) points.push({ tone: 'warn', text: `Volatilidad media-alta: ${(risk.annualizedVol * 100).toFixed(0)}% anual.` });
    else points.push({ tone: 'good', text: `Volatilidad contenida: ${(risk.annualizedVol * 100).toFixed(0)}% anual.` });
    if (risk.beta != null && risk.beta >= 1.3) points.push({ tone: 'warn', text: `Beta ${risk.beta.toFixed(2)}: amplificás al mercado — si SPY cae 10%, tendés a caer ~${(risk.beta * 10).toFixed(0)}%.` });
    if (risk.sharpe != null) {
      if (risk.sharpe >= 1) points.push({ tone: 'good', text: `Buen retorno ajustado por riesgo (Sharpe ${risk.sharpe.toFixed(2)}).` });
      else if (risk.sharpe < 0) points.push({ tone: 'warn', text: `Sharpe negativo (${risk.sharpe.toFixed(2)}): en esta ventana, el riesgo no se pagó con retorno.` });
    }
    if (risk.overlaps?.length) { points.push({ tone: 'warn', text: `${risk.overlaps.length} par(es) de activos se mueven casi igual (correlación >0.8) — esa diversificación es en parte ilusoria.` }); actions.push({ pri: 4, text: `Revisá los pares muy correlacionados (ej. ${esc(risk.overlaps[0].a)}/${esc(risk.overlaps[0].b)}): tener los dos no diversifica tanto como parece.` }); }
    if (risk.portfolioTotalReturn != null && risk.spyTotalReturn != null) {
      const diff = (risk.portfolioTotalReturn - risk.spyTotalReturn) * 100;
      points.push({ tone: diff >= 0 ? 'good' : 'warn', text: `Contra el S&P 500 (mismo período): ${diff >= 0 ? 'le ganás' : 'quedás atrás'} por ${Math.abs(diff).toFixed(1)} puntos.` });
    }
  }

  if (sells.length) { const w = Math.round(sells.reduce((s, r) => s + (r.weight ?? 0), 0) * 100); points.push({ tone: 'warn', text: `${sells.length} posición(es) en señal de Venta/Reducir (${w}% del peso).` }); actions.push({ pri: 3, text: `Definí qué hacés con las ${sells.length} posición(es) en Venta/Reducir (${w}% de la cartera): sostener con tesis clara o achicar.` }); }
  if (near.length) { points.push({ tone: 'bad', text: `${near.length} posición(es) a ≤3% del stop sugerido — decisión inminente.` }); actions.push({ pri: 0, text: `Atención URGENTE: ${near.map(r => esc(r.ticker)).join(', ')} está(n) pegada(s) al stop. Decidí ahora si respetás el stop o ajustás la tesis.` }); }

  const gradeFor = (s) => s >= 85 ? 'A' : s >= 72 ? 'B' : s >= 58 ? 'C' : s >= 42 ? 'D' : 'F';
  let base = health?.score ?? 60;
  if (near.length) base -= 6; // riesgo inminente pesa aunque el resto esté ok
  base = Math.max(0, Math.min(100, base));
  const grade = gradeFor(base);
  const gradeColor = base >= 72 ? GREEN : base >= 58 ? AMBER : RED;

  const headline = grade === 'A' ? 'Cartera sólida y bien equilibrada.'
    : grade === 'B' ? 'Cartera saludable, con detalles para pulir.'
    : grade === 'C' ? 'Cartera aceptable, pero con riesgos concretos a atender.'
    : grade === 'D' ? 'Cartera con problemas de riesgo que conviene corregir.'
    : 'Cartera con riesgo alto — varias señales críticas juntas.';

  actions.sort((a, b) => a.pri - b.pri);
  return { grade, gradeColor, healthScore: base, headline, points, actions: actions.slice(0, 4) };
}

function portfolioCopilotCardHTML(cp, health) {
  if (!cp) return '';
  return `
    <div class="card port-copilot-card">
      <div class="copilot-top">
        <div class="copilot-grade" style="border-color:${cp.gradeColor}; color:${cp.gradeColor};">
          <div class="copilot-grade-letter">${cp.grade}</div>
          <div class="copilot-grade-score">${cp.healthScore}/100</div>
        </div>
        <div class="copilot-head-text">
          <div class="copilot-eyebrow">Radiografía de tu cartera</div>
          <div class="copilot-headline">${esc(cp.headline)}</div>
          <div class="copilot-sub">Diagnóstico automático sobre tus métricas reales — no es asesoramiento financiero.</div>
        </div>
      </div>
      ${cp.actions.length ? `
      <div class="copilot-actions">
        <div class="copilot-actions-title">⚡ Qué haría primero</div>
        <ol class="copilot-actions-list">
          ${cp.actions.map(a => `<li>${a.text}</li>`).join('')}
        </ol>
      </div>` : `<div class="copilot-actions"><div class="copilot-actions-title">✓ Sin acciones urgentes</div><div class="copilot-sub">No detecté señales críticas — mantené el seguimiento habitual.</div></div>`}
      <div class="copilot-points">
        ${cp.points.map(p => `<div class="copilot-point ${p.type ?? p.tone}"><span class="copilot-dot ${p.tone}"></span>${p.text}</div>`).join('')}
      </div>
    </div>`;
}

/* ─────────────────────── Proyección Monte Carlo ─────────────────────── */
const MC_SIMS = 350, MC_HORIZON = 252, MC_STEPS = 12; // 12 puntos mensuales
// PRNG determinista (mulberry32) + hash de string — para que la simulación dé
// SIEMPRE el mismo resultado con la misma cartera (no titila entre refrescos).
function mcHash(str) { let h = 2166136261 >>> 0; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }
function mcRng(seed) { let a = seed >>> 0; return function () { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

/** Proyecta el valor de la cartera 12 meses hacia adelante por bootstrap:
 *  reMuestrea los retornos diarios REALES de tu cartera (con reemplazo) para
 *  armar miles de futuros posibles — así preserva la forma real de la
 *  distribución (colas gordas incluidas), en vez de asumir una campana de
 *  Gauss. Determinista (semilla fija por composición) para no titilar entre
 *  refrescos. */
function monteCarloProjection(stats, risk) {
  const rets = risk?.portfolioReturns;
  const start = stats?.totalValue;
  if (!rets || rets.length < 40 || !(start > 0)) return null;
  // Semilla estable derivada de la composición (tickers+pesos redondeados).
  const seedStr = stats.rows.map(r => `${r.ticker}:${Math.round((r.weight ?? 0) * 100)}`).join('|');
  const rand = mcRng(mcHash(seedStr) ^ 0xC0FFEE);
  const stepDays = Math.floor(MC_HORIZON / MC_STEPS);
  const n = rets.length;
  // Para cada simulación guardamos el multiplicador acumulado en cada step.
  const stepMultsAll = Array.from({ length: MC_STEPS }, () => []);
  const endMults = [];
  for (let s = 0; s < MC_SIMS; s++) {
    let mult = 1;
    for (let step = 0; step < MC_STEPS; step++) {
      for (let d = 0; d < stepDays; d++) {
        const r = rets[Math.floor(rand() * n)];
        mult *= (1 + r);
      }
      stepMultsAll[step].push(mult);
    }
    endMults.push(mult);
  }
  const pctl = (arr, p) => {
    const a = [...arr].sort((x, y) => x - y);
    const idx = Math.min(a.length - 1, Math.max(0, Math.round((p / 100) * (a.length - 1))));
    return a[idx];
  };
  const steps = stepMultsAll.map((mults, i) => ({
    month: i + 1,
    p5: start * pctl(mults, 5), p25: start * pctl(mults, 25), p50: start * pctl(mults, 50),
    p75: start * pctl(mults, 75), p95: start * pctl(mults, 95),
  }));
  const probPositive = endMults.filter(m => m > 1).length / endMults.length;
  return {
    start, steps, horizonMonths: 12,
    endP5: start * pctl(endMults, 5), endP25: start * pctl(endMults, 25), endP50: start * pctl(endMults, 50),
    endP75: start * pctl(endMults, 75), endP95: start * pctl(endMults, 95),
    probPositive, sims: MC_SIMS,
    coveredHoldings: risk.coveredHoldings, totalHoldings: risk.totalHoldings,
  };
}

function monteCarloFanSVG(mc) {
  const W = 720, H = 260, PADL = 8, PADR = 8, PADT = 14, PADB = 26;
  const plotW = W - PADL - PADR, plotH = H - PADT - PADB;
  // Punto 0 = hoy (valor inicial) para las 5 bandas.
  const pts = [{ month: 0, p5: mc.start, p25: mc.start, p50: mc.start, p75: mc.start, p95: mc.start }, ...mc.steps];
  const allV = pts.flatMap(p => [p.p5, p.p95]);
  let lo = Math.min(...allV), hi = Math.max(...allV);
  const pad = (hi - lo) * 0.08 || hi * 0.05; lo -= pad; hi += pad;
  const x = (m) => PADL + (m / mc.horizonMonths) * plotW;
  const y = (v) => PADT + (1 - (v - lo) / (hi - lo)) * plotH;
  const band = (loKey, hiKey) => {
    const up = pts.map(p => `${x(p.month).toFixed(1)},${y(p[hiKey]).toFixed(1)}`);
    const dn = [...pts].reverse().map(p => `${x(p.month).toFixed(1)},${y(p[loKey]).toFixed(1)}`);
    return `M${up.join(' L')} L${dn.join(' L')} Z`;
  };
  const line = (key) => pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.month).toFixed(1)},${y(p[key]).toFixed(1)}`).join(' ');
  const startY = y(mc.start);
  const g = GREEN, b = 'oklch(0.72 0.15 250)';
  return `
    <svg class="mc-fan" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" role="img" aria-label="Proyección Monte Carlo del valor de la cartera a 12 meses">
      <path d="${band('p5', 'p95')}" fill="${b}" fill-opacity="0.10" />
      <path d="${band('p25', 'p75')}" fill="${b}" fill-opacity="0.20" />
      <line x1="${PADL}" y1="${startY.toFixed(1)}" x2="${W - PADR}" y2="${startY.toFixed(1)}" stroke="var(--text-faint)" stroke-dasharray="3 4" stroke-width="1" />
      <path d="${line('p50')}" fill="none" stroke="${g}" stroke-width="2.2" />
      <path d="${line('p95')}" fill="none" stroke="${b}" stroke-width="1" stroke-opacity="0.5" />
      <path d="${line('p5')}" fill="none" stroke="${b}" stroke-width="1" stroke-opacity="0.5" />
      ${[3, 6, 9, 12].map(m => `<text x="${x(m).toFixed(1)}" y="${H - 8}" fill="var(--text-mute)" font-size="10" text-anchor="middle" font-family="'IBM Plex Mono',monospace">${m}m</text>`).join('')}
    </svg>`;
}

function monteCarloCardHTML(mc) {
  if (!mc) return '';
  const chg = (v) => ((v - mc.start) / mc.start) * 100;
  const chgTxt = (v) => `${chg(v) >= 0 ? '+' : ''}${chg(v).toFixed(0)}%`;
  return `
    <div class="card port-notes-card mc-card">
      <div class="dash-radar-title">Proyección Monte Carlo — 12 meses</div>
      <div class="mc-intro">${mc.sims.toLocaleString('es-AR')} futuros posibles simulados reMuestreando los retornos diarios reales de tu cartera. La línea verde es el escenario medio; la banda, el rango probable. No es una predicción — es la dispersión de resultados que tu propio riesgo histórico implica.</div>
      <div class="mc-chart-wrap">${monteCarloFanSVG(mc)}</div>
      <div class="mc-stats">
        <div class="mc-stat"><span>Escenario medio (p50)</span><b>${pv(fmtUsd(mc.endP50))}</b><small class="${chg(mc.endP50) >= 0 ? 'up' : 'down'}">${chgTxt(mc.endP50)}</small></div>
        <div class="mc-stat"><span>Optimista (p95)</span><b class="up">${pv(fmtUsd(mc.endP95))}</b><small class="up">${chgTxt(mc.endP95)}</small></div>
        <div class="mc-stat"><span>Pesimista (p5)</span><b class="down">${pv(fmtUsd(mc.endP5))}</b><small class="down">${chgTxt(mc.endP5)}</small></div>
        <div class="mc-stat"><span>Prob. de terminar en verde</span><b class="${mc.probPositive >= 0.5 ? 'up' : 'down'}">${Math.round(mc.probPositive * 100)}%</b><small>en 12 meses</small></div>
      </div>
      <div class="bt-disclaimer">Bootstrap sobre ${mc.coveredHoldings}${mc.coveredHoldings < mc.totalHoldings ? `/${mc.totalHoldings}` : ''} posiciones con historial, con los pesos actuales. Asume que el comportamiento futuro se parece al pasado reciente — puede no cumplirse. No incluye aportes ni retiros nuevos.</div>
    </div>`;
}

/* ─────────────────────── Escenarios de estrés ─────────────────────── */
const STRESS_MARKET_SHOCKS = [-5, -10, -20, -30];

/** Impacto estimado de un shock de mercado (caída del S&P) en el valor USD de
 *  la cartera, sumando por posición beta_i × peso_i × shock. Si no hay betas
 *  por activo (falta SPY), cae al beta de cartera. */
function marketShockImpact(stats, risk, shockPct) {
  const betas = risk?.assetBetas;
  if (betas?.length) {
    let deltaFrac = 0;
    for (const a of betas) if (a.beta != null) deltaFrac += a.weight * a.beta * (shockPct / 100);
    return deltaFrac;
  }
  if (risk?.beta != null) return risk.beta * (shockPct / 100);
  return null;
}

function stressScenarios(stats, risk) {
  const out = [];
  const start = stats.totalValue;
  const mk = (id, label, frac, note) => {
    if (frac == null) return;
    out.push({ id, label, deltaPct: frac * 100, deltaUsd: start * frac, note });
  };
  mk('mkt10', 'Mercado −10% (corrección)', marketShockImpact(stats, risk, -10), 'Vía beta real de cada posición vs S&P 500.');
  mk('mkt20', 'Mercado −20% (bear market)', marketShockImpact(stats, risk, -20), 'El doble de una corrección típica.');
  // Cripto −30%
  const cryptoW = stats.rows.filter(isCryptoPos).reduce((s, r) => s + (r.weight ?? 0), 0);
  if (cryptoW > 0) mk('crypto30', 'Cripto −30%', -0.30 * cryptoW, `${Math.round(cryptoW * 100)}% de tu cartera es cripto o relacionado.`);
  // Mayor posición −15%
  if (stats.topHolding?.weight) mk('top15', `${stats.topHolding.ticker} −15%`, -0.15 * stats.topHolding.weight, `Tu mayor posición pesa ${Math.round(stats.topHolding.weight * 100)}%.`);
  return { start, scenarios: out, hasBetas: !!(risk?.assetBetas?.length) };
}

function stressTestCardHTML(stats, risk) {
  const st = stressScenarios(stats, risk);
  if (!st.scenarios.length && !st.hasBetas) return '';
  const start = stats.totalValue;
  const shock = portState.stressShock;
  const customFrac = shock != null ? marketShockImpact(stats, risk, shock) : null;
  return `
    <div class="card port-notes-card stress-card">
      <div class="dash-radar-title">Escenarios de estrés</div>
      <div class="mc-intro">Cuánto valdría tu cartera hoy si pasara cada shock, estimado con la sensibilidad real (beta) de cada posición. Un simulacro, no un pronóstico.</div>
      <div class="stress-grid">
        ${st.scenarios.map(s => `
          <div class="stress-cell ${s.deltaPct >= 0 ? 'pos' : ''}">
            <div class="stress-cell-label">${esc(s.label)}</div>
            <div class="stress-cell-delta ${s.deltaPct >= 0 ? 'up' : 'down'}">${s.deltaPct >= 0 ? '+' : ''}${s.deltaPct.toFixed(1)}%</div>
            <div class="stress-cell-abs">${pv(fmtUsd(start + s.deltaUsd))} <span class="port-pnl-abs">(${s.deltaUsd >= 0 ? '+' : '−'}${pv(fmtUsd(Math.abs(s.deltaUsd)))})</span></div>
            <div class="stress-cell-note">${esc(s.note)}</div>
          </div>`).join('')}
      </div>
      ${st.hasBetas ? `
      <div class="stress-custom">
        <div class="stress-custom-label">Probá tu propio shock de mercado:</div>
        <div class="stress-shock-btns">
          ${STRESS_MARKET_SHOCKS.map(sh => `<button class="stress-shock-btn ${shock === sh ? 'active' : ''}" data-stress-shock="${sh}">S&amp;P ${sh}%</button>`).join('')}
          ${shock != null ? `<button class="stress-shock-btn stress-clear" data-stress-shock="clear">✕</button>` : ''}
        </div>
        ${customFrac != null ? `
          <div class="stress-custom-result">
            Con el S&amp;P <b>${shock}%</b>, tu cartera pasaría a <b>${pv(fmtUsd(start * (1 + customFrac)))}</b>
            <span class="stress-cell-delta ${customFrac >= 0 ? 'up' : 'down'}" style="display:inline-block;">${customFrac >= 0 ? '+' : ''}${(customFrac * 100).toFixed(1)}%</span>
            <span class="port-pnl-abs">(${customFrac >= 0 ? '+' : '−'}${pv(fmtUsd(Math.abs(start * customFrac)))})</span>
          </div>` : ''}
      </div>` : `<div class="bt-disclaimer">El shock de mercado por beta necesita historial de SPY — se calcula apenas cargue.</div>`}
    </div>`;
}

/* ═══════════════════ MOTOR DE RECOMENDACIONES PROFESIONALES ═══════════════
 * Cinco capas de análisis de alta confianza, todas sobre los cierres reales
 * ya pedidos por cada posición (sin requests extra):
 *   1. Optimizador de cartera (Min-Varianza / Paridad de Riesgo / Igual Peso)
 *      con inversión real de la matriz de covarianza y deltas concretos.
 *   2. Plan de acción priorizado con niveles de confianza.
 *   3. Score de convicción por posición (0-100).
 *   4. Mapa de correlaciones (heatmap).
 *   5. Amplitud (breadth) y momentum de la cartera.
 * ─────────────────────────────────────────────────────────────────────────── */
const PORT_OPT_MIN_DAYS = 60;

/** Inversa de una matriz cuadrada por Gauss-Jordan con pivoteo parcial.
 *  Devuelve null si es singular (no invertible). Para n≤25 es instantáneo. */
function matInverse(A) {
  const n = A.length;
  const M = A.map((row, i) => [...row, ...Array.from({ length: n }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (Math.abs(M[piv][col]) < 1e-12) return null;
    [M[col], M[piv]] = [M[piv], M[col]];
    const d = M[col][col];
    for (let j = 0; j < 2 * n; j++) M[col][j] /= d;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = M[r][col];
      if (f !== 0) for (let j = 0; j < 2 * n; j++) M[r][j] -= f * M[col][j];
    }
  }
  return M.map(row => row.slice(n));
}

/** Optimizador de cartera: sobre los retornos diarios reales de las posiciones
 *  con historial, calcula la matriz de covarianza y propone tres carteras
 *  objetivo bien fundadas — todas independientes de estimar el retorno futuro
 *  (el eslabón más frágil de la optimización clásica), por eso son robustas:
 *    • Min-Varianza: los pesos que MINIMIZAN la volatilidad total (Σ⁻¹1
 *      normalizado, con recorte long-only).
 *    • Paridad de Riesgo: cada posición aporta un riesgo parecido (∝ 1/vol).
 *    • Igual Peso: 1/N, el benchmark diversificado difícil de batir.
 *  Devuelve, para cada objetivo, la volatilidad anualizada proyectada y los
 *  pesos, para comparar contra tu cartera actual. */
function portfolioOptimizer(stats) {
  const elig = stats.rows.filter(r => r.d?.closes?.length >= PORT_OPT_MIN_DAYS && r.weight != null && r.value != null && r.value > 0);
  if (elig.length < 2) return null;
  const minLen = Math.min(...elig.map(r => r.d.closes.length));
  const rets = elig.map(r => {
    const c = r.d.closes.slice(-minLen), o = [];
    for (let i = 1; i < c.length; i++) o.push((c[i] - c[i - 1]) / c[i - 1]);
    return o;
  });
  const m = rets.length, T = rets[0].length;
  if (T < 30) return null;
  const mean = rets.map(a => a.reduce((x, y) => x + y, 0) / a.length);
  const cov = (i, j) => { let c = 0; for (let t = 0; t < T; t++) c += (rets[i][t] - mean[i]) * (rets[j][t] - mean[j]); return c / (T - 1); };
  const Sigma = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => cov(i, j)));
  const vol = mean.map((_, i) => Math.sqrt(Math.max(0, Sigma[i][i])));

  const eligSubtotal = elig.reduce((s, r) => s + r.value, 0);
  const curW = elig.map(r => r.value / eligSubtotal);
  const clampNorm = (w) => { const c = w.map(x => Math.max(0, x)); const s = c.reduce((a, b) => a + b, 0); return s > 0 ? c.map(x => x / s) : elig.map(() => 1 / m); };

  const inv = matInverse(Sigma);
  let minVar = null;
  if (inv) { const raw = inv.map(row => row.reduce((s, v) => s + v, 0)); minVar = clampNorm(raw); }
  const invVol = vol.map(v => (v > 0 ? 1 / v : 0)); const sInv = invVol.reduce((a, b) => a + b, 0);
  const riskParity = sInv > 0 ? invVol.map(x => x / sInv) : null;
  const equal = elig.map(() => 1 / m);

  const annVol = (w) => { let v = 0; for (let i = 0; i < m; i++) for (let j = 0; j < m; j++) v += w[i] * w[j] * Sigma[i][j]; return Math.sqrt(Math.max(0, v)) * Math.sqrt(TRADING_DAYS_YEAR); };
  const annRet = (w) => Math.pow(1 + w.reduce((s, x, i) => s + x * mean[i], 0), TRADING_DAYS_YEAR) - 1;
  const pack = (w) => (w ? { weights: w, vol: annVol(w), ret: annRet(w) } : null);

  return {
    tickers: elig.map(r => r.ticker), days: minLen, coverage: elig.length, totalHoldings: stats.rows.length,
    eligValues: elig.map(r => r.value), eligSubtotal,
    current: pack(curW),
    targets: { minvar: pack(minVar), riskparity: pack(riskParity), equal: pack(equal) },
  };
}

const PORT_OPT_MODES = [
  { key: 'minvar', label: 'Mínima Varianza', desc: 'Los pesos que minimizan la volatilidad total de la cartera.' },
  { key: 'riskparity', label: 'Paridad de Riesgo', desc: 'Cada posición aporta un riesgo parecido (peso ∝ 1/volatilidad).' },
  { key: 'equal', label: 'Igual Peso', desc: '1/N — el benchmark diversificado, difícil de batir.' },
];

function optimizerCardHTML(stats) {
  const opt = portfolioOptimizer(stats);
  if (!opt) return `
    <div class="card port-notes-card">
      <div class="dash-radar-title">Optimizador de cartera</div>
      <div class="dash-loading-note">Hace falta al menos 2 posiciones con ~60 ruedas de historial para optimizar los pesos — probá de nuevo en un momento.</div>
    </div>`;
  const mode = PORT_OPT_MODES.find(mm => mm.key === portState.optMode) ?? PORT_OPT_MODES[0];
  const tgt = opt.targets[mode.key];
  const cur = opt.current;
  if (!tgt) return '';
  const rows = opt.tickers.map((t, i) => {
    const curPct = cur.weights[i], tgtPct = tgt.weights[i];
    const deltaPct = tgtPct - curPct;
    const deltaUsd = deltaPct * opt.eligSubtotal;
    return { t, curPct, tgtPct, deltaPct, deltaUsd };
  }).sort((a, b) => Math.abs(b.deltaPct) - Math.abs(a.deltaPct));
  const volDelta = tgt.vol - cur.vol;
  return `
    <div class="card port-notes-card opt-card">
      <div class="dash-radar-title">Optimizador de cartera</div>
      <div class="mc-intro">Pesos objetivo calculados sobre la covarianza real de tus ${opt.coverage} posiciones con historial. Elegí un criterio y mirá qué ajustaría — con montos concretos. No es una orden: es la cartera "de manual" para ese objetivo, para que la compares con la tuya.</div>
      <div class="opt-mode-btns">
        ${PORT_OPT_MODES.map(mm => `<button class="opt-mode-btn ${portState.optMode === mm.key ? 'active' : ''}" data-opt-mode="${mm.key}">${esc(mm.label)}</button>`).join('')}
      </div>
      <div class="opt-desc">${esc(mode.desc)}</div>
      <div class="opt-proj">
        <div class="opt-proj-cell"><span>Volatilidad actual</span><b>${(cur.vol * 100).toFixed(1)}%</b></div>
        <div class="opt-proj-arrow">→</div>
        <div class="opt-proj-cell"><span>Volatilidad objetivo</span><b class="${volDelta <= 0 ? 'up' : 'down'}">${(tgt.vol * 100).toFixed(1)}%</b></div>
        <div class="opt-proj-cell opt-proj-delta"><span>Cambio de riesgo</span><b class="${volDelta <= 0 ? 'up' : 'down'}">${volDelta <= 0 ? '' : '+'}${(volDelta * 100).toFixed(1)} pts</b></div>
      </div>
      <div class="port-table-wrap">
        <table class="port-table opt-table">
          <thead><tr><th>Activo</th><th>Peso actual</th><th>Peso objetivo</th><th>Ajuste</th><th>Acción aprox.</th></tr></thead>
          <tbody>
            ${rows.map(r => {
              const act = Math.abs(r.deltaPct) < 0.02 ? '<span class="opt-hold">mantener</span>'
                : r.deltaPct > 0 ? `<span class="up">comprar ${pv(fmtUsd(Math.abs(r.deltaUsd)))}</span>`
                : `<span class="down">vender ${pv(fmtUsd(Math.abs(r.deltaUsd)))}</span>`;
              return `<tr>
                <td class="port-ticker-cell">${esc(r.t)}</td>
                <td>${Math.round(r.curPct * 100)}%</td>
                <td><b>${Math.round(r.tgtPct * 100)}%</b></td>
                <td class="${r.deltaPct >= 0 ? 'up' : 'down'}">${r.deltaPct >= 0 ? '+' : ''}${Math.round(r.deltaPct * 100)} pts</td>
                <td>${act}</td>
              </tr>`;
            }).join('')}
          </tbody>
        </table>
      </div>
      <div class="bt-disclaimer">Optimización long-only sobre ${opt.coverage}${opt.coverage < opt.totalHoldings ? `/${opt.totalHoldings}` : ''} posiciones (las que tienen historial), con ${opt.days} ruedas. La volatilidad proyectada es robusta; deliberadamente NO optimizamos por retorno esperado (estimarlo a futuro es poco confiable y suele concentrar de más). Los montos son orientativos y no incluyen comisiones ni impacto fiscal.</div>
    </div>`;
}

/** Convicción por posición (0-100): qué tan alineadas están las señales reales
 *  para ESA tenencia, combinando score del motor, estructura de tendencia,
 *  momentum de 20 ruedas, régimen de RSI, distancia al stop y alertas activas.
 *  Es la base de la "alta confianza": una reco pesa más cuando la convicción
 *  la respalda. */
function positionConviction(r) {
  const d = r.d;
  if (!d) return null;
  let score = (d.score != null ? d.score : 50) * 0.45;
  const factors = [];
  if (d.structure?.bullish === true) { score += 12; factors.push({ good: true, t: 'Estructura de tendencia alcista' }); }
  else if (d.structure?.bullish === false) { score -= 8; factors.push({ good: false, t: 'Estructura de tendencia bajista' }); }
  const c = d.closes;
  if (c?.length >= 21) {
    const mom = (c[c.length - 1] - c[c.length - 21]) / c[c.length - 21];
    if (mom > 0.03) { score += 10; factors.push({ good: true, t: `Momentum +${(mom * 100).toFixed(0)}% (20 ruedas)` }); }
    else if (mom < -0.03) { score -= 8; factors.push({ good: false, t: `Momentum ${(mom * 100).toFixed(0)}% (20 ruedas)` }); }
  }
  if (d.rsi != null) {
    if (d.rsi >= 45 && d.rsi <= 65) { score += 6; factors.push({ good: true, t: 'RSI en zona sana' }); }
    else if (d.rsi > 70) { score -= 6; factors.push({ good: false, t: `RSI sobrecomprado (${d.rsi.toFixed(0)})` }); }
    else if (d.rsi < 30) { score += 3; factors.push({ good: true, t: `RSI sobrevendido (${d.rsi.toFixed(0)}) — posible rebote` }); }
  }
  const pr = d.planRaw;
  if (pr?.stopLoss != null && d.price > 0) {
    const dist = ((d.price - pr.stopLoss) / d.price) * 100;
    if (dist <= 3) { score -= 12; factors.push({ good: false, t: 'Precio pegado al stop' }); }
    else if (dist >= 12) { score += 4; }
  }
  if (d.alert && !d.alert.pending) {
    if (d.alert.type === 'buy') { score += 6; factors.push({ good: true, t: 'Alerta de zona de compra' }); }
    else if (d.alert.type === 'sell' || d.alert.type === 'stop') { score -= 8; factors.push({ good: false, t: 'Alerta de venta / stop' }); }
  }
  score = Math.max(0, Math.min(100, Math.round(score)));
  const verdict = score >= 68 ? 'alta' : score >= 48 ? 'media' : 'baja';
  return { score, verdict, factors: factors.slice(0, 3) };
}

function convictionCardHTML(stats) {
  const rows = stats.rows.filter(r => r.d).map(r => ({ r, conv: positionConviction(r) })).filter(x => x.conv);
  if (!rows.length) return '';
  rows.sort((a, b) => b.conv.score - a.conv.score);
  const col = (v) => v === 'alta' ? GREEN : v === 'media' ? AMBER : RED;
  return `
    <div class="card port-notes-card conv-card">
      <div class="dash-radar-title">Convicción por posición</div>
      <div class="mc-intro">Qué tan alineadas están HOY las señales de cada tenencia (score del motor + tendencia + momentum + RSI + distancia al stop + alertas). Cuanto más alta, más respaldo tiene la recomendación de esa posición.</div>
      ${rows.map(({ r, conv }) => `
        <div class="conv-row">
          <div class="conv-ticker">${esc(r.ticker)}</div>
          <div class="conv-bar-wrap">
            <div class="conv-bar" style="width:${conv.score}%; background:${col(conv.verdict)};"></div>
          </div>
          <div class="conv-score" style="color:${col(conv.verdict)};">${conv.score}<small>conv. ${esc(conv.verdict)}</small></div>
          <div class="conv-factors">${conv.factors.map(f => `<span class="conv-chip ${f.good ? 'good' : 'bad'}">${f.good ? '✓' : '✕'} ${esc(f.t)}</span>`).join('') || '<span class="conv-chip">sin señales fuertes</span>'}</div>
        </div>`).join('')}
    </div>`;
}

/** Plan de acción unificado y priorizado: junta TODAS las señales (por posición
 *  y de cartera) en una sola lista rankeada por urgencia, cada una con un nivel
 *  de confianza. Es el "qué hago hoy" concreto — la respuesta directa a
 *  recomendaciones de alta confianza. */
function portfolioActionPlan(stats, risk) {
  const items = [];
  for (const r of stats.rows) {
    if (!r.d) continue;
    const conv = positionConviction(r);
    const near = r.d.planRaw?.stopLoss != null && r.d.price > 0 && ((r.d.price - r.d.planRaw.stopLoss) / r.d.price) * 100 <= 3;
    const g = r.gainPct;
    if (r.d.scoreLabel === 'Venta') items.push({ pri: 1, ticker: r.ticker, action: g != null && g < 0 ? 'Cortar pérdida' : 'Vender', conf: 'alta', why: near ? 'Señal de Venta del motor y a ≤3% del stop.' : 'Señal de Venta del motor.' });
    else if (near) items.push({ pri: 1, ticker: r.ticker, action: 'Decidir el stop', conf: 'alta', why: 'El precio está a ≤3% del stop sugerido — decisión inminente.' });
    else if (r.d.scoreLabel === 'Reducir') items.push({ pri: 2, ticker: r.ticker, action: g != null && g > 0 ? 'Tomar ganancias parciales' : 'Reducir exposición', conf: conv?.verdict === 'baja' ? 'alta' : 'media', why: 'La señal se debilitó (Reducir).' });
    else if (r.d.scoreLabel === 'Compra Fuerte' && conv?.verdict === 'alta') items.push({ pri: 3, ticker: r.ticker, action: g != null && g < 0 ? 'Promediar a la baja' : 'Sumar posición', conf: 'alta', why: `Compra Fuerte con convicción alta (${conv.score}/100).` });
    else if (r.d.scoreLabel === 'Compra Moderada' && conv && conv.verdict !== 'baja') items.push({ pri: 4, ticker: r.ticker, action: 'Sumar selectivo', conf: 'media', why: `Compra moderada con convicción ${conv.verdict} (${conv.score}/100).` });
  }
  if (stats.topHolding && (stats.topHolding.weight ?? 0) >= 0.35) items.push({ pri: 2, ticker: stats.topHolding.ticker, action: 'Bajar el peso', conf: 'alta', why: `Concentración del ${Math.round(stats.topHolding.weight * 100)}% en un solo activo.` });
  if (stats.sectorRows[0]?.pct >= 0.5) items.push({ pri: 3, ticker: stats.sectorRows[0].sector, action: 'Diversificar el sector', conf: 'alta', why: `${Math.round(stats.sectorRows[0].pct * 100)}% de la cartera en ${stats.sectorRows[0].sector}.` });
  if (risk?.overlaps?.length) { const o = risk.overlaps[0]; items.push({ pri: 5, ticker: `${o.a} / ${o.b}`, action: 'Revisar solapamiento', conf: 'media', why: `Se mueven casi igual (correlación ${o.corr.toFixed(2)}) — poca diversificación entre ambos.` }); }
  items.sort((a, b) => a.pri - b.pri || (a.conf === 'alta' ? -1 : 1));
  return items;
}

const CONF_COLOR = { alta: GREEN, media: AMBER, baja: RED };
function actionPlanCardHTML(stats, risk) {
  const items = portfolioActionPlan(stats, risk);
  return `
    <div class="card port-notes-card action-plan-card">
      <div class="dash-radar-title">Plan de acción priorizado</div>
      <div class="mc-intro">Todo lo accionable de tu cartera hoy, ordenado por urgencia y con un nivel de confianza en cada punto. Cruza las señales del motor con la convicción, la concentración y los solapamientos — no es asesoramiento financiero.</div>
      ${!items.length ? `<div class="port-note ok">✓ No hay acciones urgentes: ninguna posición disparó una señal fuerte de compra o venta, ni hay riesgos de concentración críticos. Seguí el monitoreo habitual.</div>` : `
      <ol class="action-plan-list">
        ${items.map(it => `
          <li class="action-plan-item">
            <span class="action-conf" style="background:${CONF_COLOR[it.conf]}22; color:${CONF_COLOR[it.conf]};">${esc(it.conf)}</span>
            <span class="action-body"><b>${esc(it.action)} — ${esc(it.ticker)}.</b> ${esc(it.why)}</span>
          </li>`).join('')}
      </ol>`}
    </div>`;
}

/** Amplitud (breadth) y momentum de la cartera: qué proporción de tus
 *  posiciones está "bien" por dentro (en señal de compra, sobre su media de
 *  50 ruedas, con momentum positivo) y el RSI promedio. Una cartera puede
 *  estar en verde pero con amplitud débil (sube por pocas posiciones) — esto
 *  lo hace visible. */
function portfolioBreadth(stats) {
  const rows = stats.rows.filter(r => r.d);
  if (!rows.length) return null;
  let buy = 0, aboveMA = 0, posMom = 0, rsiSum = 0, rsiN = 0, maN = 0, momN = 0;
  for (const r of rows) {
    const d = r.d;
    if (d.scoreLabel === 'Compra Fuerte' || d.scoreLabel === 'Compra Moderada') buy++;
    const c = d.closes;
    if (c?.length >= 50) { const ma = c.slice(-50).reduce((a, b) => a + b, 0) / 50; if (c[c.length - 1] > ma) aboveMA++; maN++; }
    if (c?.length >= 21) { const mom = (c[c.length - 1] - c[c.length - 21]) / c[c.length - 21]; if (mom > 0) posMom++; momN++; }
    if (d.rsi != null) { rsiSum += d.rsi; rsiN++; }
  }
  return {
    count: rows.length,
    buyPct: buy / rows.length,
    aboveMAPct: maN ? aboveMA / maN : null, maN,
    posMomPct: momN ? posMom / momN : null, momN,
    avgRsi: rsiN ? rsiSum / rsiN : null,
  };
}

function breadthCardHTML(stats) {
  const b = portfolioBreadth(stats);
  if (!b) return '';
  const gauge = (label, frac, note) => {
    if (frac == null) return '';
    const pct = Math.round(frac * 100);
    const col = frac >= 0.6 ? GREEN : frac >= 0.4 ? AMBER : RED;
    return `
      <div class="breadth-cell">
        <div class="breadth-ring" style="background:conic-gradient(${col} ${pct * 3.6}deg, var(--surface-2, rgba(255,255,255,0.06)) 0deg);">
          <div class="breadth-ring-inner">${pct}%</div>
        </div>
        <div class="breadth-label">${esc(label)}</div>
        <div class="breadth-note">${esc(note)}</div>
      </div>`;
  };
  const rsiTxt = b.avgRsi != null ? `RSI prom. ${b.avgRsi.toFixed(0)}` : '';
  return `
    <div class="card port-notes-card breadth-card">
      <div class="dash-radar-title">Amplitud & momentum de la cartera ${rsiTxt ? `<span class="risk-days-note">— ${rsiTxt}</span>` : ''}</div>
      <div class="mc-intro">Qué proporción de tus posiciones está fuerte por dentro. Una cartera sana sube con amplitud (muchas posiciones acompañando), no apoyada en una o dos.</div>
      <div class="breadth-grid">
        ${gauge('En señal de compra', b.buyPct, `${Math.round(b.buyPct * b.count)} de ${b.count} posiciones`)}
        ${gauge('Sobre su media de 50 ruedas', b.aboveMAPct, `${b.maN} con historial`)}
        ${gauge('Con momentum positivo (20d)', b.posMomPct, `${b.momN} con historial`)}
      </div>
    </div>`;
}

function corrMatrixCardHTML(risk) {
  const cm = risk?.corrMatrix;
  if (!cm) return '';
  const colorFor = (v) => {
    if (v == null) return 'var(--surface-2, rgba(255,255,255,0.05))';
    if (v >= 0.8) return 'oklch(0.70 0.21 23 / 0.55)';
    if (v >= 0.5) return 'oklch(0.75 0.15 70 / 0.45)';
    if (v >= 0.2) return 'oklch(0.75 0.13 120 / 0.30)';
    if (v >= -0.2) return 'var(--surface-2, rgba(255,255,255,0.06))';
    return 'oklch(0.72 0.15 250 / 0.40)';
  };
  return `
    <div class="card port-notes-card corr-card">
      <div class="dash-radar-title">Mapa de correlaciones</div>
      <div class="mc-intro">Cuánto se mueven juntas tus posiciones (últimas ${risk.days} ruedas). Rojo = casi idénticas (poca diversificación real entre ellas); azul = se mueven en sentidos opuestos (se cubren). Lo ideal para diversificar es tener varios pares en el medio o azules.</div>
      <div class="corr-matrix-scroll">
        <table class="corr-matrix-table port-corr-table">
          <thead><tr><th></th>${cm.tickers.map(t => `<th>${esc(t)}</th>`).join('')}</tr></thead>
          <tbody>
            ${cm.tickers.map((t, i) => `
              <tr>
                <th>${esc(t)}</th>
                ${cm.tickers.map((_, j) => {
                  const v = cm.m[i][j];
                  return `<td style="background:${colorFor(v)};" title="${esc(t)} vs ${esc(cm.tickers[j])}: ${v == null ? 'sin dato' : v.toFixed(2)}">${i === j ? '—' : (v == null ? '·' : v.toFixed(1))}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>`;
}

function portfolioHTML() {
  const holdings = getPortfolio();
  const stats = holdings.length ? computePortfolioStats(holdings) : null;
  const risk = stats ? computePortfolioRiskMetrics(stats.rows, portState.macro, portState.spy) : null;
  const health = stats ? computePortfolioHealth(stats, risk) : null;
  const notes = stats ? portfolioRiskNotes(stats, risk) : [];
  const recoHist = stats ? trackRecoChanges(stats.rows) : [];
  const copilot = stats ? portfolioCopilot(stats, risk, health) : null;
  const mc = stats ? monteCarloProjection(stats, risk) : null;
  const loadingCount = holdings.filter(h => !portState.data[h.ticker]).length;
  const editingHolding = portState.editing ? holdings.find(h => h.ticker === portState.editing) : null;
  const tab = portState.tab;

  return `
    ${sectionTitleHTML('Portfolio Advisor', 'briefcase')}
    <div class="dash-intro">Cargá tus tenencias (ticker, cantidad, costo promedio y fecha de compra, todo opcional salvo ticker y cantidad) para ver diversificación, concentración y señal de cada posición con datos reales. Si compraste CEDEARs en pesos, elegí "ARS (CEDEAR)": ahí la <strong>cantidad son CEDEARs</strong> y el P&amp;L se compara contra el precio del CEDEAR en pesos; con costo en USD, la <strong>cantidad son acciones del subyacente</strong>. Cargar la fecha de compra habilita el retorno REAL (ajustado por IPC) y los benchmarks vs. CCL. Se guarda solo en este navegador.</div>

    <div class="card port-form-card">
      ${editingHolding ? `<div class="port-editing-banner">Editando ${esc(editingHolding.ticker)} — <a href="#" id="port-edit-cancel">cancelar</a></div>` : ''}
      <div class="port-form">
        <input list="port-ticker-list" id="port-ticker" class="port-input" placeholder="Ticker (ej. AAPL)" aria-label="Ticker del activo" autocomplete="off" style="text-transform:uppercase;" value="${editingHolding ? esc(editingHolding.ticker) : ''}" ${editingHolding ? 'readonly' : ''} />
        <datalist id="port-ticker-list">${universe.map(a => `<option value="${esc(a.ticker)}">${esc(a.name)}</option>`).join('')}</datalist>
        <input type="number" id="port-shares" class="port-input" placeholder="Cantidad" aria-label="Cantidad de unidades" min="0" step="any" value="${editingHolding ? editingHolding.shares : ''}" />
        <input type="number" id="port-cost" class="port-input" placeholder="Costo promedio (opcional)" aria-label="Costo promedio de compra (opcional)" min="0" step="any" value="${editingHolding?.avgCost ?? ''}" />
        <select id="port-currency" class="port-input" aria-label="Moneda del costo">
          <option value="USD" ${!editingHolding || editingHolding.costCurrency !== 'ARS' ? 'selected' : ''}>USD (acción/activo subyacente)</option>
          <option value="ARS" ${editingHolding?.costCurrency === 'ARS' ? 'selected' : ''}>ARS (CEDEAR en pesos)</option>
        </select>
        <input type="date" id="port-date" class="port-input" aria-label="Fecha de compra (opcional)" title="Fecha de compra (opcional) — habilita el retorno real ajustado por inflación" max="${new Date().toISOString().slice(0, 10)}" value="${editingHolding?.purchaseDate ?? ''}" />
        <button class="port-add-btn" id="port-add">${editingHolding ? 'Actualizar' : 'Agregar'}</button>
      </div>
    </div>

    <div class="port-table-controls">
      <button class="port-csv-btn" id="port-export">Exportar CSV</button>
      <button class="port-csv-btn" id="port-import">Importar CSV</button>
      <input type="file" id="port-import-file" accept=".csv,text/csv" style="display:none;" aria-label="Seleccionar archivo CSV de tenencias" />
      <button class="port-csv-btn" id="port-compact-toggle" aria-pressed="${portState.compact}">${portState.compact ? 'Vista completa' : 'Vista compacta'}</button>
      <button class="port-csv-btn" id="port-privacy-toggle" aria-pressed="${portState.privacy}" title="Oculta los montos absolutos (los porcentajes siguen visibles) para mostrar la pantalla sin exponer cuánto tenés">${portState.privacy ? '👁 Mostrar montos' : '🙈 Ocultar montos'}</button>
    </div>

    ${!holdings.length ? emptyStateHTML('briefcase', `Todavía no cargaste tenencias (máx. ${PORTFOLIO_MAX}). Podés empezar cargando una a la vez arriba, o importar un CSV (columnas: ticker,shares,avgCost,costCurrency).`) : `
    <div class="port-summary-grid">
      <div class="card port-summary-card">
        <div class="dash-radar-title">Valor total</div>
        <div class="port-summary-value">${pv(fmtUsd(stats.totalValue))}</div>
        ${stats.totalValueArs != null ? `<div class="port-summary-sub" title="${stats.arsEligibleCount === stats.rows.length ? 'Suma de todas las posiciones, a la última cotización real del CEDEAR' : `Solo ${stats.arsEligibleCount} de ${stats.rows.length} posiciones tienen CEDEAR — no incluye cripto ni activos sin ratio ARS`}">${pv(fmtArs(stats.totalValueArs))}${stats.arsEligibleCount < stats.rows.length ? ' (posiciones con CEDEAR)' : ''}</div>` : ''}
        ${stats.totalGainUsd != null ? `<div class="port-summary-sub ${stats.totalGainUsd >= 0 ? 'up' : 'down'}">${stats.totalGainUsd >= 0 ? '+' : ''}${pv(fmtUsd(stats.totalGainUsd))} (${fmtPct(stats.totalCostUsd > 0 ? (stats.totalGainUsd / stats.totalCostUsd) * 100 : 0)}) en posiciones con costo en USD</div>` : ''}
        ${stats.totalGainArs != null ? `<div class="port-summary-sub ${stats.totalGainArs >= 0 ? 'up' : 'down'}">${stats.totalGainArs >= 0 ? '+' : ''}${pv(fmtArs(stats.totalGainArs))} (${fmtPct(stats.totalCostArs > 0 ? (stats.totalGainArs / stats.totalCostArs) * 100 : 0)}) en posiciones con costo en ARS</div>` : ''}
        ${stats.totalRealGainArs != null ? `<div class="port-summary-sub port-real-sub ${stats.totalRealGainArs >= 0 ? 'up' : 'down'}">retorno real: ${fmtPct(stats.totalRealCostArs > 0 ? (stats.totalRealGainArs / stats.totalRealCostArs) * 100 : 0)} ajustado por inflación (IPC)</div>` : ''}
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

    <div class="port-tabs" role="tablist">
      ${PORT_TABS.map(t => `<button class="port-tab ${tab === t.key ? 'active' : ''}" data-port-tab="${t.key}" role="tab" aria-selected="${tab === t.key}">${ICONS[t.icon]}<span>${esc(t.label)}</span></button>`).join('')}
    </div>

    ${tab === 'resumen' ? `
      ${portfolioCopilotCardHTML(copilot, health)}
      ${actionPlanCardHTML(stats, risk)}
      ${breadthCardHTML(stats)}
      ${portfolioTreemapSVG(stats.rows)}
      ${portfolioHealthCardHTML(health)}
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
    ` : ''}

    ${tab === 'riesgo' ? `
      ${riskMetricsCardHTML(risk, holdings.length)}
      ${monteCarloCardHTML(mc)}
      ${stressTestCardHTML(stats, risk)}
      ${riskContributionCardHTML(risk)}
      ${corrMatrixCardHTML(risk)}
      ${benchmarksCardHTML(stats)}
    ` : ''}

    ${tab === 'operar' ? `
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
      ${convictionCardHTML(stats)}
      ${optimizerCardHTML(stats)}
      ${rebalanceCardHTML(stats)}
      ${allocatorCardHTML(stats)}
      ${taxImpactCardHTML(stats.totalValue, portState.ccl)}
      ${portfolioDividendsCardHTML(stats)}
      ${opsCardHTML(stats)}
      ${recoHistoryCardHTML(recoHist)}
    ` : ''}

    ${tab === 'tenencias' ? `
      <div class="port-table-controls">
        <select class="watch-select" id="port-sort" aria-label="Ordenar tenencias por">
          ${PORT_SORT_OPTIONS.map(o => `<option value="${o.key}" ${portState.sortBy === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
      </div>
      <div class="port-table-wrap">
        <table class="port-table">
          <thead><tr>${portState.compact
            ? '<th>Ticker</th><th>Valor</th><th>P&amp;L</th><th>Señal</th><th>Recomendación</th><th></th>'
            : '<th>Ticker</th><th>Cantidad</th><th>Precio</th><th>Valor</th><th>Peso</th><th>P&amp;L</th><th>Stop / Objetivo</th><th>Señal</th><th>Recomendación</th><th></th>'}</tr></thead>
          <tbody>
            ${sortPortfolioRows(stats.rows).map(r => portfolioRowHTML(r)).join('')}
          </tbody>
          ${portfolioTotalsRowHTML(stats)}
        </table>
      </div>
    ` : ''}`}
  `;
}

function portfolioTotalsRowHTML(stats) {
  const pnlParts = [
    stats.totalGainUsd != null ? `<span class="${stats.totalGainUsd >= 0 ? 'up' : 'down'}">${stats.totalGainUsd >= 0 ? '+' : ''}${pv(fmtUsd(stats.totalGainUsd))}</span>` : '',
    stats.totalGainArs != null ? `<span class="${stats.totalGainArs >= 0 ? 'up' : 'down'}">${stats.totalGainArs >= 0 ? '+' : ''}${pv(fmtArs(stats.totalGainArs))}</span>` : '',
  ].filter(Boolean).join('<br>') || '—';
  const valueCell = `${pv(fmtUsd(stats.totalValue))}${stats.totalValueArs != null ? `<br><span class="port-pnl-abs">${pv(fmtArs(stats.totalValueArs))}</span>` : ''}`;
  return `<tfoot><tr class="port-totals-row">
    ${portState.compact
      ? `<td>TOTAL</td><td>${valueCell}</td><td>${pnlParts}</td><td colspan="3"></td>`
      : `<td>TOTAL</td><td></td><td></td><td>${valueCell}</td><td>100%</td><td>${pnlParts}</td><td colspan="4"></td>`}
  </tr></tfoot>`;
}

function portfolioRowHTML(r) {
  if (!r.d) {
    const skelCols = portState.compact ? 3 : 7;
    return `<tr data-port-ticker="${esc(r.ticker)}"><td>${esc(r.ticker)}</td><td colspan="${skelCols}"><span class="skel skel-line" style="width:80%; height:10px; display:inline-block;"></span></td><td></td><td><button class="port-remove" data-port-remove="${esc(r.ticker)}" title="Quitar" aria-label="Quitar ${esc(r.ticker)} de la cartera">×</button></td></tr>`;
  }
  const sig = scoreLabelColor(r.d.scoreLabel);
  const fmtGain = r.gainCurrency === 'ARS' ? fmtArs : fmtUsd;
  let pnlCell = '—';
  if (r.gainPct != null) {
    const realLine = r.realGainPct != null
      ? `<br><span class="port-pnl-real ${r.realGainPct >= 0 ? 'up' : 'down'}" title="Ajustado por inflación (IPC Argentina) desde ${esc(r.purchaseDate)} — ${r.inflationMonths} mes(es) de datos reales">real: ${fmtPct(r.realGainPct * 100)}</span>`
      : '';
    pnlCell = `${fmtPct(r.gainPct * 100)}<br><span class="port-pnl-abs">${r.gainAbs >= 0 ? '+' : ''}${pv(fmtGain(r.gainAbs))}</span>${realLine}`;
  } else if (r.gainUnavailableReason) {
    pnlCell = `<span title="${esc(r.gainUnavailableReason)}">N/D ⓘ</span>`;
  }
  const reco = portfolioRecommendation(r);
  const recoTone = reco ? RECO_TONE[reco.tone] : null;

  // Stop sugerido y distancia al stop (Plan Operativo de este activo, en USD
  // del subyacente): en rojo cuando el precio está a ≤3% del stop — ahí la
  // decisión es inminente, no un dato de fondo.
  let stopCell = '—';
  const pr = r.d.planRaw;
  if (pr?.stopLoss != null && r.d.price > 0) {
    const distPct = ((r.d.price - pr.stopLoss) / r.d.price) * 100;
    const near = distPct <= 3;
    stopCell = `${fmtUsd(pr.stopLoss)} <span class="port-stop-dist ${near ? 'near' : ''}" title="Distancia entre el precio actual y el stop sugerido">${distPct <= 0 ? 'stop superado' : `a ${distPct.toFixed(1)}%`}</span><br><span class="port-pnl-abs">obj ${fmtUsd(pr.tp1)}</span>`;
  }

  const tickerCell = `<td class="port-ticker-cell">${esc(r.ticker)}${r.d.isReal === false ? ' <span class="watch-stale">demo</span>' : ''}${r.costCurrency === 'ARS' ? ' <span class="watch-stale">ARS</span>' : ''}${r.d.alert && !r.d.alert.pending ? `<br><span class="port-row-alert" style="color:${ALERT_META[r.d.alert.type]?.color};"${alertTitleAttr(r.d.alert)}>⚡ ${esc(ALERT_META[r.d.alert.type]?.label ?? '')}</span>` : ''}</td>`;
  const valueCell = `<td>${r.valueArs != null
    ? `${pv(fmtArs(r.valueArs))}<br><span class="port-pnl-abs">${pv(fmtUsd(r.value))}</span>`
    : (r.value != null ? pv(fmtUsd(r.value)) : 'N/D')}</td>`;
  const pnlTd = `<td class="${r.gainPct != null ? (r.gainPct >= 0 ? 'up' : 'down') : ''}">${pnlCell}</td>`;
  const signalTd = `<td><span class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(r.d.scoreLabel)} · ${r.d.score}</span></td>`;
  const recoTd = `<td>${reco ? `<span class="watch-signal" style="background:${recoTone.bg}; color:${recoTone.color};" title="${esc(reco.detail)}">${esc(reco.label)}</span>` : 'N/D'}</td>`;
  const actionsTd = `<td class="port-actions-cell">
      <button class="port-sell" data-port-sell="${esc(r.ticker)}" title="Registrar venta" aria-label="Registrar venta de ${esc(r.ticker)}">⤓</button>
      <button class="port-edit" data-port-edit="${esc(r.ticker)}" title="Editar" aria-label="Editar tenencia de ${esc(r.ticker)}">✎</button>
      <button class="port-remove" data-port-remove="${esc(r.ticker)}" title="Quitar" aria-label="Quitar ${esc(r.ticker)} de la cartera">×</button>
    </td>`;

  if (portState.compact) {
    return `<tr class="port-row" data-port-ticker="${esc(r.ticker)}">${tickerCell}${valueCell}${pnlTd}${signalTd}${recoTd}${actionsTd}</tr>`;
  }
  return `<tr class="port-row" data-port-ticker="${esc(r.ticker)}">
    ${tickerCell}
    <td>${r.shares}</td>
    <td>${r.d.cedearArs != null
      ? `${pv(fmtArs(r.d.cedearArs))} <span title="${r.d.cedearSource === 'live' ? 'Precio real operado hoy en BYMA' : 'Estimado vía CCL — sin cotización real disponible para este símbolo'}">${r.d.cedearSource === 'live' ? '●' : '≈'}</span><br><span class="port-pnl-abs">subyacente ${pv(fmtUsd(r.d.price))}</span>`
      : pv(fmtUsd(r.d.price))}</td>
    ${valueCell}
    <td>${r.weight != null ? `${Math.round(r.weight * 100)}%` : 'N/D'}</td>
    ${pnlTd}
    <td>${stopCell}</td>
    ${signalTd}
    ${recoTd}
    ${actionsTd}
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
  const cumplidorEl = document.getElementById('tax-cumplidor');
  if (cumplidorEl) cumplidorEl.addEventListener('change', () => {
    taxState.cumplidor = cumplidorEl.checked;
    lsSetSafe('icp_tax_cumplidor', taxState.cumplidor ? '1' : '0');
    renderReport();
  });
  els.report.querySelectorAll('[data-port-tab]').forEach(btn => {
    btn.addEventListener('click', () => {
      portState.tab = btn.dataset.portTab;
      renderReport();
      els.report.querySelector('.port-tabs')?.scrollIntoView({ block: 'nearest' });
    });
  });
  els.report.querySelectorAll('[data-stress-shock]').forEach(btn => {
    btn.addEventListener('click', () => {
      const v = btn.dataset.stressShock;
      portState.stressShock = v === 'clear' ? null : Number(v);
      renderReport();
    });
  });
  els.report.querySelectorAll('[data-opt-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      portState.optMode = btn.dataset.optMode;
      renderReport();
    });
  });
  els.report.querySelectorAll('[data-port-ticker]').forEach(el => {
    el.addEventListener('click', (e) => {
      if (e.target.closest('.port-remove') || e.target.closest('.port-edit') || e.target.closest('.port-sell')) return;
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
    const dateEl = document.getElementById('port-date');
    const ticker = tickerEl.value.trim().toUpperCase();
    const shares = parseFloat(sharesEl.value);
    const cost = costEl.value ? parseFloat(costEl.value) : null;
    const currency = currencyEl?.value === 'ARS' ? 'ARS' : 'USD';
    const purchaseDate = dateEl?.value || null;
    if (!ticker || !shares || shares <= 0) return;
    const wasEditing = portState.editing != null;
    // Registro de operaciones: solo el alta de una posición NUEVA con costo
    // se loguea como compra (una edición cambia el estado final, no dice qué
    // operación hubo en el medio — no se inventa).
    if (!wasEditing && !getPortfolio().some(h => h.ticker === ticker) && cost != null) {
      logPortOp({ type: 'buy', ticker, shares, price: cost, currency, realized: null });
    }
    addHolding(ticker, shares, cost, currency, purchaseDate);
    portState.editing = null;
    tickerEl.value = ''; sharesEl.value = ''; costEl.value = ''; if (dateEl) dateEl.value = '';
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
      for (const h of parsed) addHolding(h.ticker, h.shares, h.avgCost, h.costCurrency, h.purchaseDate);
      importFile.value = '';
      showToast(`${parsed.length} tenencia(s) importada(s) desde CSV`, 'success');
      renderReport();
    });
  }

  // Vista compacta / modo privacidad
  document.getElementById('port-compact-toggle')?.addEventListener('click', () => {
    portState.compact = !portState.compact;
    lsSetSafe('icp_port_compact', portState.compact ? '1' : '0');
    renderReport();
  });
  document.getElementById('port-privacy-toggle')?.addEventListener('click', () => {
    portState.privacy = !portState.privacy;
    lsSetSafe('icp_port_privacy', portState.privacy ? '1' : '0');
    renderReport();
  });

  // Asignador "¿qué compro con AR$ X?"
  const allocBtn = document.getElementById('port-alloc-run');
  const allocInput = document.getElementById('port-alloc-amount');
  if (allocBtn && allocInput) {
    const run = () => {
      portState.allocAmount = allocInput.value;
      const amount = parseFloat(allocInput.value);
      const holdingsNow = getPortfolio();
      const statsNow = holdingsNow.length ? computePortfolioStats(holdingsNow) : null;
      portState.allocResult = statsNow ? computeAllocation(amount, statsNow, portState.ccl) : null;
      renderReport();
    };
    allocBtn.addEventListener('click', run);
    allocInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') run(); });
  }

  // Registrar venta: reduce (o cierra) la posición y loguea el P&L realizado
  // contra el costo promedio cargado. Solo en este navegador.
  els.report.querySelectorAll('.port-sell').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = btn.dataset.portSell;
      const h = getPortfolio().find(x => x.ticker === ticker);
      if (!h) return;
      const qtyStr = window.prompt(`¿Cuántas unidades de ${ticker} vendiste? (tenés ${h.shares})`);
      if (qtyStr == null) return;
      const qty = parseFloat(qtyStr);
      if (!qty || qty <= 0 || qty > h.shares) { showToast('Cantidad inválida — tiene que ser mayor a 0 y no superar lo que tenés.', 'info'); return; }
      const curLabel = h.costCurrency === 'ARS' ? 'AR$ por CEDEAR' : 'US$ por unidad';
      const priceStr = window.prompt(`¿A qué precio vendiste? (${curLabel})`);
      if (priceStr == null) return;
      const price = parseFloat(priceStr);
      if (!price || price <= 0) { showToast('Precio inválido.', 'info'); return; }
      const realized = h.avgCost != null ? (price - h.avgCost) * qty : null;
      logPortOp({ type: 'sell', ticker, shares: qty, price, currency: h.costCurrency === 'ARS' ? 'ARS' : 'USD', realized });
      const left = h.shares - qty;
      if (left > 1e-9) addHolding(ticker, left, h.avgCost, h.costCurrency, h.purchaseDate);
      else { removeHolding(ticker); delete portState.data[ticker]; }
      showToast(`Venta de ${qty} ${ticker} registrada${realized != null ? ` — P&L ${realized >= 0 ? '+' : ''}${(h.costCurrency === 'ARS' ? fmtArs : fmtUsd)(realized)}` : ''}`, 'success');
      renderReport();
    });
  });
}

// Solo pide lo que todavía no tiene: renderReport() dispara esto en cada
// render mientras se está en la vista Portfolio, así que tiene que ser un
// no-op cuando no hay nada nuevo — si no, cada holding resuelto vuelve a
// llamar a renderReport(), que vuelve a llamar a esta función, en loop.
async function loadPortfolioData() {
  const holdings = getPortfolio();
  const macro = await getMacro();
  portState.macro = macro; // referencia sincrónica para computePortfolioRiskMetrics (necesita la tasa de la FED)
  if (!portState.inflacion && holdings.some(h => h.purchaseDate)) {
    try { portState.inflacion = await getInflacion(); }
    catch (e) { console.warn('[portfolio] no se pudo cargar inflación', e.message); }
  }
  if (!portState.ccl && holdings.length) {
    try { portState.ccl = await getCCL(); }
    catch (e) { console.warn('[portfolio] no se pudo cargar CCL', e.message); }
  }
  // Piezas nuevas de contexto — cada una con guarda de "una sola vez" y su
  // propio refresh, para no bloquear la carga de señales si alguna falla.
  let contextLoaded = false;
  if (!portState.spy && holdings.length) {
    try { portState.spy = (await getCandles('SPY', '1day', 220)).c; contextLoaded = true; }
    catch (e) { console.warn('[portfolio] no se pudo cargar SPY', e.message); }
  }
  if (!portState.cclHistory && holdings.some(h => h.purchaseDate)) {
    try { portState.cclHistory = await getCCLHistory(); contextLoaded = true; }
    catch (e) { console.warn('[portfolio] no se pudo cargar historial CCL', e.message); }
  }
  const needDividends = holdings.filter(h => !(h.ticker in portState.dividends));
  if (needDividends.length) {
    await Promise.all(needDividends.map(async (h) => {
      try { portState.dividends[h.ticker] = await getDividends(h.ticker); }
      catch (e) { portState.dividends[h.ticker] = { items: [] }; }
    }));
    contextLoaded = true;
  }
  // Aviso de ex-dividend próximo por cada tenencia (una sola vez por fecha).
  for (const h of holdings) notifyExDividend(h.ticker, portState.dividends[h.ticker]);
  syncPortfolioToTelegram(); // fire-and-forget: alimenta el resumen diario del bot

  const missing = holdings.filter(h => !portState.data[h.ticker] && !portState.loading.has(h.ticker));
  if (!missing.length) {
    if (contextLoaded && !state.asset && state.view === 'portfolio') renderReport();
    return;
  }
  await Promise.all(missing.map(async (h) => {
    portState.loading.add(h.ticker);
    try {
      const signal = await computeLightSignal(h.ticker, macro);
      portState.data[h.ticker] = signal;
      // Alertas sobre TU plata: mismas notificaciones de transición que la
      // Watchlist, pero para las tenencias — el mapa de estado compartido
      // (lastAlertByTicker) evita avisos duplicados si el ticker está en ambas.
      notifyIfNewAlert(h.ticker, signal.alert);
      notifyStructureChange(h.ticker, signal.structure);
    } catch (e) {
      console.warn('[portfolio] no se pudo cargar', h.ticker, e.message);
    } finally {
      portState.loading.delete(h.ticker);
      if (!state.asset && (state.view === 'portfolio' || state.view === 'dashboard' || state.view === 'simulator')) renderReport();
    }
  }));
}

/** Sincroniza (ticker, cantidad) de la cartera con el servidor de alertas,
 *  para que el cron pueda mandar el resumen diario por Telegram. Solo si hay
 *  Telegram vinculado; con hash local para no repetir el POST en cada render. */
async function syncPortfolioToTelegram() {
  if (!telegramState.chatId || !isLive()) return;
  // unit: la "cantidad" son CEDEARs si el costo se cargó en ARS, acciones si
  // se cargó en USD — el servidor lo necesita para valuar bien el resumen.
  const holdings = getPortfolio().map(h => ({ ticker: h.ticker, shares: h.shares, unit: h.costCurrency === 'ARS' ? 'cedear' : 'share' }));
  const hash = JSON.stringify(holdings);
  if (lsGetSafe('icp_tg_port_sync', '') === hash) return;
  try {
    const r = await fetch('/api/alerts?action=sync-portfolio', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: telegramState.chatId, holdings }),
    });
    if (r.ok) lsSetSafe('icp_tg_port_sync', hash);
  } catch (e) { console.warn('[portfolio] sync a Telegram falló', e.message); }
}

/* ───────────────────────── simulador "¿y si...?" + rebalanceo sugerido ───────────────────────── */
// Cartera hipotética editable en memoria (nunca toca portfolio.js/localStorage
// de la cartera real) — mismo motor de cálculo que Portfolio Advisor
// (computePortfolioStats), reusando el mismo caché de señales (portState.data)
// para no duplicar pedidos a los proveedores de datos.
const simState = { holdings: null, addTicker: '', addShares: '', suggestion: null };

function ensureSimHoldings() {
  if (simState.holdings == null) simState.holdings = getPortfolio().map(h => ({ ...h }));
}
function resetSimHoldings() {
  simState.holdings = getPortfolio().map(h => ({ ...h }));
  simState.suggestion = null;
  showToast('Simulación reiniciada con tu cartera real', 'info');
  renderReport();
}

async function loadSimulatorData() {
  ensureSimHoldings();
  if (!portState.macro) {
    try { portState.macro = await getMacro(); } catch (e) { console.warn('[simulator] no se pudo cargar macro', e.message); }
  }
  const macro = portState.macro;
  const missing = simState.holdings.filter(h => !portState.data[h.ticker] && !portState.loading.has(h.ticker));
  if (!missing.length) return;
  await Promise.all(missing.map(async (h) => {
    portState.loading.add(h.ticker);
    try {
      portState.data[h.ticker] = await computeLightSignal(h.ticker, macro);
    } catch (e) {
      console.warn('[simulator] no se pudo cargar', h.ticker, e.message);
    } finally {
      portState.loading.delete(h.ticker);
      if (!state.asset && state.view === 'simulator') renderReport();
    }
  }));
}

/** Rebalanceo determinístico a partir de datos YA calculados (score, peso
 *  real, precio) — nunca una recomendación de un modelo de lenguaje ni un
 *  número inventado. Reglas, todas explicables:
 *   - Señal "Venta" en una tenencia -> salir del todo (peso objetivo 0).
 *   - Señal "Reducir" -> cortar el peso actual a la mitad (con tope del perfil).
 *   - Posición por encima del tope de tu perfil de riesgo -> recortar al tope.
 *   - Lo liberado por esos tres casos se redistribuye, proporcional al margen
 *     disponible hasta el tope, entre las tenencias con señal de Compra
 *     (Fuerte o Moderada) que todavía tengan margen. Si no hay ninguna,
 *     queda como "liberado sin asignar" — nunca se inventa un destino. */
function computeRebalanceSuggestion(stats) {
  const profile = RISK_PROFILES[settingsState.riskProfile] ?? RISK_PROFILES.moderado;
  const cap = profile.maxPositionPct / 100;
  const rows = stats.rows.filter(r => r.weight != null && r.d?.scoreLabel && r.d?.price != null);
  if (!rows.length) return null;

  const actions = rows.map(r => ({
    ticker: r.ticker, price: r.d.price, currentShares: r.shares, currentWeight: r.weight, scoreLabel: r.d.scoreLabel, targetWeight: r.weight,
  }));

  let freed = 0;
  for (const a of actions) {
    if (a.scoreLabel === 'Venta') a.targetWeight = 0;
    else if (a.scoreLabel === 'Reducir') a.targetWeight = Math.min(a.currentWeight, cap) * 0.5;
    else if (a.currentWeight > cap) a.targetWeight = cap;
    freed += Math.max(0, a.currentWeight - a.targetWeight);
  }

  const buyCandidates = actions.filter(a => (a.scoreLabel === 'Compra Fuerte' || a.scoreLabel === 'Compra Moderada') && a.targetWeight < cap);
  const totalCapacity = buyCandidates.reduce((s, a) => s + (cap - a.targetWeight), 0);
  let unassigned = freed;
  if (freed > 0.0005 && totalCapacity > 0) {
    for (const a of buyCandidates) {
      const capacity = cap - a.targetWeight;
      const add = Math.min(capacity, freed * (capacity / totalCapacity));
      a.targetWeight += add;
      unassigned -= add;
    }
  }

  for (const a of actions) {
    a.targetShares = a.price > 0 ? (a.targetWeight * stats.totalValue) / a.price : a.currentShares;
    a.deltaShares = a.targetShares - a.currentShares;
    a.action = a.deltaShares > 0.0001 ? 'sumar' : a.deltaShares < -0.0001 ? (a.targetWeight <= 0.0001 ? 'vender_todo' : 'reducir') : 'mantener';
  }

  return { profileLabel: profile.label, capPct: profile.maxPositionPct, actions, freedPct: freed, unassignedPct: Math.max(0, unassigned), hasChanges: actions.some(a => a.action !== 'mantener') };
}

function applySuggestionToSimulation() {
  if (!simState.suggestion) return;
  const realHoldings = getPortfolio();
  const byTicker = Object.fromEntries(realHoldings.map(h => [h.ticker, h]));
  simState.holdings = simState.suggestion.actions
    .filter(a => a.action !== 'vender_todo')
    .map(a => {
      const base = byTicker[a.ticker] ?? { ticker: a.ticker, avgCost: null, costCurrency: 'USD', purchaseDate: null };
      return { ...base, shares: Math.max(0, Math.round(a.targetShares * 1000) / 1000) };
    });
  showToast('Simulación actualizada con el rebalanceo sugerido', 'success');
  renderReport();
}

const SIM_ACTION_META = {
  sumar: { label: 'Sumar', bg: 'oklch(0.32 0.11 152)', color: 'oklch(0.90 0.16 152)' },
  reducir: { label: 'Reducir', bg: 'oklch(0.30 0.10 45)', color: 'oklch(0.85 0.14 45)' },
  vender_todo: { label: 'Vender todo', bg: 'oklch(0.30 0.12 23)', color: 'oklch(0.88 0.16 23)' },
  mantener: { label: 'Mantener', bg: 'oklch(0.30 0.09 70)', color: 'oklch(0.85 0.13 70)' },
};

function simComparisonRowHTML(label, realVal, simVal, fmt = (v) => v) {
  const changed = realVal !== simVal;
  return `<div class="sim-compare-row">
    <div class="sim-compare-label">${esc(label)}</div>
    <div class="sim-compare-real">${fmt(realVal)}</div>
    <div class="sim-compare-arrow">${changed ? '→' : ''}</div>
    <div class="sim-compare-sim ${changed ? 'changed' : ''}">${fmt(simVal)}</div>
  </div>`;
}

function simulatorHTML() {
  ensureSimHoldings();
  const realHoldings = getPortfolio();
  if (!realHoldings.length) {
    return `
      ${sectionTitleHTML('Simulador "¿Y si...?"', 'shuffle')}
      ${emptyStateHTML('shuffle', 'Cargá al menos un holding en Portfolio Advisor para poder simular cambios sobre tu cartera real.')}`;
  }
  const realStats = computePortfolioStats(realHoldings);
  const simStats = computePortfolioStats(simState.holdings);
  const loadingCount = [...new Set([...realHoldings, ...simState.holdings].map(h => h.ticker))].filter(t => !portState.data[t]).length;
  const pct = (v) => v == null ? 'N/D' : `${Math.round(v * 100)}%`;
  const usd = (v) => v == null ? 'N/D' : fmtUsd(v);

  return `
    ${sectionTitleHTML('Simulador "¿Y si...?"', 'shuffle')}
    <div class="dash-intro">Probá cambios en tu cartera antes de operar de verdad: agregá, quitá o cambiá cantidades y mirá el impacto en el score ponderado, la diversificación y el riesgo — todo calculado con el mismo motor que Portfolio Advisor, sin tocar tu cartera real.</div>
    ${loadingCount ? `<div class="dash-loading-note">Cargando señales de ${loadingCount} activo(s)…</div>` : ''}

    <div class="card sim-compare-card">
      <div class="sim-compare-header">
        <div></div><div class="sim-compare-h">Cartera actual</div><div></div><div class="sim-compare-h">Simulación</div>
      </div>
      ${simComparisonRowHTML('Valor total', realStats.totalValue, simStats.totalValue, usd)}
      ${simComparisonRowHTML('Score ponderado', realStats.weightedScore, simStats.weightedScore, (v) => v == null ? 'N/D' : String(v))}
      ${simComparisonRowHTML('Mayor posición', realStats.topHolding?.weight ?? null, simStats.topHolding?.weight ?? null, pct)}
      ${simComparisonRowHTML('Mayor sector', realStats.sectorRows[0]?.pct ?? null, simStats.sectorRows[0]?.pct ?? null, pct)}
      ${simComparisonRowHTML('Señales de Venta/Reducir', realStats.sellSignals.length, simStats.sellSignals.length, String)}
    </div>

    <div class="panel-header" style="margin-top:22px;">
      ${sectionTitleHTML('Cartera simulada', 'briefcase', 'margin-bottom:0;')}
      <div class="watch-controls">
        <button class="port-add-btn" id="sim-suggest-btn">Sugerir rebalanceo</button>
        <button class="link-btn" id="sim-reset-btn">Reiniciar simulación</button>
      </div>
    </div>
    <div class="card sim-holdings-card">
      ${!simState.holdings.length ? `<div class="watch-empty">Sin posiciones en la simulación.</div>` : `
      <table class="sim-table">
        <thead><tr><th>Ticker</th><th>Señal</th><th>Peso</th><th>Cantidad</th><th></th></tr></thead>
        <tbody>
          ${simState.holdings.map((h, i) => {
            const d = portState.data[h.ticker];
            const row = simStats.rows.find(r => r.ticker === h.ticker);
            const sig = d?.scoreLabel ? scoreLabelColor(d.scoreLabel) : null;
            return `<tr data-sim-row="${i}">
              <td class="sim-ticker-cell">${esc(h.ticker)}</td>
              <td>${sig ? `<span class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(d.scoreLabel)} · ${d.score}</span>` : '<span class="bt-nd">—</span>'}</td>
              <td>${row?.weight != null ? pct(row.weight) : 'N/D'}</td>
              <td><input type="number" min="0" step="any" class="sim-shares-input" data-sim-shares="${i}" value="${h.shares}" aria-label="Cantidad de ${esc(h.ticker)}" /></td>
              <td><button class="watch-remove sim-remove-btn" data-sim-remove="${i}" title="Quitar de la simulación" aria-label="Quitar ${esc(h.ticker)} de la simulación">×</button></td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>`}
      <div class="port-form sim-add-form">
        <input list="sim-ticker-list" id="sim-add-ticker" class="port-input" placeholder="Ticker (ej. NVDA)" autocomplete="off" style="text-transform:uppercase;" value="${esc(simState.addTicker)}" />
        <datalist id="sim-ticker-list">${universe.map(a => `<option value="${esc(a.ticker)}">${esc(a.name)}</option>`).join('')}</datalist>
        <input type="number" min="0" step="any" id="sim-add-shares" class="port-input" placeholder="Cantidad" value="${esc(simState.addShares)}" style="max-width:120px;" />
        <button class="port-add-btn" id="sim-add-btn">Agregar a la simulación</button>
      </div>
    </div>

    ${simState.suggestion ? `
    <div class="card sim-suggestion-card">
      <div class="sim-suggestion-title">Rebalanceo sugerido — perfil ${esc(simState.suggestion.profileLabel)} (tope ${simState.suggestion.capPct}% por posición)</div>
      ${!simState.suggestion.hasChanges ? `<div class="sim-suggestion-empty">Tu cartera actual ya respeta el tope de tu perfil y no tiene señales de Venta/Reducir — no hay cambios que sugerir.</div>` : `
      <table class="sim-table">
        <thead><tr><th>Ticker</th><th>Acción</th><th>Peso actual → objetivo</th><th>Cantidad actual → objetivo</th></tr></thead>
        <tbody>
          ${simState.suggestion.actions.filter(a => a.action !== 'mantener').map(a => {
            const meta = SIM_ACTION_META[a.action];
            return `<tr>
              <td class="sim-ticker-cell">${esc(a.ticker)}</td>
              <td><span class="watch-signal" style="background:${meta.bg}; color:${meta.color};">${meta.label}</span></td>
              <td>${pct(a.currentWeight)} → ${pct(a.targetWeight)}</td>
              <td>${a.currentShares.toLocaleString('en-US', { maximumFractionDigits: 3 })} → ${a.targetShares.toLocaleString('en-US', { maximumFractionDigits: 3 })}</td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
      ${simState.suggestion.unassignedPct > 0.0005 ? `<div class="sim-suggestion-note">${pct(simState.suggestion.unassignedPct)} de la cartera queda liberado sin una posición de Compra con margen para recibirlo — quedaría como efectivo/a definir.</div>` : ''}
      <button class="port-add-btn" id="sim-apply-btn">Aplicar a la simulación</button>
      `}
    </div>` : ''}
    <div class="sim-disclaimer">El rebalanceo sugerido es una regla determinística sobre datos ya calculados (señal técnica/fundamental, peso real, tope de tu perfil de riesgo en Configuración) — no es asesoramiento financiero ni tiene en cuenta impacto impositivo o costos de transacción.</div>`;
}

function wireSimulatorEvents() {
  document.getElementById('sim-reset-btn')?.addEventListener('click', resetSimHoldings);
  document.getElementById('sim-apply-btn')?.addEventListener('click', applySuggestionToSimulation);
  document.getElementById('sim-suggest-btn')?.addEventListener('click', () => {
    const realStats = computePortfolioStats(getPortfolio());
    simState.suggestion = computeRebalanceSuggestion(realStats);
    if (!simState.suggestion) showToast('Todavía no cargaron las señales de tu cartera — probá de nuevo en un momento', 'info');
    renderReport();
  });
  els.report.querySelectorAll('.sim-shares-input').forEach(input => {
    input.addEventListener('change', () => {
      const i = +input.dataset.simShares;
      const v = parseFloat(input.value);
      if (simState.holdings[i]) simState.holdings[i].shares = isNaN(v) || v < 0 ? 0 : v;
      renderReport();
    });
  });
  els.report.querySelectorAll('.sim-remove-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const i = +btn.dataset.simRemove;
      simState.holdings.splice(i, 1);
      renderReport();
    });
  });
  const addTickerInput = document.getElementById('sim-add-ticker');
  const addSharesInput = document.getElementById('sim-add-shares');
  addTickerInput?.addEventListener('input', () => { simState.addTicker = addTickerInput.value.toUpperCase(); });
  addSharesInput?.addEventListener('input', () => { simState.addShares = addSharesInput.value; });
  document.getElementById('sim-add-btn')?.addEventListener('click', () => {
    const ticker = simState.addTicker.trim().toUpperCase();
    const shares = parseFloat(simState.addShares);
    if (!ticker || !universe.some(a => a.ticker === ticker)) { showToast('Ticker inválido', 'error'); return; }
    if (isNaN(shares) || shares <= 0) { showToast('Ingresá una cantidad válida', 'error'); return; }
    const existing = simState.holdings.find(h => h.ticker === ticker);
    if (existing) existing.shares = shares;
    else simState.holdings.push({ ticker, shares, avgCost: null, costCurrency: 'USD', purchaseDate: null });
    simState.addTicker = ''; simState.addShares = '';
    loadSimulatorData();
    renderReport();
  });
}

function watchCardHTML(ticker) {
  const d = watchState.data[ticker];
  if (!d) {
    if (watchState.loading.has(ticker)) {
      return `<div class="watch-card" data-ticker="${esc(ticker)}">
        <button class="watch-remove" data-remove="${esc(ticker)}" title="Quitar" aria-label="Quitar ${esc(ticker)} de la watchlist">×</button>
        <div class="skel skel-line" style="width:50%; height:14px;"></div>
        <div class="skel skel-line" style="width:70%; height:10px;"></div>
        <div class="skel skel-line" style="width:60%; height:16px;"></div>
        <div class="skel skel-line" style="width:40%; height:10px;"></div>
        <div class="skel" style="width:80px; height:18px; border-radius:10px;"></div>
      </div>`;
    }
    return `<div class="watch-card" data-ticker="${esc(ticker)}">
      <button class="watch-remove" data-remove="${esc(ticker)}" title="Quitar" aria-label="Quitar ${esc(ticker)} de la watchlist">×</button>
      <div class="watch-ticker">${esc(ticker)}</div>
      <div class="watch-loading">Sin datos</div>
    </div>`;
  }
  const up = d.changePct >= 0;
  const sig = scoreLabelColor(d.scoreLabel);
  const am = d.alert ? ALERT_META[d.alert.type] : null;
  return `<div class="watch-card ${am ? 'has-alert' : ''} ${d.alert?.pending ? 'is-pending' : ''}" data-ticker="${esc(ticker)}" style="${am ? `border-color:${am.color};` : ''}">
    <button class="watch-remove" data-remove="${esc(ticker)}" title="Quitar" aria-label="Quitar ${esc(ticker)} de la watchlist">×</button>
    <div class="watch-ticker">${esc(ticker)}${d.isReal === false ? ' <span class="watch-stale">demo</span>' : ''}</div>
    <div class="watch-name">${esc(d.name ?? '')}</div>
    <div class="watch-price">${fmtUsd(d.price)}</div>
    <div class="watch-change ${up ? 'up' : 'down'}">${fmtPct(d.changePct)}</div>
    <div class="watch-signal" style="background:${sig.bg}; color:${sig.color};">${esc(d.scoreLabel)} · ${d.score}</div>
    ${am ? `<div class="watch-alert" style="color:${am.color};"${alertTitleAttr(d.alert)}>⚡ ${esc(am.label)}${alertConfidenceSuffix(d.alert)}</div>` : ''}
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
        <button class="watch-alerts-btn ${alertsEnabled ? 'on' : ''}" id="watch-alerts-toggle" title="Avisar cuando un activo entra en zona de compra/venta o toca el stop" aria-pressed="${alertsEnabled}">
          ${alertsEnabled ? '🔔 Alertas activas' : '🔕 Activar alertas'}
        </button>
        <select class="watch-select" id="watch-sort" aria-label="Ordenar watchlist por">
          ${SORT_OPTIONS.map(o => `<option value="${o.key}" ${watchState.sortBy === o.key ? 'selected' : ''}>${esc(o.label)}</option>`).join('')}
        </select>
        <select class="watch-select" id="watch-filter" aria-label="Filtrar watchlist por señal">
          ${SIGNAL_FILTERS.map(s => `<option value="${esc(s)}" ${watchState.filterSignal === s ? 'selected' : ''}>${s === 'all' ? 'Todas las señales' : esc(s)}</option>`).join('')}
        </select>
      </div>
    </div>
    <div class="watch-grid">
      ${!tickers.length ? `<div class="watch-empty">Ningún activo en seguimiento tiene la señal filtrada ahora mismo.</div>` : tickers.map(watchCardHTML).join('')}
    </div>
    ${correlationMatrixHTML(allTickers, watchState.data)}`;
}

/** Matriz de correlación (retornos diarios, Pearson) entre pares de tickers
 *  en seguimiento — reusa las series de cierre ya cacheadas en
 *  watchState.data (computeLightSignal las trae para el gráfico chico de
 *  cada tarjeta), sin pedidos nuevos. Sirve para detectar diversificación
 *  falsa: activos que "parecen" distintos pero se mueven casi igual. */
function correlationMatrixHTML(tickers, dataMap) {
  const withCloses = tickers.filter(t => dataMap[t]?.closes?.length);
  if (withCloses.length < 2) return '';
  const corr = (a, b) => {
    if (a === b) return 1;
    const r = correlationAndBeta(dataMap[a].closes, dataMap[b].closes);
    return r?.correlation ?? null;
  };
  const cellColor = (v) => {
    if (v == null) return { bg: 'transparent', fg: 'var(--text-faint)' };
    const abs = Math.abs(v);
    if (v >= 0) return { bg: `oklch(${0.24 + abs * 0.08} ${0.04 + abs * 0.09} 152)`, fg: `oklch(${0.75 + abs * 0.1} ${0.08 + abs * 0.08} 152)` };
    return { bg: `oklch(${0.24 + abs * 0.08} ${0.04 + abs * 0.10} 23)`, fg: `oklch(${0.75 + abs * 0.1} ${0.08 + abs * 0.09} 23)` };
  };
  return `
    <div class="panel-header" style="margin-top:26px;">
      ${sectionTitleHTML('Matriz de Correlación', 'grid', 'margin-bottom:0;')}
    </div>
    <div class="dash-intro" style="margin-bottom:14px;">Correlación de retornos diarios entre los activos en seguimiento — verde/alto significa que se mueven casi igual (diversificación real baja entre ese par), rojo significa que se mueven en direcciones opuestas.</div>
    <div class="card corr-matrix-card">
      <div class="corr-matrix-scroll">
        <table class="corr-matrix-table">
          <thead><tr><th></th>${withCloses.map(t => `<th>${esc(t)}</th>`).join('')}</tr></thead>
          <tbody>
            ${withCloses.map(rowT => `
              <tr>
                <th>${esc(rowT)}</th>
                ${withCloses.map(colT => {
                  const v = corr(rowT, colT);
                  const { bg, fg } = cellColor(v);
                  return `<td style="background:${bg}; color:${fg};">${v == null ? '—' : v.toFixed(2)}</td>`;
                }).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
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

/** Tarjeta de vinculación/gestión de alertas por Telegram: avisa aunque el
 *  navegador esté cerrado (a diferencia de las notificaciones del navegador
 *  de más abajo, que solo funcionan con la pestaña abierta). */
function telegramCardHTML() {
  if (telegramState.configured === null) return `<div class="card watch-empty">Cargando configuración de Telegram…</div>`;
  if (telegramState.configured === false) {
    return `<div class="card telegram-card">
      <div class="telegram-card-title">📲 Alertas por Telegram</div>
      <div class="telegram-card-body">Esta función todavía no está configurada en el servidor (falta dar de alta el bot de Telegram). Mientras tanto, seguís teniendo las notificaciones del navegador de abajo.</div>
    </div>`;
  }
  if (!telegramState.chatId) {
    if (telegramState.linking) {
      const deepLink = `https://t.me/${telegramState.botUsername}?start=${telegramState.code}`;
      return `<div class="card telegram-card">
        <div class="telegram-card-title">📲 Alertas por Telegram</div>
        <div class="telegram-card-body">1. Tocá el botón para abrir el chat con el bot.<br>2. Mandale <b>Start</b> (o el mensaje ya viene precargado).<br>3. Volvé acá — se vincula solo.</div>
        <a class="port-add-btn telegram-link-btn" id="telegram-open-link" href="${esc(deepLink)}" target="_blank" rel="noopener">Abrir Telegram y vincular</a>
        <div class="telegram-waiting">Esperando confirmación… <button class="link-btn" id="telegram-cancel-link">Cancelar</button></div>
      </div>`;
    }
    return `<div class="card telegram-card">
      <div class="telegram-card-title">📲 Alertas por Telegram</div>
      <div class="telegram-card-body">Recibí un mensaje apenas un activo entre en zona de compra/venta o toque el stop — <b>aunque tengas el navegador cerrado</b>.</div>
      <button class="port-add-btn" id="telegram-start-link">Vincular Telegram</button>
    </div>`;
  }
  const watchTickers = getWatchlist();
  return `<div class="card telegram-card">
    <div class="telegram-card-title">📲 Alertas por Telegram <span class="telegram-linked-badge">✓ Vinculado</span></div>
    <div class="telegram-card-body">Elegí qué activos de tu Watchlist te avisan por Telegram cuando cambian de zona:</div>
    ${!watchTickers.length ? `<div class="telegram-empty-watch">Agregá activos a tu Watchlist para poder elegir cuáles avisan por Telegram.</div>` : `
    <div class="telegram-ticker-list">
      ${watchTickers.map(t => `
        <label class="telegram-ticker-row">
          <input type="checkbox" class="telegram-ticker-check" data-ticker="${esc(t)}" ${telegramState.subscriptions.includes(t) ? 'checked' : ''} ${telegramState.subsLoaded ? '' : 'disabled'} />
          <span>${esc(t)}</span>
        </label>`).join('')}
    </div>`}
    <button class="link-btn telegram-unlink-btn" id="telegram-unlink">Desvincular Telegram</button>
  </div>`;
}

/** Página de Alertas: activos en seguimiento cuya señal de precio está
 *  activa ahora mismo (zona de compra/venta o stop) — deriva 100% de
 *  watchState.data, ya calculado por Seguimiento, sin pedidos propios. */
function alertHistoryCardHTML() {
  const history = getAlertHistory();
  return `
    <div class="panel-header" style="margin-top:26px;">
      ${sectionTitleHTML('Historial de Alertas', 'calendar', 'margin-bottom:0;')}
      ${history.length ? `<button class="link-btn" id="alert-history-clear">Borrar historial</button>` : ''}
    </div>
    <div class="dash-intro" style="margin-bottom:14px;">Registro de cambios de zona (compra/venta/stop) que este navegador observó con la pestaña abierta y las notificaciones activas — no incluye lo que pasó mientras tenías el sitio cerrado (para eso están las Alertas por Telegram, arriba).</div>
    ${!history.length ? `<div class="card watch-empty">Todavía no se registró ninguna alerta en este navegador.</div>` : `
    <div class="card alert-history-card">
      ${history.map(h => {
        const meta = ALERT_META[h.type];
        const confLabel = h.confidence && h.type !== 'stop' ? ` <span class="alert-confidence ${esc(h.confidence)}">${esc(ALERT_CONFIDENCE_LABEL[h.confidence] ?? h.confidence)}</span>` : '';
        return `<div class="alert-history-row"${h.confirmations?.length ? ` title="${esc(h.confirmations.join(' · '))}"` : ''}>
          <span class="alert-history-dot" style="background:${meta?.color ?? 'var(--text-faint)'};"></span>
          <span class="alert-history-ticker">${esc(h.ticker)}</span>
          <span class="alert-history-label">${esc(meta?.label ?? h.type)}${confLabel}</span>
          <span class="alert-history-time">${esc(relativeTime(h.ts))}</span>
        </div>`;
      }).join('')}
    </div>`}`;
}

function alertsPageHTML() {
  const tickers = getWatchlist().filter(t => watchState.data[t]?.alert);
  return `
    ${sectionTitleHTML('Alertas', 'warning')}
    ${telegramCardHTML()}
    <div class="dash-intro" style="margin-top:22px;">Activos en tu Watchlist que están, ahora mismo, en zona de compra, zona de venta o tocaron el stop loss según el análisis técnico. Activá las notificaciones del navegador desde Watchlist para recibir un aviso apenas cambie una señal (solo con la pestaña abierta).</div>
    ${!tickers.length ? `<div class="card watch-empty">Ningún activo en seguimiento tiene una alerta activa en este momento.</div>` : `
    <div class="watch-grid">${tickers.map(watchCardHTML).join('')}</div>`}
    ${alertHistoryCardHTML()}`;
}
function wireAlertsEvents() {
  els.report.querySelectorAll('.watch-card').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target.closest('.watch-remove')) return; selectTicker(el.dataset.ticker); });
  });
  document.getElementById('alert-history-clear')?.addEventListener('click', clearAlertHistory);
  els.report.querySelectorAll('.watch-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = btn.dataset.remove;
      toggleWatchlist(ticker);
      delete watchState.data[ticker];
      renderReport();
    });
  });
  document.getElementById('telegram-start-link')?.addEventListener('click', startTelegramLink);
  document.getElementById('telegram-cancel-link')?.addEventListener('click', cancelTelegramLink);
  document.getElementById('telegram-unlink')?.addEventListener('click', unlinkTelegram);
  els.report.querySelectorAll('.telegram-ticker-check').forEach(el => {
    el.addEventListener('change', () => toggleTelegramSubscription(el.dataset.ticker));
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
        <input list="bt-ticker-list" id="bt-ticker" class="port-input" placeholder="Ticker (ej. AAPL)" aria-label="Ticker a backtestear" autocomplete="off" style="text-transform:uppercase;" value="${esc(backtestState.ticker)}" />
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
      ${alertBacktestCardHTML(r)}
      ${factorValidationCardHTML(r)}
    `}`;
}

/** Precisión histórica de las alertas de precio (zona de compra/venta/stop,
 *  ver detectPriceAlert en scoring.js): mismo motor que ve el usuario hoy en
 *  Watchlist/ficha, corrido sobre los mismos cortes del backtest de arriba,
 *  agrupado por (tipo, confianza) — para responder "cuando el motor dijo
 *  confianza alta, ¿cuántas veces acertó realmente?" con datos, no de oído. */
function alertBacktestCardHTML(r) {
  const rows = r.alertRows ?? [];
  if (!rows.length) return `
    <div class="card bt-disclaimer" style="margin-top:14px;">No hubo suficientes alertas de precio (zona de compra/venta/stop) disparadas en los cortes históricos de ${esc(r.ticker)} para medir su precisión.</div>`;
  return `
    <div class="card bt-table-card" style="margin-top:14px;">
      <div class="bt-factor-title">Precisión histórica de las alertas de precio — ${esc(r.ticker)}</div>
      <div class="bt-factor-intro">Cada vez que el motor de alertas hubiera avisado "zona de compra/venta" o "stop loss" en el pasado, con la confianza que calculó en ese momento — ¿qué retorno vino después? Compra acierta si el precio sube; venta/stop aciertan si el precio efectivamente cae.</div>
      <div class="bt-table-wrap">
        <table class="bt-table">
          <thead><tr>
            <th>Alerta</th><th>Ocurrencias</th>
            ${BACKTEST_HORIZONS.map(h => `<th>${h}d retorno prom.</th><th>${h}d acierto</th>`).join('')}
          </tr></thead>
          <tbody>
            ${rows.map(row => `
              <tr>
                <td class="bt-label-cell"><span class="bt-label-dot" style="background:${ALERT_META[row.type]?.color ?? 'var(--text-faint)'}"></span>${esc(row.label)}</td>
                <td>${row.occurrences}</td>
                ${row.horizons.map(x => x.n ? `
                  <td class="${x.avgPct >= 0 ? 'bt-pos' : 'bt-neg'}">${x.avgPct >= 0 ? '+' : ''}${x.avgPct.toFixed(1)}%</td><td>${x.winRate}%</td>
                ` : `<td class="bt-nd">—</td><td class="bt-nd">—</td>`).join('')}
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
      <div class="bt-disclaimer">La confianza "alta"/"media"/"baja" es la que calcula hoy el mismo motor de detectPriceAlert (confirmaciones de RSI, volumen y divergencia) — este cuadro mide si esa clasificación fue, en los hechos, más precisa cuanto más alta la confianza. Muestra chica en señales poco frecuentes: mirar la columna "Ocurrencias" antes de sacar conclusiones.</div>
    </div>`;
}

/** Validación empírica de factores: en vez de pesos fijos elegidos a mano,
 *  mide sobre los mismos cortes históricos del backtest qué tan bien
 *  correlacionó cada sub-factor del score (su valor 0-100 en ese momento)
 *  con el retorno real ${FACTOR_HORIZON} ruedas después, PARA ESTE activo
 *  puntual. No cambia los pesos del score en vivo (eso requeriría un
 *  estudio cruzado sobre muchos activos que esta plataforma no tiene) — es
 *  evidencia real, específica de este ticker, para que quien lo lea juzgue
 *  qué tan confiable fue cada factor históricamente. */
function factorValidationCardHTML(r) {
  const rows = r.factorCorrelations ?? [];
  if (!rows.length) return '';
  const interpret = (c) => {
    const abs = Math.abs(c);
    const dir = c >= 0 ? 'a favor' : 'en contra';
    if (abs >= 0.3) return `Correlación fuerte ${dir}`;
    if (abs >= 0.15) return `Correlación moderada ${dir}`;
    if (abs >= 0.05) return `Correlación débil ${dir}`;
    return 'Sin correlación real';
  };
  return `
    <div class="card bt-factor-card">
      <div class="bt-factor-title">Validación empírica de factores — ${esc(r.ticker)}</div>
      <div class="bt-factor-intro">Qué tan bien predijo cada sub-factor del score el retorno real a ${r.factorHorizon} ruedas, medido sobre los mismos ${r.sampleCount} cortes históricos de arriba — no es un peso inventado, es correlación calculada sobre datos reales de este activo.</div>
      <table class="sim-table">
        <thead><tr><th>Factor</th><th>Correlación</th><th>Muestras</th><th>Lectura</th></tr></thead>
        <tbody>
          ${rows.map(f => `
            <tr>
              <td class="sim-ticker-cell">${esc(f.label)}</td>
              <td class="${f.correlation >= 0 ? 'bt-pos' : 'bt-neg'}">${f.correlation >= 0 ? '+' : ''}${f.correlation.toFixed(2)}</td>
              <td>${f.n}</td>
              <td>${esc(interpret(f.correlation))}</td>
            </tr>`).join('')}
        </tbody>
      </table>
      <div class="bt-disclaimer">Correlación de Pearson entre el valor histórico 0-100 de cada factor y el retorno real ${r.factorHorizon} ruedas después. Es específica de ${esc(r.ticker)} — no se traslada automáticamente a otros activos ni cambia los pesos del score en vivo.</div>
    </div>`;
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

/* ───────────────────────── track record automático del motor ─────────────
 * El backtest de la página anterior mide UN activo por vez. El Track Record
 * corre el MISMO motor sin look-ahead sobre un universo curado de tickers
 * líquidos con historial largo, y AGREGA los resultados: junta todas las
 * ocurrencias de cada señal (Compra Fuerte … Venta) a lo largo de todos los
 * activos y calcula el retorno promedio y el win rate ponderados por muestra.
 * Es la respuesta honesta a "¿el motor realmente sirve?" — no una promesa,
 * evidencia agregada sobre datos reales. Mismo criterio de siempre: nada se
 * inventa; los activos sin historial suficiente o sin datos se excluyen y se
 * reporta la cobertura real. */
const TRACK_UNIVERSE = ['AAPL', 'MSFT', 'GOOGL', 'AMZN', 'NVDA', 'META', 'JPM', 'KO', 'XOM', 'JNJ', 'WMT', 'DIS'];
const trackState = { started: false, loading: false, done: 0, total: TRACK_UNIVERSE.length, result: null, error: null };

/** Combina las filas por-señal de varios backtests en una sola tabla
 *  agregada. Pondera cada activo por su cantidad de ocurrencias (n), así un
 *  ticker con 200 muestras pesa más que uno con 20 — pooledAvg =
 *  Σ(avg_i·n_i)/Σn_i, pooledWin = Σ(win_i·n_i)/Σn_i. */
function aggregateBacktestRows(perTickerRows, labels, colorFn) {
  return labels.map(label => {
    const acc = {}; // h -> { sumAvgN, sumWinN, n }
    for (const rows of perTickerRows) {
      const row = rows.find(r => r.label === label || `${r.type}:${r.confidence}` === label);
      if (!row) continue;
      for (const x of row.horizons) {
        if (!x.n) continue;
        const a = (acc[x.h] ??= { sumAvgN: 0, sumWinN: 0, n: 0 });
        a.sumAvgN += x.avgPct * x.n;
        a.sumWinN += x.winRate * x.n;
        a.n += x.n;
      }
    }
    const horizons = BACKTEST_HORIZONS.map(h => {
      const a = acc[h];
      if (!a || !a.n) return { h, n: 0, avgPct: null, winRate: null };
      return { h, n: a.n, avgPct: a.sumAvgN / a.n, winRate: Math.round(a.sumWinN / a.n) };
    });
    return { label, horizons, occurrences: horizons.reduce((m, x) => Math.max(m, x.n), 0) };
  }).filter(r => r.occurrences > 0);
}

async function loadTrackRecord() {
  if (trackState.loading) return;
  trackState.started = true;
  trackState.loading = true;
  trackState.error = null;
  trackState.done = 0;
  renderReport();
  const results = [];
  try {
    // Serial (no en paralelo) para no saturar el proveedor de velas ni la CPU
    // del navegador: cada backtest recorre ~500 velas con recálculo por corte.
    for (const ticker of TRACK_UNIVERSE) {
      try {
        const r = await runBacktest(ticker);
        if (!r.insufficientData) results.push(r);
      } catch (e) { /* activo sin datos: se excluye, no se inventa */ }
      trackState.done++;
      if (!state.asset && state.view === 'trackrecord') renderReport();
    }
    if (!results.length) { trackState.error = 'No se pudo correr el track record: ningún activo del universo tuvo historial suficiente en este momento.'; return; }

    const signalRows = aggregateBacktestRows(results.map(r => r.rows), BACKTEST_LABELS);
    // Alertas: universo de claves (tipo:confianza) presentes en algún activo.
    const alertKeys = [...new Set(results.flatMap(r => (r.alertRows ?? []).map(a => `${a.type}:${a.confidence}`)))];
    const alertAgg = aggregateBacktestRows(results.map(r => r.alertRows ?? []), alertKeys);
    // Reetiquetar las filas de alertas con su label lindo + tipo (para color).
    const alertRows = alertAgg.map(row => {
      const [type, confidence] = row.label.split(':');
      return { ...row, type, confidence, label: `${ALERT_BT_TYPE_LABEL[type] ?? type} · confianza ${confidence}` };
    }).sort((a, b) => a.type.localeCompare(b.type) || (ALERT_BT_CONFIDENCE_ORDER[a.confidence] ?? 9) - (ALERT_BT_CONFIDENCE_ORDER[b.confidence] ?? 9));

    const totalSamples = results.reduce((s, r) => s + r.sampleCount, 0);
    const allReal = results.every(r => r.isReal);
    const coverage = results.map(r => ({ ticker: r.ticker, samples: r.sampleCount, from: r.from, to: r.to, isReal: r.isReal }));
    trackState.result = { signalRows, alertRows, totalSamples, tickersUsed: results.length, tickersTotal: TRACK_UNIVERSE.length, allReal, coverage };
    showToast('Track record del motor listo', 'success');
  } catch (e) {
    trackState.error = `No se pudo correr el track record: ${e.message}`;
    showToast(trackState.error, 'error');
  } finally {
    trackState.loading = false;
    if (!state.asset && state.view === 'trackrecord') renderReport();
  }
}

/** Lee la fila "Compra Fuerte" a 20 ruedas como titular honesto del motor:
 *  cuando dijo su señal más alcista, ¿qué pasó en promedio al mes? */
function trackHeadlineStats(res) {
  const strong = res.signalRows.find(r => r.label === 'Compra Fuerte');
  const weak = res.signalRows.find(r => r.label === 'Venta');
  const pick = (row, h) => row?.horizons.find(x => x.h === h) ?? null;
  return {
    strong20: pick(strong, 20), strong40: pick(strong, 40),
    sell20: pick(weak, 20),
  };
}

function trackRecordPageHTML() {
  const res = trackState.result;
  const pct = trackState.total ? Math.round((trackState.done / trackState.total) * 100) : 0;
  return `
    ${sectionTitleHTML('Track Record del Motor', 'award')}
    <div class="dash-intro">La prueba honesta del motor: se corre la <strong>misma señal que ves en vivo</strong> — sin mirar el futuro (cada corte usa solo velas hasta ese día) — sobre un universo curado de ${TRACK_UNIVERSE.length} activos líquidos con historial largo, y se <strong>agregan</strong> todos los resultados. Junta cada vez que el motor dijo "Compra Fuerte", "Reducir", etc. a lo largo de todos los activos y mide el retorno real y el % de acierto que vinieron después, ponderados por cantidad de muestras.</div>
    ${trackState.loading ? `
      <div class="card bt-meta-card">
        <div style="margin-bottom:8px;">Corriendo el motor sobre ${TRACK_UNIVERSE.length} activos con historial real — ${trackState.done}/${trackState.total} listos…</div>
        <div class="track-progress"><div class="track-progress-bar" style="width:${pct}%;"></div></div>
      </div>` : ''}
    ${trackState.error ? `<div class="card watch-empty">${esc(trackState.error)}</div>` : ''}
    ${!res ? (trackState.loading ? '' : `<div class="card watch-empty">Preparando el track record…</div>`) : `
      ${trackHeadlineCardsHTML(res)}
      <div class="card bt-meta-card">Agregado sobre <strong>${res.tickersUsed}/${res.tickersTotal}</strong> activos con historial suficiente · <strong>${res.totalSamples.toLocaleString('es-AR')}</strong> cortes históricos analizados en total${res.allReal ? '' : ' · algunos activos usaron datos de caché (sin conexión en vivo al proveedor en este momento)'}</div>
      <div class="card bt-table-card">
        <div class="bt-factor-title">Rendimiento agregado por señal del motor</div>
        <div class="bt-factor-intro">Cada fila junta TODAS las veces que el motor dio esa señal, en los ${res.tickersUsed} activos. Retorno promedio y win rate ponderados por cantidad de ocurrencias.</div>
        <div class="bt-table-wrap">
          <table class="bt-table">
            <thead><tr>
              <th>Señal</th><th>Ocurrencias</th>
              ${BACKTEST_HORIZONS.map(h => `<th>${h}d retorno prom.</th><th>${h}d win rate</th>`).join('')}
            </tr></thead>
            <tbody>
              ${res.signalRows.map(row => `
                <tr>
                  <td class="bt-label-cell"><span class="bt-label-dot" style="background:${scoreLabelColor(row.label).color}"></span>${esc(row.label)}</td>
                  <td>${row.occurrences.toLocaleString('es-AR')}</td>
                  ${row.horizons.map(x => x.n ? `
                    <td class="${x.avgPct >= 0 ? 'bt-pos' : 'bt-neg'}">${x.avgPct >= 0 ? '+' : ''}${x.avgPct.toFixed(1)}%</td><td>${x.winRate}%</td>
                  ` : `<td class="bt-nd">—</td><td class="bt-nd">—</td>`).join('')}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="bt-disclaimer">Lo esperable si el motor sirve: el retorno promedio y el win rate deberían caer de forma ordenada desde "Compra Fuerte" hacia "Venta". Resultado histórico sobre datos reales, sin look-ahead. No es garantía de resultados futuros.</div>
      </div>
      ${res.alertRows.length ? `
      <div class="card bt-table-card" style="margin-top:14px;">
        <div class="bt-factor-title">Precisión agregada de las alertas de precio</div>
        <div class="bt-factor-intro">Lo mismo para las alertas de zona de compra/venta/stop, agregado sobre todos los activos: cuando el motor avisó con confianza "alta", ¿acertó más seguido que con confianza "baja"?</div>
        <div class="bt-table-wrap">
          <table class="bt-table">
            <thead><tr>
              <th>Alerta</th><th>Ocurrencias</th>
              ${BACKTEST_HORIZONS.map(h => `<th>${h}d retorno prom.</th><th>${h}d acierto</th>`).join('')}
            </tr></thead>
            <tbody>
              ${res.alertRows.map(row => `
                <tr>
                  <td class="bt-label-cell"><span class="bt-label-dot" style="background:${ALERT_META[row.type]?.color ?? 'var(--text-faint)'}"></span>${esc(row.label)}</td>
                  <td>${row.occurrences.toLocaleString('es-AR')}</td>
                  ${row.horizons.map(x => x.n ? `
                    <td class="${x.avgPct >= 0 ? 'bt-pos' : 'bt-neg'}">${x.avgPct >= 0 ? '+' : ''}${x.avgPct.toFixed(1)}%</td><td>${x.winRate}%</td>
                  ` : `<td class="bt-nd">—</td><td class="bt-nd">—</td>`).join('')}
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>` : ''}
      <div class="card bt-table-card" style="margin-top:14px;">
        <div class="bt-factor-title">Cobertura — activos incluidos</div>
        <div class="bt-table-wrap">
          <table class="bt-table">
            <thead><tr><th>Activo</th><th>Cortes analizados</th><th>Desde</th><th>Hasta</th><th>Datos</th></tr></thead>
            <tbody>
              ${res.coverage.map(c => `
                <tr>
                  <td class="bt-label-cell">${esc(c.ticker)}</td>
                  <td>${c.samples.toLocaleString('es-AR')}</td>
                  <td>${esc(c.from ?? '—')}</td>
                  <td>${esc(c.to ?? '—')}</td>
                  <td>${c.isReal ? 'en vivo' : 'caché'}</td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
        <div class="bt-disclaimer">Universo curado de activos líquidos con años de historial (donde el backtest sin look-ahead es más confiable). No incluye CEDEARs de baja liquidez ni cripto — su historial corto o ruidoso distorsionaría el agregado. ${res.tickersUsed < res.tickersTotal ? `${res.tickersTotal - res.tickersUsed} activo(s) quedaron fuera por historial insuficiente o falta de datos en este momento.` : ''}</div>
      </div>
    `}
  `;
}

function trackHeadlineCardsHTML(res) {
  const s = trackHeadlineStats(res);
  const card = (label, stat, sub) => {
    if (!stat) return '';
    const pos = stat.avgPct >= 0;
    return `
      <div class="card track-head-card">
        <div class="track-head-label">${esc(label)}</div>
        <div class="track-head-value ${pos ? 'up' : 'down'}">${pos ? '+' : ''}${stat.avgPct.toFixed(1)}%</div>
        <div class="track-head-sub">${esc(sub)} · ${stat.winRate}% win rate · ${stat.n.toLocaleString('es-AR')} casos</div>
      </div>`;
  };
  return `
    <div class="track-head-grid">
      ${card('Tras "Compra Fuerte", a 20 ruedas', s.strong20, 'retorno promedio real')}
      ${card('Tras "Compra Fuerte", a 40 ruedas', s.strong40, 'retorno promedio real')}
      ${card('Tras "Venta", a 20 ruedas', s.sell20, 'retorno promedio real')}
    </div>`;
}

function wireTrackRecordEvents() { /* la página se autocarga vía load(); sin interacción extra */ }

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

/** Bonos Argentinos: la otra gran clase de activo que sigue cualquier
 *  inversor argentino, hasta ahora ausente de la plataforma. Precios reales
 *  en vivo (data912.com, mismo proveedor que ya usamos para el precio real
 *  de CEDEARs en BYMA) + paridad (que es directamente el precio, sin
 *  necesitar ningún supuesto). A propósito NO se calcula TIR ni duration:
 *  estos bonos tienen cupón escalonado y amortización parcial ya en curso
 *  (no son bullet bonds simples), y modelar mal ese cronograma daría un
 *  número que parece preciso pero podría estar mal — se prefiere no
 *  mostrarlo a mostrar uno que podría inducir a una mala decisión. */
const BONDS_INFO = {
  AL29: { name: 'Bonar 2029', ley: 'Argentina', moneda: 'USD' },
  AL30: { name: 'Bonar 2030', ley: 'Argentina', moneda: 'USD' },
  AL35: { name: 'Bonar 2035', ley: 'Argentina', moneda: 'USD' },
  AL41: { name: 'Bonar 2041', ley: 'Argentina', moneda: 'USD' },
  AE38: { name: 'Bonar 2038', ley: 'Argentina', moneda: 'USD' },
  GD29: { name: 'Global 2029', ley: 'Nueva York', moneda: 'USD' },
  GD30: { name: 'Global 2030', ley: 'Nueva York', moneda: 'USD' },
  GD35: { name: 'Global 2035', ley: 'Nueva York', moneda: 'USD' },
  GD38: { name: 'Global 2038', ley: 'Nueva York', moneda: 'USD' },
  GD41: { name: 'Global 2041', ley: 'Nueva York', moneda: 'USD' },
  GD46: { name: 'Global 2046', ley: 'Nueva York', moneda: 'USD' },
};
const bondsState = { items: null, loading: false, loadedAt: 0, error: null };

async function loadBondsData() {
  if (bondsState.loading || Date.now() - bondsState.loadedAt < 2 * 60 * 1000) return;
  bondsState.loading = true;
  bondsState.error = null;
  try {
    const res = await getBonds();
    const byTicker = {};
    for (const it of res.items ?? []) if (BONDS_INFO[it.symbol]) byTicker[it.symbol] = it;
    bondsState.items = Object.keys(BONDS_INFO).map(symbol => ({ symbol, ...BONDS_INFO[symbol], quote: byTicker[symbol] ?? null }));
    bondsState.isReal = res.isReal;
    bondsState.loadedAt = Date.now();
  } catch (e) {
    bondsState.error = 'No se pudo cargar la cotización de bonos en este momento.';
    console.warn('[bonds] no se pudo cargar', e.message);
  } finally {
    bondsState.loading = false;
    if (!state.asset && state.view === 'bonds') renderReport();
  }
}

function bondsPageHTML() {
  const items = bondsState.items;
  return `
    ${sectionTitleHTML('Bonos Argentinos', 'building')}
    <div class="dash-intro">Precios reales en vivo de los principales bonos soberanos en dólares (BYMA, vía el mismo proveedor que ya usamos para el precio real de CEDEARs). La <strong>paridad</strong> es directamente el precio contra 100 (valor par) — no requiere ningún supuesto. A propósito no calculamos TIR ni duration: estos bonos tienen cupón escalonado y amortización parcial ya en curso, y un cálculo aproximado podría mostrar un número que parece preciso pero está mal. Para TIR/duration exactos, consultá a tu bróker o BYMA Data.</div>
    ${bondsState.error ? `<div class="card watch-empty">${esc(bondsState.error)}</div>` : !items ? `<div class="card watch-empty">Cargando cotizaciones…</div>` : `
    <div class="card bt-table-card">
      <div class="bt-table-wrap">
        <table class="bt-table screener-table">
          <thead><tr><th class="scr-left">Ticker</th><th class="scr-left">Nombre</th><th class="scr-left">Ley</th><th class="scr-left">Moneda</th><th>Precio</th><th>Var %</th><th>Paridad</th></tr></thead>
          <tbody>
            ${items.map(b => `
              <tr class="screener-row" data-bond="${esc(b.symbol)}">
                <td class="scr-left" style="font-weight:700;">${esc(b.symbol)}</td>
                <td class="scr-left" style="color:var(--text-mute);">${esc(b.name)}</td>
                <td class="scr-left" style="color:var(--text-mute);">${esc(b.ley)}</td>
                <td class="scr-left" style="color:var(--text-mute);">${esc(b.moneda)}</td>
                <td>${b.quote ? `US$${b.quote.price.toFixed(2)}` : 'N/D'}</td>
                <td class="${b.quote?.pctChange >= 0 ? 'bt-pos' : b.quote?.pctChange < 0 ? 'bt-neg' : ''}">${b.quote?.pctChange != null ? fmtPct(b.quote.pctChange) : 'N/D'}</td>
                <td>${b.quote ? `${b.quote.price.toFixed(1)}%` : 'N/D'}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>
    </div>
    <div class="bt-disclaimer">${bondsState.isReal ? 'Precios en vivo' : 'Sin conexión al proveedor — mostrando la última cotización disponible'}, BYMA vía data912.com. No incluye bonos en pesos (CER, Lecaps/Boncaps), Bopreales ni provinciales — universo acotado a los soberanos en USD más seguidos.</div>
    `}`;
}

function wireBondsEvents() { /* filas informativas — sin acción propia por ahora */ }

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
  const priceAlert = detectPriceAlert(quote.usd, technical, { recentCloses: candles.c.slice(-3) });
  // Plan operativo numérico (stop, objetivos) — computePlan es puro cálculo
  // sobre lo ya pedido, sin requests extra; lo usa la tabla del Portfolio
  // para stop sugerido y distancia al stop de cada tenencia.
  const planRaw = computePlan(technical, scoreResult.score).raw;
  const setup = shortTermSetup(technical, candles); // radar de trades cortos, sin pedidos extra
  const gap = computeGap(candles, technical); // radar de gaps de apertura, sin pedidos extra
  return {
    name: asset?.name ?? ticker, sector: asset?.sector ?? null, category: asset?.category ?? null,
    price: quote.usd, changePct: quote.changePct,
    cedearArs: quote.cedearArs ?? null, // precio del CEDEAR en pesos — null para cripto, que no tiene CEDEAR
    cedearSource: quote.cedearSource ?? null, // 'live' (precio real BYMA) | 'estimated' (vía CCL) | null
    // Ratio efectivo: el servidor lo autocorrige midiendo el ratio implícito
    // en vivo (BYMA re-ratea papeles y el estático queda viejo); si el quote
    // no lo trae (mock/fallback), se usa el del universo.
    ratio: quote.ratio ?? asset?.ratio ?? null,
    cclImplied: quote.cclImplied ?? null, // dólar implícito en este CEDEAR (solo con precio BYMA real)
    cclRef: quote.cclRef ?? null,
    score: scoreResult.score, scoreLabel: scoreResult.scoreLabel, isReal: quote.isReal && candles.isReal,
    alert: priceAlert,
    structure: technical.structure, // BOS/CHoCH — ya calculado acá, sin pedidos extra
    rsi: isNaN(technical.rsi) ? null : technical.rsi, // ya calculado acá — sin pedidos extra, para el Screener
    sparkline: candles.c.slice(-30), // últimos cierres reales, ya obtenidos acá — sin pedidos extra
    closes: candles.c, // serie completa (~220 ruedas) — reusada para volatilidad/drawdown de la cartera, sin pedidos extra
    highlight: technicalHighlight(technical),
    planRaw, // stop/objetivos numéricos (USD) — para la columna de stop del Portfolio
    setup, // setup de trade corto (o null) — para el Radar de Trades Cortos
    gap, // hueco de apertura de la última rueda (o null) — para el Radar de Gaps
  };
}

/* ───────────────────────── radar de trades cortos ─────────────────────────
 * Detecta setups técnicos ALCISTAS de corto plazo (1-3 días) de alta
 * confianza, combinando disparadores reales sobre las mismas velas ya
 * pedidas: squeeze de volatilidad recién liberado, ruptura de máximos con
 * volumen, cruce alcista de MACD, divergencia alcista, salida de sobreventa,
 * tendencia fuerte, etc. Suma un puntaje de confianza y exige al menos un
 * disparador "primario" para calificar — no es una recomendación ni una
 * garantía, es un tamiz técnico para el trader de corto plazo (alto riesgo). */
function shortTermSetup(technical, candles) {
  const c = candles.c, h = candles.h, l = candles.l, v = candles.v || [];
  const n = c.length;
  if (n < 30) return null;
  const price = c[n - 1], atr = technical.atr;
  if (!(atr > 0) || isNaN(atr)) return null;

  const triggers = [];
  const risks = [];
  let score = 0;
  const add = (pts, label, primary = false) => { score += pts; triggers.push({ label, primary }); };

  // 1. Squeeze de volatilidad (resorte comprimido)
  if (technical.squeeze?.justFired) add(26, `Squeeze de volatilidad recién liberado tras ${technical.squeeze.barsInSqueeze} ruedas`, true);
  else if (technical.squeeze?.active) add(8, `Volatilidad comprimida hace ${technical.squeeze.barsInSqueeze} ruedas — ruptura próxima`);

  // 2. Ruptura de máximos de 20 ruedas con volumen
  const hi20 = Math.max(...h.slice(-21, -1));
  const hasVol = v.some(x => x > 0);
  const volAvg = hasVol ? v.slice(-21, -1).reduce((a, b) => a + b, 0) / 20 : 0;
  const volRatio = hasVol && volAvg > 0 ? v[n - 1] / volAvg : null;
  if (price >= hi20 * 0.997) {
    if (volRatio && volRatio >= 1.3) add(22, `Ruptura de máximos de 20 ruedas con volumen alto (${volRatio.toFixed(1)}× el promedio)`, true);
    else add(12, 'Ruptura de máximos de 20 ruedas', true);
  }

  // 3. Cruce alcista de MACD reciente (histograma pasó a positivo)
  const { hist } = macd(c);
  if (hist[n - 1] != null && hist[n - 2] != null && hist[n - 2] <= 0 && hist[n - 1] > 0) add(16, 'Cruce alcista de MACD en la última rueda', true);

  // 4. Patrón de vela alcista
  if (technical.candlePattern?.bias === 'bullish') add(12, technical.candlePattern.label);

  // 5. RSI saliendo de sobreventa
  const rs = rsi(c, 14);
  if (rs[n - 1] != null && rs[n - 2] != null && rs[n - 2] < 42 && rs[n - 1] > rs[n - 2] && rs[n - 1] >= 40) add(12, 'RSI girando al alza desde sobreventa');

  // 6. Divergencia alcista
  if (technical.divergence?.type === 'bullish') add(15, 'Divergencia alcista (RSI vs precio)', true);

  // 7. Tendencia fuerte
  if (technical.adx > 25 && price > technical.ema20 && technical.ema20 > technical.ema50) add(11, `Tendencia fuerte (ADX ${technical.adx.toFixed(0)})`);

  // 8. Volumen confirma
  if (technical.obvConfirms === true) add(8, 'El volumen (OBV) acompaña el movimiento');

  // 9. Recuperó la EMA20 tras pullback en tendencia alcista
  if (technical.bullishAlign && c[n - 2] < technical.ema20 && price > technical.ema20) add(10, 'Recuperó la EMA20 (rebote dentro de la tendencia)');

  // Riesgos / penalizaciones
  if (!isNaN(technical.rsi) && technical.rsi > 72) { score -= 12; risks.push(`RSI sobrecomprado (${technical.rsi.toFixed(0)}) — puede corregir antes de seguir`); }
  if (technical.resistance && price >= technical.resistance * 0.99 && price <= technical.resistance * 1.01) risks.push('Muy cerca de una resistencia — puede frenar ahí');
  if (technical.obvConfirms === false) { score -= 8; risks.push('El volumen no acompaña — riesgo de movimiento en falso'); }
  if (technical.divergence?.type === 'bearish') { score -= 10; risks.push('Divergencia bajista activa — cautela'); }

  score = Math.max(0, Math.min(100, score));
  const hasPrimary = triggers.some(t => t.primary);
  const qualifies = hasPrimary && score >= 45;

  // Plan de trade corto (horizonte 1-3 días): stop ajustado bajo el swing
  // reciente, objetivos por múltiplos de ATR.
  const swingLow = Math.min(...l.slice(-6));
  const stop = Math.max(swingLow - 0.2 * atr, price - 1.5 * atr);
  const target1 = price + 1.5 * atr;
  const target2 = price + 2.5 * atr;
  const risk = price - stop, reward = target1 - price;
  const rr = risk > 0 ? reward / risk : null;
  const expectedMovePct = (atr / price) * 100;

  return {
    score, qualifies, triggers, risks,
    entry: price, stop, target1, target2, rr, expectedMovePct,
    confidence: score >= 75 ? 'muy alta' : score >= 60 ? 'alta' : score >= 45 ? 'media' : 'baja',
  };
}

/* ───────────────────────── radar de gaps / pre-market ─────────────────────
 * Detecta el hueco (gap) de apertura de la última rueda: la diferencia entre
 * la apertura de hoy y el cierre de ayer. Un gap es una señal de fuerza (o
 * pánico) real — el mercado reprecia el activo de un salto por un catalizador
 * (balance, noticia, guidance). Se mide su tamaño en % y en múltiplos de ATR
 * (para saber si es grande relativo a la volatilidad típica del activo), la
 * dirección, y si ya se "rellenó" intradía (el precio volvió al cierre previo
 * — un gap que se rellena suele ser menos sostenible). Todo se calcula sobre
 * las mismas velas ya pedidas por computeLightSignal, sin requests extra.
 * Devuelve null si el gap es insignificante (<0.75%) para no ensuciar el
 * radar con ruido. */
function computeGap(candles, technical) {
  const o = candles.o, c = candles.c, h = candles.h, l = candles.l;
  const n = c.length;
  if (n < 2 || !o || o[n - 1] == null) return null;
  const prevClose = c[n - 2];
  const open = o[n - 1];
  if (!(prevClose > 0)) return null;
  const gapPct = ((open - prevClose) / prevClose) * 100;
  if (Math.abs(gapPct) < 0.75) return null; // ruido: no es un gap real
  const atr = technical?.atr;
  const gapAtr = atr > 0 && !isNaN(atr) ? (open - prevClose) / atr : null;
  const up = gapPct > 0;
  // Relleno del gap: un gap alcista se "rellena" si el mínimo del día tocó el
  // cierre previo; uno bajista, si el máximo lo tocó.
  const filled = up ? l[n - 1] <= prevClose : h[n - 1] >= prevClose;
  // Cuánto del hueco se cerró intradía (0 = intacto, 1 = totalmente relleno).
  const lastPrice = c[n - 1];
  const gapDist = open - prevClose;
  const fillFrac = gapDist !== 0 ? Math.max(0, Math.min(1, (open - lastPrice) / gapDist)) : 0;
  // ¿El precio se mantiene por encima/debajo de la apertura? (holding the gap)
  const holding = up ? lastPrice >= open * 0.999 : lastPrice <= open * 1.001;
  return {
    pct: gapPct, atr: gapAtr, direction: up ? 'up' : 'down',
    filled, fillFrac, holding, prevClose, open, last: lastPrice,
    // Significancia: gap grande relativo a la volatilidad típica del activo.
    significant: gapAtr != null ? Math.abs(gapAtr) >= 1 : Math.abs(gapPct) >= 3,
  };
}

/** Un solo motivo técnico real, el más relevante disponible — no una lista
 *  completa (esa vive en la ficha del activo), solo el titular para tarjetas
 *  compactas del Dashboard. */
function technicalHighlight(t) {
  if (t.candlePattern) return t.candlePattern.label + ' en la última rueda.';
  if (t.squeeze?.justFired) return `Squeeze de volatilidad liberado tras ${t.squeeze.barsInSqueeze} ruedas comprimido — posible movimiento fuerte en curso.`;
  if (t.squeeze?.active) return `Squeeze de volatilidad activo (${t.squeeze.barsInSqueeze} ruedas) — compresión, posible ruptura próxima.`;
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
      notifyStructureChange(ticker, signal.structure);
      watchState.data[ticker] = signal;
    } catch (e) {
      console.warn('[watchlist] no se pudo cargar', ticker, e.message);
    } finally {
      watchState.loading.delete(ticker);
      refreshIfWatchlistVisible();
    }
  }));
}

// Lotes (no todo el universo junto): las velas ahora salen de Alpaca (free
// tier, ~200 req/min compartidos entre todo el sitio) en vez de Twelve Data
// (que solo daba ~8 req/min y era el techo real de cuántos activos podían
// verse en vivo a la vez). Con ese margen se puede pedir un lote bastante
// más grande de golpe sin arriesgar caer a demo por rate limit — se sigue
// espaciando un poco para dejar margen a otros visitantes concurrentes.
const DASHBOARD_BATCH_SIZE = 20;
const DASHBOARD_BATCH_DELAY_MS = 1500;

async function loadDashboardData() {
  dashState.started = true;
  const macro = await getMacro();
  dashState.macro = macro; // riesgo país para el Panel Argentina
  if (!dashState.ccl) {
    try { dashState.ccl = await getCCL(); } catch (e) { console.warn('[dashboard] no se pudo cargar CCL', e.message); }
  }
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
loadTelegramConfig();
if (telegramState.chatId) loadTelegramSubscriptions();
document.getElementById('wordmark-home')?.addEventListener('click', () => {
  state.asset = null; state.report = null; state.error = null; state.loading = false;
  state.view = 'dashboard';
  els.tickerchip.textContent = '—';
  renderTopbar();
  renderReport();
  closeMobileSidebar();
});
// PWA: instalable como app. El service worker nunca cachea /api/* (los datos
// de mercado siguen la frescura que ya maneja dataSource.js) — solo permite
// que el shell de la app cargue offline/rápido como respaldo.
if ('serviceWorker' in navigator && isLive()) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('./sw.js').catch(e => console.warn('[pwa] no se pudo registrar el service worker', e.message));
  });
}

// Primera visita: tour guiado automático (una sola vez, reabrible desde el botón de ayuda del topbar).
if (lsGetSafe('icp_onboarding_seen', '') !== '1') {
  setTimeout(() => showOnboarding(), 600);
}

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
