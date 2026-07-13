/**
 * /api/alerts-subscribe — agrega o quita un ticker de las alertas por
 * Telegram de un chat_id ya vinculado (ver telegram-webhook.js /
 * telegram-link-status.js para cómo se obtiene el chat_id).
 */
import universe from '../universe.json';
import { kvConfigured, subscribeTicker, unsubscribeTicker } from '../alertsStore.js';

const CHATID_RE = /^-?\d{3,15}$/;

export default async function handler(req, res) {
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
