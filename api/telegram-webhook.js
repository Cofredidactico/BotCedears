/**
 * /api/telegram-webhook — recibe los updates del bot de Telegram.
 * Único mensaje que entiende: "/start CODE" (el deep link que genera el
 * botón "Vincular Telegram" del sitio). Guarda CODE -> chat_id en Redis por
 * 10 minutos; el sitio hace polling de /api/telegram-link-status con ese
 * mismo código hasta que aparece, y ahí guarda el chat_id en localStorage
 * (no hay cuentas de usuario en esta plataforma — el chat_id vinculado
 * cumple ese rol, igual que ya pasa con el resto de las preferencias).
 *
 * Configurar el webhook una sola vez (ver README):
 *   https://api.telegram.org/bot<TOKEN>/setWebhook?url=<deploy>/api/telegram-webhook&secret_token=<TELEGRAM_WEBHOOK_SECRET>
 */
import { kvConfigured, kvSet, sendTelegramMessage, telegramConfigured } from '../alertsStore.js';

const CODE_RE = /^\/start\s+([A-Za-z0-9]{4,12})$/;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });

  // Si se configuró un secret_token al registrar el webhook, Telegram lo
  // manda en este header en cada request — rechazar lo que no lo traiga
  // evita que cualquiera dispare este endpoint haciéndose pasar por Telegram.
  if (process.env.TELEGRAM_WEBHOOK_SECRET) {
    const got = req.headers['x-telegram-bot-api-secret-token'];
    if (got !== process.env.TELEGRAM_WEBHOOK_SECRET) return res.status(401).json({ error: 'secret inválido' });
  }
  if (!kvConfigured() || !telegramConfigured()) return res.status(200).json({ ok: true }); // no romper el webhook aunque falte config

  try {
    const update = req.body || {};
    const msg = update.message;
    const text = String(msg?.text || '').trim();
    const chatId = msg?.chat?.id;
    if (!chatId) return res.status(200).json({ ok: true });

    const m = text.match(CODE_RE);
    if (m) {
      const code = m[1].toUpperCase();
      await kvSet(`tg:code:${code}`, String(chatId), 600);
      await sendTelegramMessage(chatId, '✅ ¡Listo! Tu Telegram quedó vinculado a Investment Copilot AI. Volvé al sitio para elegir qué activos querés seguir.');
    } else {
      await sendTelegramMessage(chatId, 'Para vincular tu cuenta, tocá el botón "Vincular Telegram" en la página de Alertas del sitio — te va a traer acá con el código correcto.');
    }
    return res.status(200).json({ ok: true });
  } catch (e) {
    console.error('[telegram-webhook] error', e.message);
    return res.status(200).json({ ok: true }); // Telegram reintenta si no es 200; un error nuestro no debería generar un loop de reintentos
  }
}
