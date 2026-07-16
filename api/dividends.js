/**
 * /api/dividends?symbol=X — historial real de dividendos + próximo ex-dividend.
 *
 * Fuente primaria: Yahoo Finance chart con events=div (gratis, sin API key,
 * devuelve la fecha ex-dividend real y el monto de cada pago). Se migró desde
 * Finnhub porque su endpoint stock/dividend es PREMIUM: en el free tier
 * devolvía siempre vacío, así que en producción los dividendos nunca
 * aparecían. Finnhub queda como respaldo por si Yahoo bloquea el request.
 *
 * El próximo ex-dividend NO viene de una fuente que lo garantice: se PROYECTA
 * a partir de la cadencia histórica real (mediana de los intervalos entre
 * pagos) y se marca como estimado — no se presenta como una fecha confirmada.
 */
const FINNHUB = 'https://finnhub.io/api/v1';
const YF = 'https://query1.finance.yahoo.com/v8/finance/chart';
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

const DAY = 86400;

function median(nums) {
  if (!nums.length) return null;
  const s = nums.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Etiqueta de frecuencia a partir de la mediana de días entre pagos.
function frequencyLabel(medianDays) {
  if (medianDays == null) return null;
  if (medianDays >= 25 && medianDays <= 35) return { label: 'Mensual', perYear: 12 };
  if (medianDays >= 80 && medianDays <= 100) return { label: 'Trimestral', perYear: 4 };
  if (medianDays >= 160 && medianDays <= 200) return { label: 'Semestral', perYear: 2 };
  if (medianDays >= 330 && medianDays <= 400) return { label: 'Anual', perYear: 1 };
  return { label: 'Irregular', perYear: null };
}

function enrich(rawRows) {
  // rawRows: [{ date: epochSeconds, amount }] ascendente
  const rows = rawRows.filter(r => r.date && r.amount > 0).sort((a, b) => a.date - b.date);
  if (!rows.length) return { items: [], frequency: null, medianIntervalDays: null, ttm: 0, nextExDate: null, nextExEstimated: true, lastAmount: null, cagr3y: null };

  const dates = rows.map(r => r.date);
  const intervals = [];
  for (let i = 1; i < dates.length; i++) intervals.push((dates[i] - dates[i - 1]) / DAY);
  const medDays = median(intervals);
  const freq = frequencyLabel(medDays);

  const nowSec = Date.now() / 1000;
  const ttm = rows.filter(r => r.date >= nowSec - 365 * DAY).reduce((s, r) => s + r.amount, 0);

  // Próximo ex-dividend proyectado: se avanza desde el último ex conocido por
  // el intervalo mediano hasta caer en el futuro (o dentro de los últimos días,
  // por si el ex ya pasó pero el pago no).
  let nextExDate = null;
  if (medDays && medDays > 0) {
    let t = dates[dates.length - 1];
    let guard = 0;
    while (t < nowSec && guard < 24) { t += medDays * DAY; guard++; }
    nextExDate = new Date(t * 1000).toISOString().slice(0, 10);
  }

  // CAGR del dividendo: compara el total pagado en los últimos 12 meses contra
  // el de hace ~3 años, si hay suficiente historial (crecimiento del pago).
  let cagr3y = null;
  const oldWindow = rows.filter(r => r.date >= nowSec - 3.5 * 365 * DAY && r.date < nowSec - 2.5 * 365 * DAY).reduce((s, r) => s + r.amount, 0);
  if (oldWindow > 0 && ttm > 0) cagr3y = (Math.pow(ttm / oldWindow, 1 / 3) - 1) * 100;

  return {
    items: rows.map(r => ({ date: new Date(r.date * 1000).toISOString().slice(0, 10), amount: r.amount })).reverse(),
    frequency: freq?.label ?? null,
    perYear: freq?.perYear ?? null,
    medianIntervalDays: medDays != null ? Math.round(medDays) : null,
    ttm,
    nextExDate,
    nextExEstimated: true,
    lastAmount: rows[rows.length - 1].amount,
    lastExDate: new Date(dates[dates.length - 1] * 1000).toISOString().slice(0, 10),
    cagr3y,
  };
}

async function fromYahoo(symbol) {
  const r = await fetch(`${YF}/${encodeURIComponent(symbol)}?interval=1d&range=3y&events=div`, { headers: { 'User-Agent': BROWSER_UA } });
  if (!r.ok) throw new Error('yahoo ' + r.status);
  const d = await r.json();
  const res = d?.chart?.result?.[0];
  const ev = res?.events?.dividends;
  const rows = ev ? Object.values(ev).map(x => ({ date: x.date, amount: x.amount })) : [];
  return enrich(rows);
}

async function fromFinnhub(symbol) {
  const from = new Date(); from.setFullYear(from.getFullYear() - 3);
  const to = new Date();
  const fmt = (dt) => dt.toISOString().slice(0, 10);
  const r = await fetch(`${FINNHUB}/stock/dividend?symbol=${symbol}&from=${fmt(from)}&to=${fmt(to)}&token=${process.env.FINNHUB_KEY}`);
  const d = await r.json();
  if (!Array.isArray(d)) return enrich([]);
  const rows = d.map(x => ({ date: x.date ? Math.floor(new Date(x.date + 'T00:00:00Z').getTime() / 1000) : null, amount: x.amount })).filter(x => x.date);
  return enrich(rows);
}

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  if (!symbol) return res.status(400).json({ error: 'falta symbol' });

  try {
    let data;
    try {
      data = await fromYahoo(symbol);
    } catch (e) {
      // Yahoo bloqueó o falló: intentar Finnhub (aunque el free tier suele venir vacío).
      data = await fromFinnhub(symbol);
    }
    res.setHeader('Cache-Control', 's-maxage=21600, stale-while-revalidate=43200');
    return res.status(200).json(data);
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
