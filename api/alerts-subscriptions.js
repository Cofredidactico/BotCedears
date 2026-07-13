/**
 * /api/alerts-subscriptions?chatId=X — lista los tickers que ese chat_id
 * tiene suscriptos a alertas por Telegram. El sitio la usa para reflejar
 * el estado real guardado en Redis (no confía solo en localStorage, que
 * podría estar desincronizado si el usuario vinculó desde otro dispositivo).
 */
import { kvConfigured, kvSmembers } from '../alertsStore.js';

const CHATID_RE = /^-?\d{3,15}$/;

export default async function handler(req, res) {
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
