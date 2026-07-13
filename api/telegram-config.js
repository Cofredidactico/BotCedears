/**
 * /api/telegram-config — info pública (no secreta) que el frontend necesita
 * para armar el link de vinculación: el @username del bot. Separado de
 * TELEGRAM_BOT_TOKEN (que nunca debe llegar al cliente).
 */
import { kvConfigured, telegramConfigured } from '../alertsStore.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 's-maxage=3600, stale-while-revalidate=7200');
  return res.status(200).json({
    configured: kvConfigured() && telegramConfigured() && Boolean(process.env.TELEGRAM_BOT_USERNAME),
    botUsername: process.env.TELEGRAM_BOT_USERNAME || null,
  });
}
