/**
 * /api/assistant — asistente conversacional (Claude, Anthropic API) que
 * responde preguntas sobre el ticker en pantalla o la cartera del usuario.
 *
 * Grounding estricto: el modelo recibe SOLO datos ya calculados por la
 * plataforma (score, plan operativo, técnico, fundamentales, macro) en un
 * bloque <contexto>, con instrucción explícita de decir "no tengo ese dato"
 * en vez de inventar/estimar algo que no esté ahí — misma filosofía de
 * "nunca fabricar datos" que el resto del sitio. No da órdenes de compra/
 * venta, solo lectura probabilística de lo que ya muestra la plataforma.
 *
 * Requiere ANTHROPIC_API_KEY (ver README). Modelo configurable vía
 * ANTHROPIC_MODEL (default: claude-opus-4-8) para poder bajar costo sin
 * tocar código.
 */
const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
const MAX_QUESTION_LEN = 600;
const MAX_CONTEXT_JSON_LEN = 12000; // cota de seguridad: nunca mandar un contexto desmedido

const SYSTEM_PROMPT = `Sos el asistente de Investment Copilot AI, una plataforma de análisis de acciones/CEDEARs/ETFs/cripto para inversores argentinos.

Reglas estrictas, sin excepción:
1. Respondé SOLO en base a los datos incluidos en el bloque <contexto>. Nunca inventes, estimes ni completes con conocimiento general un precio, ratio, fecha o dato numérico que no esté en el contexto.
2. Si te preguntan algo que el contexto no cubre (un dato que no está, un ticker distinto al del contexto, una predicción de precio futuro), respondé explícitamente "No tengo ese dato disponible en la plataforma en este momento" — nunca lo aproximes ni lo inventes.
3. Nunca dés una orden de compra o venta ("comprá", "vendé", "invertí en X"). Podés describir lo que el score/plan operativo YA calculado indica, siempre en términos probabilísticos ("el score compuesto es de X, lo que sugiere...", "la plataforma marca zona de compra en...").
4. Nunca prometas ganancias ni afirmes certeza sobre movimientos futuros del mercado. Todo es probabilístico e incompleto.
5. Respondé en español rioplatense, tono profesional y directo, sin relleno. Máximo ~120 palabras salvo que la pregunta pida explícitamente más detalle.
6. Si preguntan algo no relacionado a inversión/el activo en contexto, redirigí brevemente al alcance de la plataforma.`;

function buildUserMessage(question, context) {
  let contextJson = JSON.stringify(context ?? {});
  if (contextJson.length > MAX_CONTEXT_JSON_LEN) contextJson = contextJson.slice(0, MAX_CONTEXT_JSON_LEN);
  return `<contexto>${contextJson}</contexto>\n\nPregunta del usuario: ${question}`;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'método no permitido' });
  if (!process.env.ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'asistente no configurado', detail: 'falta ANTHROPIC_API_KEY en el servidor' });
  }

  const question = String(req.body?.question || '').trim();
  if (!question) return res.status(400).json({ error: 'falta question' });
  if (question.length > MAX_QUESTION_LEN) {
    return res.status(400).json({ error: 'pregunta demasiado larga', detail: `máximo ${MAX_QUESTION_LEN} caracteres` });
  }
  const context = req.body?.context ?? {};

  try {
    const r = await fetch(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL || 'claude-opus-4-8',
        max_tokens: 700,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserMessage(question, context) }],
      }),
    });

    if (!r.ok) {
      const bodyText = await r.text().catch(() => '');
      throw new Error(`anthropic ${r.status}${bodyText ? ': ' + bodyText.slice(0, 300) : ''}`);
    }
    const data = await r.json();

    // stop_reason "refusal" viene con HTTP 200 pero sin una respuesta útil en
    // content — hay que distinguirlo de un error de red/upstream real.
    if (data.stop_reason === 'refusal') {
      return res.status(200).json({ answer: 'No puedo responder esa pregunta con los datos disponibles en la plataforma.', refused: true });
    }

    const textBlock = Array.isArray(data.content) ? data.content.find(b => b.type === 'text') : null;
    const answer = textBlock?.text?.trim();
    if (!answer) throw new Error('anthropic: respuesta sin texto');

    return res.status(200).json({ answer, model: data.model });
  } catch (e) {
    return res.status(502).json({ error: 'upstream', detail: String(e) });
  }
}
