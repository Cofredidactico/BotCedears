import { getUniverse, getAsset, getQuote, getCandles, getFundamentals, getNews, getMacro, getCCL } from './dataSource.js';
import { computeTechnical, resampleWeekly, weeklyConfluence, correlationAndBeta } from './indicators.js';
import { computeScore, computePlan, SECTOR_PE_RANGE, detectPriceAlert } from './scoring.js';
import { renderPriceChartSVG } from './chart.js';
import { getWatchlist, isWatched, toggleWatchlist, WATCHLIST_MAX } from './watchlist.js';

const GREEN = 'oklch(0.68 0.13 150)', AMBER = 'oklch(0.72 0.11 85)', RED = 'oklch(0.65 0.15 25)';

const els = {
  datebadge: document.getElementById('datebadge'),
  connbanner: document.getElementById('connbanner'),
  searchinput: document.getElementById('searchinput'),
  tickerchip: document.getElementById('tickerchip'),
  dropdown: document.getElementById('dropdown'),
  report: document.getElementById('report'),
  watchlist: document.getElementById('watchlist'),
};

const state = { query: '', asset: null, report: null, loading: false, error: null };
function lsGetSafe(key, fallback) { try { return localStorage.getItem(key) || fallback; } catch { return fallback; } }
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

/* ───────────────────────── alertas de precio ───────────────────────── */
const ALERT_META = {
  buy: { label: 'En zona de compra', color: GREEN },
  sell: { label: 'En zona de venta', color: AMBER },
  stop: { label: 'Tocó el stop loss', color: RED },
};
let alertsEnabled = lsGetSafe('icp_alerts_enabled', '0') === '1';
const lastAlertByTicker = {}; // ticker -> 'buy'|'sell'|'stop'|null, para notificar solo en la transición

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
  renderWatchlist();
}

const CHART_TABS = [
  { key: '45min', label: '45m' },
  { key: '4h', label: '4H' },
  { key: '1day', label: '1D' },
  { key: '1week', label: '1S' },
];
const chartState = { tf: '1day', cache: {}, loading: new Set() }; // tf -> { candles, isReal }
function chartTabsForAsset(asset) {
  return asset?.category === 'Cripto' ? CHART_TABS.filter(t => t.key === '1day' || t.key === '1week') : CHART_TABS;
}

function chartCardBody(dailyTechnical) {
  const tf = chartState.tf;
  const entry = chartState.cache[tf];
  if (chartState.loading.has(tf) && !entry) return `<div class="skel skel-chart"></div>`;
  if (!entry) return `<div class="chart-empty">Sin datos para este timeframe todavía.</div>`;
  const svg = renderPriceChartSVG(entry.candles, { support: dailyTechnical.support, resistance: dailyTechnical.resistance });
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
const fmtPct = (n, digits = 1) => n == null || isNaN(n) ? 'N/D' : `${n >= 0 ? '+' : ''}${n.toFixed(digits)}%`;
const fmtNum = (n, digits = 2) => n == null || isNaN(n) ? 'N/D' : n.toFixed(digits);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

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
  if (!r) conn = { text: 'Esperando selección de activo', color: AMBER, border: 'oklch(0.40 0.06 85)' };
  else if (r.quote.isReal && r.candles.isReal) conn = { text: 'Conectado a fuente de datos en vivo', color: GREEN, border: 'oklch(0.40 0.08 150)' };
  else if (r.quote.isReal || r.candles.isReal) conn = { text: 'Datos parcialmente en vivo — alguna fuente cayó a caché', color: AMBER, border: 'oklch(0.40 0.06 85)' };
  else conn = { text: 'Sin conexión al proveedor de datos — mostrando último valor disponible', color: RED, border: 'oklch(0.40 0.08 25)' };

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
      renderWatchlist();
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
    const [quote, candles, fundamentals, news, macro, ccl, weeklyNative, spyCandles] = await Promise.all([
      getQuote(ticker), getCandles(ticker, '1day', 220), getFundamentals(ticker), getNews(ticker), getMacro(), getCCL(),
      isCripto ? Promise.resolve(null) : getCandles(ticker, '1week', 130),
      ticker === 'SPY' ? Promise.resolve(null) : getCandles('SPY', '1day', 220),
    ]);

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
    const scoreResult = computeScore({ technical, fundamentals: fundForScore, macro: macroForScore, newsSentiment: news?.sentimentScore ?? null, candles, confluence, sector: asset.sector });
    const plan = computePlan(technical, scoreResult.score);

    state.report = {
      asset, quote, candles, fundamentals, news, macro, ccl,
      technical, weeklyTechnical, confluence, marketCorrelation, ...scoreResult, plan,
      ts: { quote: now, candles: now, fundamentals: now, news: now },
    };

    // El gráfico arranca en 1D/1S sin pegarle de nuevo a la API: reutiliza
    // las mismas velas que ya se pidieron para el análisis diario/semanal.
    chartState.cache['1day'] = { candles, isReal: candles.isReal };
    if (weeklyCandles) chartState.cache['1week'] = { candles: weeklyCandles, isReal: isCripto ? candles.isReal : (weeklyNative?.isReal ?? false) };
    state.loading = false;
  } catch (e) {
    console.error('[app] error cargando reporte', e);
    state.loading = false;
    state.error = 'error_carga';
  }
  renderTopbar();
  renderReport();
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
  return alignTxt + rsiTxt + structTxt + srTxt + ` ${t.priceAction.full}` + confluenceTxt;
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
  const { technical: t, fundamentals: f, macro, confluence } = r;
  const risks = [];
  const catalysts = [];

  if (confluence && !confluence.agree) risks.push(`Divergencia entre timeframes: el diario es ${BIAS_LABEL[confluence.dailyBias]} pero el semanal es ${BIAS_LABEL[confluence.weeklyBias]} — la señal de corto plazo puede no sostenerse.`);
  if (confluence && confluence.agree) catalysts.push(`El timeframe semanal confirma la tendencia ${BIAS_LABEL[confluence.dailyBias]} del diario, mayor consistencia entre plazos.`);

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
    <div class="sectiontitle">Gráfico de Precio</div>
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

/* ───────────────────────── render del reporte ───────────────────────── */
function renderReport() {
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
    els.report.innerHTML = `
      <div class="emptycard">
        <div class="emptycard-title">Elegí un activo para ver el informe completo</div>
        <div class="emptycard-body">Buscá por ticker o nombre arriba. El análisis técnico, fundamental, macro, noticias, score y plan operativo se calculan en el momento con datos reales.</div>
      </div>`;
    return;
  }

  const r = state.report;
  const { asset, quote, technical: t, fundamentals: f, news, macro, ccl, score, scoreLabel, confidence, scoreBreakdown, plan, ts, coverageWeight, fullWeight, confluence, marketCorrelation } = r;

  const trendUp = quote.changePct >= 0;
  const trendBg = trendUp ? 'oklch(0.28 0.06 150)' : 'oklch(0.28 0.06 25)';
  const trendColor = trendUp ? 'oklch(0.82 0.11 150)' : 'oklch(0.82 0.11 25)';
  const trendLabel = `${trendUp ? 'Tendencia Alcista' : 'Tendencia Bajista'} (${fmtPct(quote.changePct)})`;

  const deg = Math.round(clampNum(score, 0, 100) / 100 * 360);
  const gaugeGradient = `conic-gradient(oklch(0.72 0.11 85) ${deg}deg, oklch(0.30 0.01 60) ${deg}deg)`;
  const thermoPos = Math.min(97, Math.max(3, score));

  const freshTechnical = freshnessFor(ts.candles, quote.isReal && r.candles.isReal);
  const freshFundamental = f?.hasData ? freshnessFor(ts.fundamentals, f.isReal, { staleAfterMs: 6 * 3600 * 1000 }) : { text: 'Sin cobertura de fundamentales', color: AMBER };
  const freshMacro = macroFreshness(macro);
  const freshNews = freshnessFor(ts.news, news?.isReal, { staleAfterMs: 30 * 60 * 1000 });
  const freshPlan = freshTechnical;
  const planOpacity = (!quote.isReal && !r.candles.isReal) ? 0.55 : 1;

  const { risks, catalysts } = risksAndCatalysts(r);

  const isCedear = asset.category === 'CEDEAR' && asset.ratio;
  const cedearNote = isCedear ? `
    <div class="cedear-note">
      <strong>Referencia CEDEAR (solo informativa):</strong> el análisis completo se realizó sobre ${esc(asset.name)} (${esc(asset.ticker)}) cotizando en USD. El CEDEAR argentino replica esta acción con ratio 1:${asset.ratio}. Equivalente aproximado: ${quote.cedearArs != null ? `AR$${Math.round(quote.cedearArs).toLocaleString('es-AR')} por CEDEAR` : 'N/D'} (CCL ${ccl?.value ? `≈ $${Math.round(ccl.value).toLocaleString('es-AR')}` : 'N/D'}). Ninguna recomendación de esta sección se basa en el precio en pesos.
    </div>` : '';

  els.report.innerHTML = `
    <div class="sectiontitle">Resumen Ejecutivo</div>
    <div class="exec-grid">
      <div class="card exec-card">
        <div class="exec-name-row">
          <div class="exec-name">${esc(asset.name)}</div>
          <div class="exec-tickersector">${esc(asset.ticker)} · ${esc(asset.sector)}</div>
          <button class="star-btn star-btn-lg" id="exec-star" title="Agregar a seguimiento">${isWatched(asset.ticker) ? '★' : '☆'}</button>
        </div>
        <div class="exec-price-row">
          <div class="exec-price">${fmtUsd(quote.usd)}</div>
          <div class="exec-trend" style="background:${trendBg}; color:${trendColor};">${esc(trendLabel)}</div>
        </div>
        <div class="exec-stats">
          <div><div class="exec-stat-label">Confianza</div><div class="exec-stat-value">${esc(confidence)}</div></div>
          <div><div class="exec-stat-label">Horizonte</div><div class="exec-stat-value">${horizonFor(t)}</div></div>
          <div><div class="exec-stat-label">Tendencia primaria</div><div class="exec-stat-value">${esc(t.primaryTrend)}</div></div>
        </div>
      </div>
      <div class="card gauge-card">
        <div class="gauge-ring" style="background:${gaugeGradient};">
          <div class="gauge-inner">
            <div class="gauge-score">${score}</div>
            <div class="gauge-outof">de 100</div>
          </div>
        </div>
        <div class="gauge-label">${esc(scoreLabel)}</div>
      </div>
    </div>

    <div class="card thermo-card">
      <div class="thermo-labels"><span>Venta</span><span>Reducir</span><span>Mantener</span><span>Compra</span><span>Compra Fuerte</span></div>
      <div class="thermo-bar"><div class="thermo-marker" style="left:${thermoPos}%;"></div></div>
      <div class="thermo-valuewrap"><div class="thermo-value" style="left:${thermoPos}%;">${score}</div></div>
    </div>

    <div class="sectiontitle">Gráfico de Precio</div>
    <div class="card chart-card">
      <div class="chart-tabs">
        ${chartTabsForAsset(asset).map(tab => `<button class="chart-tab ${chartState.tf === tab.key ? 'active' : ''}" data-tf="${tab.key}">${tab.label}</button>`).join('')}
      </div>
      ${chartCardBody(t)}
    </div>

    <div class="card score-card">
      <div class="score-card-title">Composición del Score ${coverageWeight < fullWeight ? `<span style="text-transform:none; letter-spacing:0; color:oklch(0.55 0.01 70);">— calculado sobre ${coverageWeight}/${fullWeight} puntos de peso (categorías sin datos excluidas y redistribuidas)</span>` : ''}</div>
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
          <div class="panel-title">Análisis Técnico</div>
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
          <div class="panel-title">Análisis Fundamental</div>
          <div class="freshness" style="color:${freshFundamental.color};"><span class="dot" style="background:${freshFundamental.color};"></span>${esc(freshFundamental.text)}</div>
        </div>
        <div class="card panel-card">
          <div class="metrics-grid">
            ${fundamentalMetricRows(f).map(m => `<div class="metric-row"><span class="metric-label">${esc(m.label)}</span><span class="metric-value">${esc(m.value)}</span></div>`).join('')}
          </div>
          <div class="narrative">${esc(fundamentalNarrative(f, asset.sector))}</div>
        </div>
      </div>
    </div>

    <div class="grid2-macronews">
      <div>
        <div class="panel-header">
          <div class="panel-title">Contexto Macro</div>
          <div class="freshness" style="color:${freshMacro.color};"><span class="dot" style="background:${freshMacro.color};"></span>${esc(freshMacro.text)}</div>
        </div>
        <div class="card macro-card">
          ${macroChips(macro).map(mc => `<div class="macro-chip">${mc.live ? '<span class="macro-chip-live" title="En vivo"></span>' : ''}<span class="macro-chip-label">${esc(mc.label)}: </span><span class="macro-chip-value">${esc(mc.value)}</span>${typeof mc.live === 'string' ? ` <span class="macro-chip-var">(${esc(mc.live)})</span>` : ''}</div>`).join('')}
        </div>
      </div>
      <div>
        <div class="panel-header">
          <div class="panel-title">Noticias Recientes</div>
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
        <div class="sectiontitle">Riesgos</div>
        <div class="card rc-card"><ul class="rc-list">${risks.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>
      <div>
        <div class="sectiontitle">Catalizadores</div>
        <div class="card rc-card"><ul class="rc-list">${catalysts.map(x => `<li>${esc(x)}</li>`).join('')}</ul></div>
      </div>
    </div>

    <div class="panel-header">
      <div class="sectiontitle" style="margin-bottom:0;">Plan Operativo</div>
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
        <div class="plan-footer-item">Probabilidad estimada: <span>${esc(plan.probability)}</span></div>
        <div class="plan-footer-item">Drawdown esperado: <span>${esc(plan.drawdown)}</span></div>
      </div>
    </div>

    <div class="sectiontitle">Conclusión</div>
    <div class="card conclusion-card">
      <div class="conclusion-text">${esc(conclusionText(r))}</div>
    </div>

    ${cedearNote}
  `;

  const starBtn = document.getElementById('exec-star');
  if (starBtn) {
    starBtn.addEventListener('click', () => {
      toggleWatchlist(asset.ticker);
      starBtn.textContent = isWatched(asset.ticker) ? '★' : '☆';
      renderWatchlist();
      loadWatchlistData();
    });
  }

  els.report.querySelectorAll('.chart-tab').forEach(btn => {
    btn.addEventListener('click', () => loadChartTf(btn.dataset.tf));
  });
}

function clampNum(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function horizonFor(t) {
  return t.adx > 22 ? '3–6 meses' : '6–12 meses';
}

function macroFreshness(macro) {
  if (macro?.isReal && macro.liveFetchedAt) return { text: `Riesgo país/dólares en vivo, ${relativeTime(new Date(macro.liveFetchedAt).getTime())}`, color: GREEN };
  if (!macro?.lastUpdated) return { text: 'Sin datos macro', color: RED };
  const ageDays = (Date.now() - new Date(macro.lastUpdated).getTime()) / 86400000;
  if (ageDays > 14) return { text: `Snapshot manual desactualizado (${Math.round(ageDays)}d)`, color: RED };
  if (ageDays > 3) return { text: `Snapshot manual (hace ${Math.round(ageDays)}d)`, color: AMBER };
  return { text: `Snapshot manual (hace ${Math.round(ageDays)}d)`, color: GREEN };
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
    { label: 'OBV', value: t.obvTrend },
    { label: 'Soporte / Resistencia', value: `$${t.support.toFixed(2)} / $${t.resistance.toFixed(2)}` },
    { label: 'Acción de precio', value: t.priceAction.short },
    { label: 'Fibonacci', value: nearestFib ? `${nearestFib[0]} ≈ $${nearestFib[1].toFixed(2)}` : 'N/D' },
    { label: 'Estructura de mercado', value: t.structure.short },
  ];
}

function fundamentalMetricRows(f) {
  if (!f?.hasData) return [{ label: 'Cobertura', value: 'Sin datos fundamentales para este ticker' }];
  const pct = (v) => v == null ? 'N/D' : fmtPct(v);
  const x = (v) => v == null ? 'N/D' : `${v.toFixed(1)}x`;
  return [
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
  if (label === 'Compra Fuerte') return { bg: 'oklch(0.30 0.07 150)', color: 'oklch(0.85 0.10 150)' };
  if (label === 'Compra Moderada') return { bg: 'oklch(0.27 0.05 150)', color: 'oklch(0.78 0.09 150)' };
  if (label === 'Mantener') return { bg: 'oklch(0.28 0.05 85)', color: 'oklch(0.78 0.09 85)' };
  if (label === 'Reducir') return { bg: 'oklch(0.28 0.06 45)', color: 'oklch(0.78 0.10 45)' };
  return { bg: 'oklch(0.28 0.07 25)', color: 'oklch(0.82 0.11 25)' }; // Venta
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

function renderWatchlist() {
  const allTickers = getWatchlist();
  if (!allTickers.length) {
    els.watchlist.innerHTML = `
      <div class="sectiontitle">Seguimiento</div>
      <div class="card watch-empty">Todavía no agregaste activos. Buscá uno y tocá la ☆ para tenerlo siempre a mano acá (máx. ${WATCHLIST_MAX}).</div>`;
    return;
  }
  const tickers = sortAndFilterTickers(allTickers);
  els.watchlist.innerHTML = `
    <div class="panel-header">
      <div class="sectiontitle" style="margin-bottom:0;">Seguimiento</div>
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
      ${!tickers.length ? `<div class="watch-empty">Ningún activo en seguimiento tiene la señal filtrada ahora mismo.</div>` : tickers.map(ticker => {
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
      }).join('')}
    </div>`;

  els.watchlist.querySelectorAll('.watch-card').forEach(el => {
    el.addEventListener('click', (e) => { if (e.target.closest('.watch-remove')) return; selectTicker(el.dataset.ticker); });
  });
  els.watchlist.querySelectorAll('.watch-remove').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const ticker = btn.dataset.remove;
      toggleWatchlist(ticker);
      delete watchState.data[ticker];
      renderWatchlist();
    });
  });

  const sortSel = document.getElementById('watch-sort');
  if (sortSel) sortSel.addEventListener('change', () => {
    watchState.sortBy = sortSel.value;
    lsSetSafe('icp_watch_sort', watchState.sortBy);
    renderWatchlist();
  });
  const filterSel = document.getElementById('watch-filter');
  if (filterSel) filterSel.addEventListener('change', () => {
    watchState.filterSignal = filterSel.value;
    lsSetSafe('icp_watch_filter', watchState.filterSignal);
    renderWatchlist();
  });
  const alertsBtn = document.getElementById('watch-alerts-toggle');
  if (alertsBtn) alertsBtn.addEventListener('click', toggleAlerts);
}

async function loadWatchlistData() {
  const tickers = getWatchlist();
  const macro = await getMacro();
  await Promise.all(tickers.map(async (ticker) => {
    if (watchState.loading.has(ticker)) return;
    watchState.loading.add(ticker);
    renderWatchlist();
    try {
      const asset = await getAsset(ticker);
      const [quote, candles] = await Promise.all([getQuote(ticker), getCandles(ticker, '1day', 220)]);
      const technical = computeTechnical(candles);
      const scoreResult = computeScore({ technical, fundamentals: null, macro: { vix: macro?.vix ?? null, riesgoPaisArg: macro?.riesgoPaisArg ?? null, fearGreed: macro?.fearGreed ?? null }, newsSentiment: null, candles });
      const priceAlert = detectPriceAlert(quote.usd, technical);
      notifyIfNewAlert(ticker, priceAlert);
      watchState.data[ticker] = {
        name: asset?.name ?? ticker, price: quote.usd, changePct: quote.changePct,
        score: scoreResult.score, scoreLabel: scoreResult.scoreLabel, isReal: quote.isReal && candles.isReal,
        alert: priceAlert,
      };
    } catch (e) {
      console.warn('[watchlist] no se pudo cargar', ticker, e.message);
    } finally {
      watchState.loading.delete(ticker);
      renderWatchlist();
    }
  }));
}

/* ───────────────────────── init ───────────────────────── */
renderTopbar();
renderReport();
renderWatchlist();
initSearch();
loadWatchlistData();
setInterval(renderTopbar, 30 * 1000);
setInterval(() => { if (state.asset) renderReport(); }, 30 * 1000); // refresca textos de frescura sin re-fetch
// Ciclos espaciados a propósito: candles/fundamentales/noticias no cambian
// significativamente minuto a minuto, y Twelve Data free tier comparte ~8
// req/min entre todos los que estén usando el sitio a la vez.
setInterval(() => { if (state.asset) loadReport(state.asset.ticker); }, 180 * 1000);
setInterval(loadWatchlistData, 180 * 1000);
