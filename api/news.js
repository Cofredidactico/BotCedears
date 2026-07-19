/**
 * /api/news?symbol=X — noticias + sentimiento reales vía Finnhub.
 * `news-sentiment` da el score agregado (usado en el score compuesto).
 * `company-news` da los titulares; como Finnhub free tier no etiqueta cada
 * titular individualmente, se clasifica cada uno con un heurístico simple de
 * palabras clave — se documenta como heurístico, no como IA de sentimiento.
 */
const FINNHUB = 'https://finnhub.io/api/v1';

const POS_WORDS = ['beat', 'beats', 'surge', 'record', 'upgrade', 'buyback', 'growth', 'strong', 'expansion', 'raises', 'raised', 'profit', 'gain', 'rally', 'outperform'];
const NEG_WORDS = ['miss', 'misses', 'downgrade', 'lawsuit', 'recall', 'decline', 'plunge', 'weak', 'cut', 'layoff', 'probe', 'investigation', 'fraud', 'loss', 'warns', 'warning'];

function tagHeadline(text) {
  const t = (text || '').toLowerCase();
  let score = 0;
  for (const w of POS_WORDS) if (t.includes(w)) score++;
  for (const w of NEG_WORDS) if (t.includes(w)) score--;
  if (score >= 2) return { tag: 'Muy Positiva', bg: 'oklch(0.32 0.07 150)', color: 'oklch(0.88 0.11 150)' };
  if (score === 1) return { tag: 'Positiva', bg: 'oklch(0.30 0.06 150)', color: 'oklch(0.85 0.10 150)' };
  if (score === -1) return { tag: 'Negativa', bg: 'oklch(0.30 0.07 25)', color: 'oklch(0.82 0.11 25)' };
  if (score <= -2) return { tag: 'Muy Negativa', bg: 'oklch(0.28 0.09 25)', color: 'oklch(0.86 0.13 25)' };
  return { tag: 'Neutral', bg: 'oklch(0.30 0.005 70)', color: 'oklch(0.75 0.01 70)' };
}

function fmtDate(d) {
  return d.toISOString().slice(0, 10);
}

// Traducción de titulares al español vía el endpoint gratuito de Google
// Translate (sin API key). Se traducen todos los titulares en UNA sola
// llamada uniéndolos con saltos de línea (Google los preserva como segmentos
// separados). Si algo falla o la cantidad de líneas no coincide, se devuelven
// los originales en inglés — nunca se rompe la carga de noticias por esto.
async function translateHeadlines(texts) {
  if (!texts.length) return texts;
  try {
    const joined = texts.join('\n');
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=es&dt=t&q=${encodeURIComponent(joined)}`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return texts;
    const d = await r.json();
    const segs = Array.isArray(d?.[0]) ? d[0] : [];
    const full = segs.map(s => s?.[0] ?? '').join('');
    const lines = full.split('\n');
    // Solo se usa la traducción si mantiene la misma cantidad de titulares
    // (si Google fusionó/partió líneas, se cae al original para no desalinear).
    if (lines.length === texts.length) return lines.map((l, i) => l.trim() || texts[i]);
    return texts;
  } catch (_) {
    return texts;
  }
}

export default async function handler(req, res) {
  const symbol = String(req.query.symbol || '').toUpperCase();
  const general = req.query.general === '1';
  if (!symbol && !general) return res.status(400).json({ error: 'falta symbol' });

  try {
    if (general) {
      // Noticias generales del mercado (no ligadas a un ticker) — para la
      // página de Noticias & Macro. Finnhub no da sentimiento agregado para
      // esta categoría, así que va sin sentimentScore.
      const r = await fetch(`${FINNHUB}/news?category=general&token=${process.env.FINNHUB_KEY}`);
      const raw = r.ok ? await r.json() : [];
      const picked = (Array.isArray(raw) ? raw : [])
        .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
        .slice(0, 14);
      const translated = await translateHeadlines(picked.map(n => n.headline || ''));
      const items = picked.map((n, i) => ({
        ...tagHeadline(n.headline), // sentimiento sobre el titular original en inglés
        text: translated[i], textEn: n.headline, source: n.source, url: n.url, datetime: n.datetime,
      }));
      res.setHeader('Cache-Control', 's-maxage=600, stale-while-revalidate=1200');
      return res.status(200).json({ items, sentimentScore: null });
    }

    const to = new Date();
    const from = new Date(to.getTime() - 14 * 24 * 3600 * 1000);
    const [newsRes, sentRes] = await Promise.all([
      fetch(`${FINNHUB}/company-news?symbol=${symbol}&from=${fmtDate(from)}&to=${fmtDate(to)}&token=${process.env.FINNHUB_KEY}`),
      fetch(`${FINNHUB}/news-sentiment?symbol=${symbol}&token=${process.env.FINNHUB_KEY}`),
    ]);
    const newsRaw = newsRes.ok ? await newsRes.json() : [];
    const sentRaw = sentRes.ok ? await sentRes.json() : null;

    const picked = (Array.isArray(newsRaw) ? newsRaw : [])
      .sort((a, b) => (b.datetime || 0) - (a.datetime || 0))
      .slice(0, 6);
    const translated = await translateHeadlines(picked.map(n => n.headline || ''));
    const items = picked.map((n, i) => ({
      ...tagHeadline(n.headline), // sentimiento sobre el titular original en inglés
      text: translated[i], textEn: n.headline, source: n.source, url: n.url, datetime: n.datetime,
    }));

    const bullishPercent = sentRaw?.sentiment?.bullishPercent;
    const sentimentScore = typeof bullishPercent === 'number' ? bullishPercent : null;

    res.setHeader('Cache-Control', 's-maxage=900, stale-while-revalidate=1800');
    return res.status(200).json({ items, sentimentScore });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
