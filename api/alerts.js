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
 *   POST ?action=sync-portfolio   — guarda (ticker, cantidad) de la cartera de un chat_id para el resumen diario
 *   GET  ?action=check&secret=X   — dispara las alertas + resumen diario de cartera (llamado por un cron externo)
 *   GET  ?action=debug&secret=X   — presencia (nunca el valor) de cada env var, para diagnosticar setup
 */
import universe from '../universe.json';
import { computeTechnical } from '../indicators.js';
import { detectPriceAlert } from '../scoring.js';
import {
  kvConfigured, kvGet, kvSet, kvDel, kvSadd, kvSmembers,
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

/** Guarda (ticker, cantidad) de la cartera del usuario, vinculada a su chat
 *  de Telegram, para poder armarle el resumen diario desde el cron. El sitio
 *  la sincroniza automáticamente cuando cambia (la cartera vive en el
 *  localStorage del navegador — el servidor no la conoce de otra forma). */
async function handleSyncPortfolio(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
  if (!kvConfigured()) return res.status(503).json({ error: 'alertas no configuradas' });
  const chatId = String(req.body?.chatId || '');
  if (!CHATID_RE.test(chatId)) return res.status(400).json({ error: 'chatId inválido' });
  const holdings = Array.isArray(req.body?.holdings) ? req.body.holdings : [];
  const clean = holdings
    .map(h => ({ ticker: String(h?.ticker || '').toUpperCase(), shares: Number(h?.shares), unit: h?.unit === 'cedear' ? 'cedear' : 'share' }))
    .filter(h => h.shares > 0 && universe.some(a => a.ticker === h.ticker))
    .slice(0, 25);
  try {
    if (clean.length) {
      await kvSet(`tg:port:${chatId}`, JSON.stringify(clean));
      await kvSadd('tg:portchats', chatId);
    } else {
      await kvDel(`tg:port:${chatId}`);
    }
    return res.status(200).json({ ok: true, count: clean.length });
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
  // Sin confluence semanal acá: exigiría otro fetch por ticker en cada corrida
  // del cron, multiplicando requests. Igual que computeLightSignal en app.js.
  return detectPriceAlert(quote.usd, technical, { recentCloses: candles.c.slice(-3) });
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
        // Solo se avisa por Telegram (y se actualiza el estado rastreado) para
        // alertas confirmadas con confianza alta/media — igual que en el
        // navegador (notifyIfNewAlert). Las "tentativa"/"baja" no molestan
        // por chat, y tampoco pisan el último estado notificado.
        const isStrong = Boolean(curr) && !priceAlert.pending && (priceAlert.confidence === 'alta' || priceAlert.confidence === 'media');
        const chatIds = await kvSmembers(`tg:subscribers:${ticker}`);
        for (const chatId of chatIds) {
          const prev = (await kvGet(`tg:last:${chatId}:${ticker}`)) || '';
          if (!isStrong) {
            if (!curr && prev) await kvSet(`tg:last:${chatId}:${ticker}`, '');
            continue;
          }
          if (curr === prev) continue;
          await kvSet(`tg:last:${chatId}:${ticker}`, curr);
          const confirmText = priceAlert.confirmations?.length ? `\n<i>Confirmaciones: ${priceAlert.confirmations.join(', ')}</i>` : '';
          await sendTelegramMessage(chatId, ALERT_TEXT[curr].replace('{ticker}', ticker) + confirmText);
          alertsSent++;
        }
      } catch (e) {
        errors.push(`${ticker}: ${e.message}`);
      }
    }

    // Resumen diario de cartera: una vez por día (UTC) por cada chat que haya
    // sincronizado su cartera desde el sitio — solo cotizaciones (valor y
    // variación del día), sin recalcular señales para no recargar el cron.
    let digestsSent = 0;
    const today = new Date().toISOString().slice(0, 10);
    const quoteCache = {};
    const portChats = await kvSmembers('tg:portchats');
    for (const chatId of portChats) {
      try {
        if ((await kvGet(`tg:digest:${chatId}`)) === today) continue;
        const raw = await kvGet(`tg:port:${chatId}`);
        if (!raw) continue;
        const holdings = JSON.parse(raw);
        if (!Array.isArray(holdings) || !holdings.length) continue;
        const lines = [];
        let totalUsd = 0, totalArs = 0, allHaveArs = true;
        for (const h of holdings.slice(0, 25)) {
          quoteCache[h.ticker] ??= await fetch(`${baseUrl}/api/quote?symbol=${h.ticker}`).then(r => r.json()).catch(() => null);
          const q = quoteCache[h.ticker];
          if (!q || q.error || q.usd == null) continue;
          // La cantidad puede ser CEDEARs (costo en ARS) o acciones (costo en
          // USD) — el ratio real del universo convierte entre unidades.
          const ratio = universe.find(a => a.ticker === h.ticker)?.ratio ?? null;
          const isCedear = h.unit === 'cedear' && ratio;
          const val = isCedear ? (q.usd / ratio) * h.shares : q.usd * h.shares;
          totalUsd += val;
          if (q.cedearArs != null && (isCedear || ratio)) totalArs += isCedear ? q.cedearArs * h.shares : q.cedearArs * ratio * h.shares;
          else allHaveArs = false;
          lines.push({ ticker: h.ticker, val, changePct: q.changePct ?? 0 });
        }
        if (!lines.length || totalUsd <= 0) continue;
        const weightedDay = lines.reduce((s, l) => s + (l.val / totalUsd) * l.changePct, 0);
        lines.sort((a, b) => b.val - a.val);
        const fmtU = (n) => 'US$' + Math.round(n).toLocaleString('en-US');
        const fmtA = (n) => 'AR$' + Math.round(n).toLocaleString('es-AR');
        const sign = (n) => (n >= 0 ? '+' : '') + n.toFixed(1) + '%';
        const msg = [
          '📊 <b>Resumen diario de tu cartera</b> — Investment Copilot AI',
          `Valor: ${fmtU(totalUsd)}${allHaveArs && totalArs > 0 ? ` · ${fmtA(totalArs)} (CEDEAR)` : ''}`,
          `Variación del día (ponderada): ${sign(weightedDay)}`,
          '',
          ...lines.map(l => `${l.changePct >= 0 ? '🟢' : '🔴'} <b>${l.ticker}</b> ${fmtU(l.val)} · ${sign(l.changePct)} hoy`),
        ].join('\n');
        await sendTelegramMessage(chatId, msg);
        await kvSet(`tg:digest:${chatId}`, today, 172800);
        digestsSent++;
      } catch (e) {
        errors.push(`digest ${chatId}: ${e.message}`);
      }
    }

    return res.status(200).json({ checked, alertsSent, digestsSent, errors: errors.slice(0, 10) });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}

// Solo presencia/largo, nunca el valor — mismo criterio que el ?debug=1 de
// api/candles.js, para diagnosticar setup de env vars sin exponer secretos.
function handleDebug(req, res) {
  if (!process.env.CRON_SECRET || req.query.secret !== process.env.CRON_SECRET) return res.status(401).json({ error: 'secret inválido' });
  const present = (name) => {
    const v = process.env[name];
    return { present: v != null && v !== '', length: v?.length ?? 0 };
  };
  return res.status(200).json({
    KV_REST_API_URL: present('KV_REST_API_URL'),
    KV_REST_API_TOKEN: present('KV_REST_API_TOKEN'),
    UPSTASH_REDIS_REST_URL: present('UPSTASH_REDIS_REST_URL'),
    UPSTASH_REDIS_REST_TOKEN: present('UPSTASH_REDIS_REST_TOKEN'),
    TELEGRAM_BOT_TOKEN: present('TELEGRAM_BOT_TOKEN'),
    TELEGRAM_BOT_USERNAME: { present: Boolean(process.env.TELEGRAM_BOT_USERNAME), value: process.env.TELEGRAM_BOT_USERNAME || null },
    TELEGRAM_WEBHOOK_SECRET: present('TELEGRAM_WEBHOOK_SECRET'),
    ANTHROPIC_API_KEY: present('ANTHROPIC_API_KEY'),
    allEnvKeysWithRedisOrTelegramOrAnthropic: Object.keys(process.env).filter(k => /REDIS|KV_|TELEGRAM|ANTHROPIC/i.test(k)),
  });
}

export default async function handler(req, res) {
  switch (req.query.action) {
    case 'webhook': return handleWebhook(req, res);
    case 'config': return handleConfig(req, res);
    case 'link-status': return handleLinkStatus(req, res);
    case 'subscribe': return handleSubscribe(req, res);
    case 'subscriptions': return handleSubscriptions(req, res);
    case 'sync-portfolio': return handleSyncPortfolio(req, res);
    case 'check': return handleCheck(req, res);
    case 'debug': return handleDebug(req, res);
    default: return res.status(400).json({ error: 'falta ?action= o valor inválido' });
  }
}
