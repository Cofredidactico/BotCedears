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

async function fetchAlpacaBars(symbol, timeframe, limit) {
  const url = `${ALPACA_DATA}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}&sort=desc&feed=iex&adjustment=raw`;
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
    let data;
    if (alpacaEligible) {
      try {
        data = await fetchAlpacaBars(symbol, alpacaTf, outputsize);
        source = 'alpaca';
      } catch (e) {
        alpacaErrorDetail = e.message;
        console.warn('[candles] Alpaca falló, usando Twelve Data de respaldo:', e.message);
        data = await fetchTwelveDataBars(symbol, interval, outputsize);
        source = 'twelvedata-fallback';
      }
    } else {
      data = await fetchTwelveDataBars(symbol, interval, outputsize);
      source = 'twelvedata';
    }
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
