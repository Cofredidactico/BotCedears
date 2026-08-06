/**
 * /api/candles — velas OHLCV para acciones/CEDEARs/ETFs (cripto va aparte,
 * directo a CoinGecko desde dataSource.js).
 *
 * Fuente primaria: Alpaca Markets (plan Basic, gratis, feed IEX) — 200
 * req/min, muy por encima del límite real de Twelve Data (8 req/min
 * COMPARTIDO entre todos los visitantes del sitio), que es el motivo por el
 * que el Dashboard no podía cargar más de un puñado de activos en vivo antes
 * de que el proveedor empezara a fallar. Alpaca es real-time (no demorado)
 * pero solo ve el volumen operado en el propio IEX, no la cinta consolidada
 * — el precio puede diferir levemente de otras fuentes por eso, no es un
 * error (se avisa en la UI donde corresponde).
 *
 * Si todavía no se configuraron las credenciales de Alpaca (ALPACA_KEY_ID /
 * ALPACA_SECRET_KEY en Vercel), se cae automáticamente a Twelve Data para no
 * romper nada mientras se da de alta la cuenta — ver README para el setup.
 */
const ALPACA_DATA = 'https://data.alpaca.markets/v2';
const TD = 'https://api.twelvedata.com';
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

// Yahoo Finance como ÚLTIMO respaldo (gratis, sin API key, cubre acciones Y
// ETFs). Es el que evita que papeles como KO o los ETFs figuren como "demo"
// cuando Alpaca no tiene la credencial cargada y Twelve Data está sin cupo.
const YF_INTERVAL = { '1day': '1d', '1week': '1wk', '1month': '1mo', '1h': '60m', '1min': '1m', '5min': '5m', '15min': '15m' };
function yfRangeFor(interval, n) {
  if (interval === '1month') return '10y';
  if (interval === '1week') return n > 100 ? '5y' : '2y';
  if (interval === '1day') return n > 250 ? '2y' : '1y';
  if (interval === '1min') return '5d';
  if (interval === '5min' || interval === '15min') return '1mo';
  if (interval === '1h') return '3mo';
  return '1y';
}
async function fetchYahooBars(symbol, interval, outputsize) {
  const yfInt = YF_INTERVAL[interval];
  if (!yfInt) throw new Error('yahoo: intervalo no soportado (' + interval + ')');
  const range = yfRangeFor(interval, outputsize);
  const url = `${YF}/${encodeURIComponent(symbol)}?interval=${yfInt}&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': BROWSER_UA } });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const d = await r.json();
  const result = d?.chart?.result?.[0];
  const ts = result?.timestamp;
  const q = result?.indicators?.quote?.[0];
  if (!Array.isArray(ts) || !q) throw new Error('yahoo: sin barras para ' + symbol);
  const o = [], h = [], l = [], c = [], v = [], t = [];
  for (let i = 0; i < ts.length; i++) {
    if (q.close[i] == null) continue; // velas incompletas (feriado parcial, etc.)
    o.push(q.open[i]); h.push(q.high[i]); l.push(q.low[i]); c.push(q.close[i]); v.push(q.volume[i] || 0);
    t.push(new Date(ts[i] * 1000).toISOString().slice(0, 10));
  }
  if (!c.length) throw new Error('yahoo: barras vacías para ' + symbol);
  if (c.length > outputsize) { const s = c.length - outputsize; return { o: o.slice(s), h: h.slice(s), l: l.slice(s), c: c.slice(s), v: v.slice(s), t: t.slice(s) }; }
  return { o, h, l, c, v, t };
}

const ALPACA_TF = {
  '1min': '1Min', '5min': '5Min', '15min': '15Min', '45min': '45Min',
  '1h': '1Hour', '4h': '4Hour',
  '1day': '1Day', '1week': '1Week', '1month': '1Month',
};

function alpacaConfigured() {
  return Boolean(process.env.ALPACA_KEY_ID && process.env.ALPACA_SECRET_KEY);
}

// Solo largos/presencia, nunca el valor — para diagnosticar sin exponer nada
// sensible si las variables no están llegando como se espera al runtime.
function alpacaEnvDebug() {
  const keyId = process.env.ALPACA_KEY_ID ?? null;
  const secret = process.env.ALPACA_SECRET_KEY ?? null;
  return {
    ALPACA_KEY_ID: { present: keyId != null, length: keyId?.length ?? 0, preview: keyId ? keyId.slice(0, 2) + '…' : null },
    ALPACA_SECRET_KEY: { present: secret != null, length: secret?.length ?? 0 },
    allEnvKeysWithAlpaca: Object.keys(process.env).filter(k => k.toUpperCase().includes('ALPACA')),
  };
}

// Alpaca, si no se manda `start` explícito, asume por defecto "desde hoy" —
// no "desde hace mucho hacia atrás" como parecería razonable para pedir las
// últimas N barras. Sin esto devuelve 0 barras la gran mayoría de las veces
// (arrancó devolviendo vacío para todo). Se calcula una fecha de inicio con
// margen generoso (fines de semana/feriados) según el timeframe pedido.
function alpacaStartDate(timeframe, limit) {
  let daysBack;
  if (timeframe.endsWith('Min')) {
    const minutesPerBar = parseInt(timeframe, 10) || 1;
    const barsPerTradingDay = Math.max(1, Math.floor(390 / minutesPerBar)); // ~390min de rueda regular
    daysBack = Math.ceil(limit / barsPerTradingDay) * 2 + 5;
  } else if (timeframe.endsWith('Hour')) {
    const hoursPerBar = parseInt(timeframe, 10) || 1;
    const barsPerTradingDay = Math.max(1, Math.ceil(6.5 / hoursPerBar));
    daysBack = Math.ceil(limit / barsPerTradingDay) * 2 + 5;
  } else if (timeframe === '1Week') {
    daysBack = limit * 8 + 14;
  } else if (timeframe === '1Month') {
    daysBack = limit * 32 + 20;
  } else { // '1Day'
    daysBack = Math.ceil(limit * 1.6) + 15; // ~252 ruedas/año vs 365 días calendario
  }
  daysBack = Math.min(daysBack, 3650);
  return new Date(Date.now() - daysBack * 86400000).toISOString().slice(0, 10);
}

async function fetchAlpacaBars(symbol, timeframe, limit) {
  const start = alpacaStartDate(timeframe, limit);
  const url = `${ALPACA_DATA}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}&sort=desc&feed=iex&adjustment=raw&start=${start}`;
  const r = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    },
  });
  if (!r.ok) {
    // Se incluye el cuerpo de la respuesta (Alpaca manda el motivo real acá,
    // ej. credenciales inválidas o símbolo no soportado por el feed) — con
    // solo el status code no alcanza para diagnosticar.
    const bodyText = await r.text().catch(() => '');
    throw new Error(`alpaca ${r.status}${bodyText ? ': ' + bodyText.slice(0, 300) : ''}`);
  }
  const d = await r.json();
  const bars = Array.isArray(d.bars) ? d.bars : [];
  if (!bars.length) throw new Error('alpaca: sin barras para ' + symbol);
  // sort=desc trae lo más reciente primero — se invierte a orden cronológico.
  const rows = bars.slice().reverse();
  const o = [], h = [], l = [], c = [], v = [], t = [];
  for (const k of rows) { o.push(k.o); h.push(k.h); l.push(k.l); c.push(k.c); v.push(k.v || 0); t.push(String(k.t).slice(0, 10)); }
  return { o, h, l, c, v, t };
}

async function fetchTwelveDataBars(symbol, interval, outputsize) {
  const url = `${TD}/time_series?symbol=${symbol}&interval=${interval}&outputsize=${outputsize}&apikey=${process.env.TWELVEDATA_KEY}`;
  const d = await (await fetch(url)).json();
  if (d.status === 'error' || !Array.isArray(d.values)) throw new Error(d.message || 'sin datos');
  const rows = d.values.slice().reverse();
  const o = [], h = [], l = [], c = [], v = [], t = [];
  for (const k of rows) { o.push(+k.open); h.push(+k.high); l.push(+k.low); c.push(+k.close); v.push(+(k.volume || 0)); t.push(k.datetime); }
  return { o, h, l, c, v, t };
}

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const interval = String(req.query.interval || '1day');
  const outputsize = Math.min(parseInt(req.query.outputsize || '150', 10), 1000);
  const isIntraday = interval === '45min' || interval === '4h' || interval === '1h' || interval === '15min' || interval === '5min' || interval === '1min';
  const alpacaTf = ALPACA_TF[interval];
  const debug = req.query.debug === '1';
  const alpacaEligible = Boolean(alpacaTf && alpacaConfigured());
  let alpacaErrorDetail = null;
  let source = null;

  try {
    // Cadena de proveedores: Alpaca (si hay credenciales) → Twelve Data →
    // Yahoo Finance. Se prueba en orden y se usa el primero que responda; así
    // una fuente caída o sin cobertura (típico de ETFs) ya no manda el papel a
    // "demo" mientras otra tenga el dato real.
    const providers = [];
    if (alpacaEligible) providers.push(['alpaca', () => fetchAlpacaBars(symbol, alpacaTf, outputsize)]);
    providers.push(['twelvedata', () => fetchTwelveDataBars(symbol, interval, outputsize)]);
    providers.push(['yahoo', () => fetchYahooBars(symbol, interval, outputsize)]);

    let data = null, lastErr = null;
    for (const [name, fn] of providers) {
      try { data = await fn(); source = name; lastErr = null; break; }
      catch (e) {
        lastErr = e;
        if (name === 'alpaca') alpacaErrorDetail = e.message;
        console.warn(`[candles] ${name} falló:`, e.message);
      }
    }
    if (!data) throw lastErr || new Error('sin proveedor de velas disponible');
    // Cache de borde de Vercel: absorbe pedidos repetidos del mismo símbolo
    // entre todos los visitantes del sitio dentro de la ventana de cache.
    // En modo debug no se cachea, para no ver una respuesta vieja al probar.
    if (!debug) res.setHeader('Cache-Control', isIntraday ? 's-maxage=300, stale-while-revalidate=600' : 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(debug ? { ...data, _debug: { alpacaConfigured: alpacaConfigured(), alpacaEligible, source, alpacaErrorDetail, env: alpacaEnvDebug() } } : data);
  } catch (e) {
    // Cachear también el error un rato corto: si el proveedor está sin
    // cupo/caído, repetir el mismo pedido fallido enseguida por cada
    // visitante solo empeora las cosas.
    if (!debug) res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(502).json({ error: 'upstream', detail: String(e), ...(debug ? { _debug: { alpacaConfigured: alpacaConfigured(), alpacaEligible, alpacaErrorDetail, env: alpacaEnvDebug() } } : {}) });
  }
}
