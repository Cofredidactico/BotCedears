/**
 * alertsStore.js — helpers compartidos por los endpoints de alertas por
 * Telegram (api/telegram-webhook.js, api/alerts-subscribe.js,
 * api/alerts-subscriptions.js, api/telegram-link-status.js,
 * api/check-alerts.js).
 *
 * Storage: Upstash Redis (REST API, plan gratis) — es lo único con estado
 * que sobrevive entre invocaciones de funciones serverless sin tabla
 * propia; todo lo demás en este proyecto vive en localStorage del
 * navegador, que no sirve para avisar con la pestaña cerrada.
 * Requiere el par de credenciales REST (ver README) — sin ellas,
 * kvConfigured() da false y los endpoints devuelven 503 en vez de romper
 * el resto del sitio.
 *
 * Vercel expone estas credenciales bajo DOS convenciones de nombre según
 * cómo se haya conectado la base (producto "Vercel KV" legacy vs.
 * integración nativa de Upstash del Marketplace) — se acepta cualquiera de
 * las dos para no depender de cuál eligió el usuario:
 *   KV_REST_API_URL / KV_REST_API_TOKEN               (Vercel KV, legacy)
 *   UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN  (Upstash nativo)
 *
 * Claves usadas:
 *   tg:code:<CODE>            -> chatId (TTL 600s, se borra al leerse)
 *   tg:sub:<chatId>           -> Set de tickers que ese chat sigue
 *   tg:subscribers:<TICKER>   -> Set de chatIds que siguen ese ticker
 *   tg:tickers                -> Set de todos los tickers con >=1 suscriptor
 *   tg:last:<chatId>:<TICKER> -> última señal notificada ('buy'|'sell'|'stop'|'')
 */

function kvUrl() {
  return process.env.KV_REST_API_URL || process.env.UPSTASH_REDIS_REST_URL || null;
}
function kvToken() {
  return process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN || null;
}

export function kvConfigured() {
  return Boolean(kvUrl() && kvToken());
}

async function kvCommand(parts) {
  const url = `${kvUrl()}/${parts.map(encodeURIComponent).join('/')}`;
  const r = await fetch(url, { headers: { Authorization: `Bearer ${kvToken()}` } });
  if (!r.ok) throw new Error(`kv ${r.status}: ${await r.text().catch(() => '')}`);
  const d = await r.json();
  return d.result;
}

export const kvGet = (key) => kvCommand(['get', key]);
export const kvSet = (key, value, exSeconds) => kvCommand(exSeconds ? ['set', key, value, 'EX', String(exSeconds)] : ['set', key, value]);
export const kvDel = (key) => kvCommand(['del', key]);
export const kvSadd = (key, member) => kvCommand(['sadd', key, member]);
export const kvSrem = (key, member) => kvCommand(['srem', key, member]);
export const kvSmembers = (key) => kvCommand(['smembers', key]).then(r => Array.isArray(r) ? r : []);
export const kvScard = (key) => kvCommand(['scard', key]);

export async function subscribeTicker(chatId, ticker) {
  await Promise.all([kvSadd(`tg:sub:${chatId}`, ticker), kvSadd(`tg:subscribers:${ticker}`, chatId)]);
  await kvSadd('tg:tickers', ticker);
}

export async function unsubscribeTicker(chatId, ticker) {
  await Promise.all([kvSrem(`tg:sub:${chatId}`, ticker), kvSrem(`tg:subscribers:${ticker}`, chatId)]);
  await kvDel(`tg:last:${chatId}:${ticker}`);
  const remaining = await kvScard(`tg:subscribers:${ticker}`);
  if (!remaining) await kvSrem('tg:tickers', ticker);
}

export function telegramConfigured() {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

export async function sendTelegramMessage(chatId, text) {
  const url = `https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' }),
  });
  if (!r.ok) throw new Error(`telegram ${r.status}: ${await r.text().catch(() => '')}`);
  return r.json();
}
