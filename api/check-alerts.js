/**
 * /api/check-alerts?secret=CRON_SECRET — dispara las alertas por Telegram
 * para todos los tickers con al menos un suscriptor. Pensado para que lo
 * llame un cron EXTERNO gratuito (ej. cron-job.org) cada 5-15 min — Vercel
 * Cron en el plan Hobby gratuito solo permite 1 corrida por día, demasiado
 * lento para avisar "entró en zona de compra" con algo de utilidad.
 *
 * Reusa los propios endpoints /api/quote y /api/candles (mismo proveedor,
 * mismo fallback, misma caché de borde) en vez de duplicar lógica de
 * proveedor acá — construye la URL absoluta con el host de la propia
 * request, ya que corre en la misma deployment.
 */
import { computeTechnical } from '../indicators.js';
import { detectPriceAlert } from '../scoring.js';
import { kvConfigured, kvSmembers, kvGet, kvSet, telegramConfigured, sendTelegramMessage } from '../alertsStore.js';

const ALERT_TEXT = {
  buy: '🟢 <b>{ticker}</b> entró en zona de compra según el análisis técnico de Investment Copilot AI.',
  sell: '🟡 <b>{ticker}</b> entró en zona de venta según el análisis técnico de Investment Copilot AI.',
  stop: '🔴 <b>{ticker}</b> tocó el stop loss según el análisis técnico de Investment Copilot AI.',
};

async function checkTicker(baseUrl, ticker) {
  const [quote, candles] = await Promise.all([
    fetch(`${baseUrl}/api/quote?symbol=${ticker}`).then(r => r.json()),
    fetch(`${baseUrl}/api/candles?symbol=${ticker}&interval=1day&outputsize=200`).then(r => r.json()),
  ]);
  if (quote?.error || candles?.error || !candles?.c?.length) return null;
  const technical = computeTechnical(candles);
  return detectPriceAlert(quote.usd, technical);
}

export default async function handler(req, res) {
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'secret inválido' });
  if (!kvConfigured() || !telegramConfigured()) return res.status(503).json({ error: 'alertas no configuradas' });

  const baseUrl = `https://${req.headers.host}`;
  let checked = 0, alertsSent = 0;
  const errors = [];

  try {
    const tickers = await kvSmembers('tg:tickers');
    for (const ticker of tickers) {
      checked++;
      try {
        const priceAlert = await checkTicker(baseUrl, ticker);
        const curr = priceAlert?.type ?? '';
        const chatIds = await kvSmembers(`tg:subscribers:${ticker}`);
        for (const chatId of chatIds) {
          const prev = (await kvGet(`tg:last:${chatId}:${ticker}`)) || '';
          if (curr === prev) continue;
          await kvSet(`tg:last:${chatId}:${ticker}`, curr);
          if (curr) {
            await sendTelegramMessage(chatId, ALERT_TEXT[curr].replace('{ticker}', ticker));
            alertsSent++;
          }
        }
      } catch (e) {
        errors.push(`${ticker}: ${e.message}`);
      }
    }
    return res.status(200).json({ checked, alertsSent, errors: errors.slice(0, 10) });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
