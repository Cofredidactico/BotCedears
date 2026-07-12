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

async function fetchAlpacaBars(symbol, timeframe, limit) {
  const url = `${ALPACA_DATA}/stocks/${encodeURIComponent(symbol)}/bars?timeframe=${timeframe}&limit=${limit}&sort=desc&feed=iex&adjustment=raw`;
  const r = await fetch(url, {
    headers: {
      'APCA-API-KEY-ID': process.env.ALPACA_KEY_ID,
      'APCA-API-SECRET-KEY': process.env.ALPACA_SECRET_KEY,
    },
  });
  if (!r.ok) throw new Error('alpaca ' + r.status);
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

  try {
    let data;
    if (alpacaTf && alpacaConfigured()) {
      try {
        data = await fetchAlpacaBars(symbol, alpacaTf, outputsize);
      } catch (e) {
        console.warn('[candles] Alpaca falló, usando Twelve Data de respaldo:', e.message);
        data = await fetchTwelveDataBars(symbol, interval, outputsize);
      }
    } else {
      data = await fetchTwelveDataBars(symbol, interval, outputsize);
    }
    // Cache de borde de Vercel: absorbe pedidos repetidos del mismo símbolo
    // entre todos los visitantes del sitio dentro de la ventana de cache.
    res.setHeader('Cache-Control', isIntraday ? 's-maxage=300, stale-while-revalidate=600' : 's-maxage=1800, stale-while-revalidate=3600');
    return res.status(200).json(data);
  } catch (e) {
    // Cachear también el error un rato corto: si el proveedor está sin
    // cupo/caído, repetir el mismo pedido fallido enseguida por cada
    // visitante solo empeora las cosas.
    res.setHeader('Cache-Control', 's-maxage=60, stale-while-revalidate=120');
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
