/**
 * /api/macro — snapshot macro en vivo, sin necesidad de key para la mayoría:
 *  - Riesgo país Argentina: mercados.ambito.com (público, sin key)
 *  - Dólares (oficial/blue/MEP/CCL): dolarapi.com (público, sin key)
 *  - Fear & Greed cripto: alternative.me (público, sin key)
 *  - VIX/DXY: best-effort vía Twelve Data (si hay TWELVEDATA_KEY) — si falla,
 *    el front cae al valor manual de macro.json para esos dos campos puntuales.
 * Cada fuente se pide en paralelo y se degrada de forma independiente: si una
 * cae, las demás igual responden.
 */
const TD = 'https://api.twelvedata.com';

// Algunos sitios (ej. Ámbito) filtran requests sin un User-Agent de navegador
// — desde IPs de datacenter (como las de Vercel) responden distinto que desde
// un browser normal. Se manda uno genérico para no quedar bloqueados.
const BROWSER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';

async function safeJson(url, opts) {
  try {
    const r = await fetch(url, { ...opts, headers: { 'User-Agent': BROWSER_UA, ...(opts?.headers ?? {}) } });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

function parseArNumber(s) {
  if (s == null) return null;
  const n = parseFloat(String(s).replace(/\./g, '').replace(',', '.'));
  return isNaN(n) ? null : n;
}

export default async function handler(req, res) {
  const [riesgoPais, dolares, fng, vixQ, dxyQ] = await Promise.all([
    safeJson('https://mercados.ambito.com/riesgopais/variacion'),
    safeJson('https://dolarapi.com/v1/dolares'),
    safeJson('https://api.alternative.me/fng/?limit=1'),
    process.env.TWELVEDATA_KEY ? safeJson(`${TD}/quote?symbol=VIX&apikey=${process.env.TWELVEDATA_KEY}`) : null,
    process.env.TWELVEDATA_KEY ? safeJson(`${TD}/quote?symbol=DXY&apikey=${process.env.TWELVEDATA_KEY}`) : null,
  ]);

  const dolaresByHouse = {};
  if (Array.isArray(dolares)) for (const d of dolares) dolaresByHouse[d.casa] = d;

  const out = {
    fetchedAt: new Date().toISOString(),
    riesgoPaisArg: riesgoPais ? parseArNumber(riesgoPais.ultimo) : null,
    riesgoPaisVariacion: riesgoPais?.variacion ?? null,
    dolares: {
      oficial: dolaresByHouse.oficial?.venta ?? null,
      blue: dolaresByHouse.blue?.venta ?? null,
      mep: dolaresByHouse.bolsa?.venta ?? null,
      ccl: dolaresByHouse.contadoconliqui?.venta ?? null,
    },
    fearGreed: fng?.data?.[0] ? { value: +fng.data[0].value, label: fng.data[0].value_classification } : null,
    vix: (vixQ && !vixQ.code) ? parseFloat(vixQ.close) : null,
    dxy: (dxyQ && !dxyQ.code) ? parseFloat(dxyQ.close) : null,
  };

  res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=900');
  return res.status(200).json(out);
}
