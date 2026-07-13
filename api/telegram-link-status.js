/**
 * /api/telegram-link-status?code=CODE — el sitio hace polling acá cada
 * pocos segundos después de mostrar el link de vinculación, hasta que
 * telegram-webhook.js haya guardado el código (cuando el usuario mandó
 * /start CODE al bot). Se borra al leerse: es de un solo uso.
 */
import { kvConfigured, kvGet, kvDel } from '../alertsStore.js';

const CODE_RE = /^[A-Za-z0-9]{4,12}$/;

export default async function handler(req, res) {
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
