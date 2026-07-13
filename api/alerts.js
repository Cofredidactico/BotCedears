/**
 * /api/alerts — todos los endpoints de Alertas por Telegram, en un solo
 * archivo enrutado por ?action=. El plan Hobby de Vercel tiene un tope de
 * 12 funciones serverless por deployment; separar cada operación en su
 * propio archivo (como se hizo originalmente) lo superaba. La lógica de
 * cada acción es la misma, solo agrupada — nada cambia en el comportamiento.
 *
 * Acciones:
 *   POST ?action=webhook          — recibe updates del bot de Telegram (registrar como URL del webhook)
 *   GET  ?action=config           — info pública (bot username) para armar el link de vinculación
 *   GET  ?action=link-status&code=X    — polling del sitio hasta que el código se vincule a un chat_id
 *   POST ?action=subscribe        — agregar/quitar un ticker de las alertas de un chat_id
 *   GET  ?action=subscriptions&chatId=X — lista de tickers suscriptos de un chat_id
 *   GET  ?action=check&secret=X   — dispara las alertas (llamado por un cron externo)
 */
import universe from '../universe.json';
import { computeTechnical } from '../indicators.js';
import { detectPriceAlert } from '../scoring.js';
import {
  kvConfigured, kvGet, kvSet, kvDel, kvSmembers,
  subscribeTicker, unsubscribeTicker, telegramConfigured, sendTelegramMessage,
} from '../alertsStore.js';

const CODE_RE = /^[A-Za-z0-9]{4,12}$/;
const START_RE = /^\/start\s+([A-Za-z0-9]{4,12})$/;
const CHATID_RE = /^-?\d{3,15}$/;

async function handleWebhook(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ error: 'secret inválido' });
  }
  if (!kvConfigured() || !telegramConfigured()) return res.status(200).json({ ok: true });

  try {
    const update = req.body || {};
    const msg = update.message;
    const text = String(msg?.text || '').trim();
    const chatId = msg?.chat?.id;
    if (!chatId) return res.status(200).json({ ok: true });

    const m = text.match(START_RE);
    if (m) {
      const code = m[1].toUpperCase();
      await kvSet(`tg:code:${code}`, String(chatId), 600);
      await sendTelegramMessage(chatId, '✅ ¡Listo! Tu Telegram quedó vinculado a Investment Copilot AI. Volvé al sitio para elegir qué activos querés seguir.');
    } else {
      await sendTelegramMessage(chatId, 'Para vincular tu cuenta, tocá el botón "Vincular Telegram" en la página de Alertas del sitio — te va a traer acá con el código correcto.');
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[alerts:webhook] error', e.message);
    return res.status(200).json({ ok: true });
  }
}

async function handleConfig(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  return res.status(200).json({
    configured: kvConfigured() && telegramConfigured() && Boolean(process.env.TELEGRAM_BOT_USERNAME),
    botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
  });
}

async function handleLinkStatus(req, res) {
  if (!kvConfigured()) return res.status(503).json({ error: 'alertas no configuradas', detail: 'falta KV_REST_API_URL / KV_REST_API_TOKEN en el servidor' });
  const code = String(req.query.code || '').toUpperCase();
  if (!CODE_RE.test(code)) return res.status(400).json({ error: 'código inválido' });
  try {
    const chatId = await kvGet(`tg:code:${code}`);
    if (chatId) await kvDel(`tg:code:${code}`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ chatId: chatId || null });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}

async function handleSubscribe(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
  if (!kvConfigured()) return res.status(503).json({ error: 'alertas no configuradas', detail: 'falta KV_REST_API_URL / KV_REST_API_TOKEN en el servidor' });
  const chatId = String(req.body?.chatId || '');
  const ticker = String(req.body?.ticker || '').toUpperCase();
  const action = req.body?.action === 'remove' ? 'remove' : 'add';
  if (!CHATID_RE.test(chatId)) return res.status(400).json({ error: 'chatId inválido' });
  if (!universe.some(a => a.ticker === ticker)) return res.status(400).json({ error: 'ticker desconocido' });
  try {
    if (action === 'add') await subscribeTicker(chatId, ticker);
    else await unsubscribeTicker(chatId, ticker);
    return res.status(200).json({ ok: true, ticker, action });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}

async function handleSubscriptions(req, res) {
  if (!kvConfigured()) return res.status(503).json({ error: 'alertas no configuradas', detail: 'falta KV_REST_API_URL / KV_REST_API_TOKEN en el servidor' });
  const chatId = String(req.query.chatId || '');
  if (!CHATID_RE.test(chatId)) return res.status(400).json({ error: 'chatId inválido' });
  try {
    const tickers = await kvSmembers(`tg:sub:${chatId}`);
    res.setHeader('Cache-Control', 'no-store');
    return res.status(200).json({ tickers });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}

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

async function handleCheck(req, res) {
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

export default async function handler(req, res) {
  switch (req.query.action) {
    case 'webhook': return handleWebhook(req, res);
    case 'config': return handleConfig(req, res);
    case 'link-status': return handleLinkStatus(req, res);
    case 'subscribe': return handleSubscribe(req, res);
    case 'subscriptions': return handleSubscriptions(req, res);
    case 'check': return handleCheck(req, res);
    default: return res.status(400).json({ error: 'falta ?action= o valor inválido' });
  }
}
