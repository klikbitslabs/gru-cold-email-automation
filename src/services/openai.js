// OpenAI text generation for copy *proposals*. Nothing generated here is sent directly:
// variants are saved as "proposed" and a person approves them before they enter the A/B
// rotation, and every email still goes through quality control and the approval queue.

import { z } from 'zod';
import { RULES, lintTemplate } from '../lib/quality.js';
import { integrations, openaiConfigured } from './settings.js';

const generatedSchema = z.object({
  variants: z
    .array(
      z.object({
        label: z.string().trim().min(1).max(60),
        angle: z.string().trim().max(300).default(''),
        subject: z.string().trim().max(200).default(''),
        body: z.string().trim().min(1).max(3000),
        rationale: z.string().trim().max(600).default(''),
      }),
    )
    .min(1)
    .max(5),
});

async function chatJSON({ system, user, temperature = 0.7, fetchFn = fetch }) {
  const { apiKey, model, baseURL } = integrations.openai();
  if (!apiKey) throw new Error('Falta la API key de OpenAI (Integraciones).');
  const res = await fetchFn(`${baseURL}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model,
      temperature,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${data.error?.message || 'error desconocido'}`);
  const content = data.choices?.[0]?.message?.content;
  try {
    return { json: JSON.parse(content), model: data.model || model, usage: data.usage };
  } catch {
    throw new Error('OpenAI no devolvió JSON válido.');
  }
}

/** Minimal call to verify the key and model (admin panel "Probar conexión"). */
export async function testOpenAIConnection({ fetchFn = fetch } = {}) {
  if (!openaiConfigured()) return { ok: false, error: 'Falta la API key de OpenAI.' };
  const started = Date.now();
  try {
    const { json, model } = await chatJSON({
      system: 'Responde solo con JSON.',
      user: 'Devuelve {"ok": true}',
      temperature: 0,
      fetchFn,
    });
    return json.ok ? { ok: true, model, latency_ms: Date.now() - started } : { ok: false, error: 'Respuesta inesperada' };
  } catch (err) {
    return { ok: false, error: String(err.message).slice(0, 300) };
  }
}

const brandBlock = (brand) => [
  `Marca: ${brand.name}${brand.website ? ` (${brand.website})` : ''}`,
  brand.value_proposition && `Propuesta de valor: ${brand.value_proposition}`,
  brand.industries && `1. Industria y operación de los clientes: ${brand.industries}`,
  brand.functions && `2. Función de los contactos: ${brand.functions}`,
  brand.problems && `3. Problemas que resolvemos: ${brand.problems}`,
  (brand.ref_subject || brand.ref_email) && `4. Mensaje de referencia:\n   Asunto: ${brand.ref_subject}\n   Correo: ${brand.ref_email}${brand.ref_call ? `\n   Argumento de llamada: ${brand.ref_call}` : ''}`,
  brand.tone && `Tono de la marca: ${brand.tone}`,
  brand.avoid && `Nunca uses estas palabras o promesas: ${brand.avoid}`,
].filter(Boolean).join('\n');

/** Who reads the email: the same company buys for different reasons depending on the role. */
const personaBlock = (persona) => (persona
  ? [
    `Destinatario: perfil "${persona.name}". Escribe SOLO para este perfil; otra persona de la misma empresa recibirá un argumento distinto.`,
    persona.motivation && `- Lo que le importa / cómo lo miden: ${persona.motivation}`,
    persona.problem && `- Su problema, en su lenguaje: ${persona.problem}`,
    persona.argument && `- Cómo le ayuda la marca: ${persona.argument}`,
    persona.proof && `- Prueba relevante para este rol: ${persona.proof}`,
    persona.cta && `- Pedido adecuado a su nivel: ${persona.cta}`,
    persona.avoid && `- No le hables de: ${persona.avoid}`,
    'Reglas de oro: habla de SU prioridad (no de funciones del producto), usa el vocabulario de su cargo (operativos: detalle concreto; directivos: impacto en dinero y riesgo, más breve) y haz un solo pedido acorde a su nivel. No menciones a otras personas de su empresa.',
  ].filter(Boolean).join('\n')
  : 'Destinatario: cualquier perfil del segmento. Aun así, el argumento debe apoyarse en la responsabilidad de su cargo ({{title}}).');

// Why the decision center asked for new copy (see services/decisions.js).
const FOCUS = {
  subject: 'la tasa de apertura es baja; prueba asuntos claramente distintos (más específicos para el cargo o el problema) y mantén el cuerpo que mejor funciona.',
  followup: 'este seguimiento no está generando respuestas; cambia el ángulo (otro problema, prueba social concreta o un cierre respetuoso) en lugar de repetir el mensaje anterior.',
  challenger: 'crea retadores de la variante ganadora cambiando una sola cosa a la vez.',
  persona: 'este perfil todavía no tiene un mensaje propio; escribe uno centrado en su motivación, distinto del que reciben otros cargos de la misma empresa.',
};

/**
 * Proposes new email variants for a step/segment.
 * @param ctx { brand, campaign, segment, stepNumber, channel, count, sameThread, performance: [{ subject, body, sent, open_rate, reply_rate }], fields }
 * @returns {Promise<{ variants: Array, model: string }>}
 */
export async function generateVariants(ctx, { fetchFn = fetch } = {}) {
  const { brand, campaign, segment, persona = null, stepNumber, channel = 'email', count = 2, performance = [], fields = [], sameThread = true, focus = '' } = ctx;
  const isFirst = stepNumber === 1;
  const ranked = [...performance].sort((a, b) => (b.reply_rate ?? 0) - (a.reply_rate ?? 0) || (b.open_rate ?? 0) - (a.open_rate ?? 0));
  const history = ranked.length
    ? ranked.slice(0, 6).map((v, i) => `#${i + 1} (${v.sent} envíos, apertura ${v.open_rate ?? '—'}%, respuesta ${v.reply_rate ?? '—'}%)\n   Asunto: ${v.subject || '(mismo hilo)'}\n   Cuerpo: ${v.body}`).join('\n')
    : 'Aún no hay resultados: propone ángulos claramente distintos entre sí para probarlos.';

  const system = `Eres un redactor senior de cold email B2B en español natural (adaptado al país y sector del cliente).
Escribes correos humanos, directos, respetuosos y sin exageraciones, que se leen en menos de 60 segundos.
Devuelves SOLO JSON con la forma {"variants":[{"label","angle","subject","body","rationale"}]}.`;

  const rules = channel !== 'email'
    ? `Es un guion de ${channel === 'call' ? 'llamada en frío' : 'mensaje de LinkedIn (máx. 300 caracteres)'}: breve, conversacional, con un objetivo claro.`
    : `Reglas obligatorias:
- Asunto: ${RULES.subject.minWords}–${RULES.subject.maxWords} palabras, minúsculas normales, sin MAYÚSCULAS en bloque, sin exclamaciones, sin emojis${isFirst ? ', sin "Re:" ni "Fwd:"' : ''}. Puede ser una pregunta natural.
- Cuerpo: ${RULES.body.targetMin}–${RULES.body.targetMax} palabras (nunca más de ${RULES.body.warnAbove}).
${isFirst ? `- Estructura en 3 párrafos tras el saludo "Hola {{first_name}},":
  1) {{gancho}} — escríbelo literalmente: el sistema lo reemplaza por un dato real y verificable de la persona.
  2) Una hipótesis de problema relevante para su cargo e industria (escríbela tú, con humildad: "en equipos parecidos vemos…").
  3) {{cta}} — escríbelo literalmente: una sola pregunta o propuesta breve que elige el sistema.
- Sin enlaces ni adjuntos.` : `- Es el seguimiento #${stepNumber - 1}${sameThread ? ' en el mismo hilo (no escribas asunto: deja "subject" vacío)' : ' en un correo nuevo (escribe asunto)'}; aporta algo nuevo (prueba social, otro ángulo, recurso o cierre respetuoso) y termina con {{cta}} o una sola pregunta.`}
- Máximo una acción principal. Nada de lenguaje publicitario ("gratis", "garantizado", "revolucionario", "100%").
- Campos disponibles: {{first_name}}, {{company}}, {{title}}${fields.length ? `, ${fields.map((f) => `{{${f}}}`).join(', ')}` : ''}. No inventes otros campos ni datos sobre la persona.`;

  const user = `${brandBlock(brand)}

Campaña: ${campaign.name}
Oferta: ${campaign.offer || '(ver propuesta de valor)'}
ICP: ${campaign.icp || '(ver industrias y funciones de la marca)'}
Segmento: ${segment ? `${segment.name} — ${segment.description}` : 'todos los prospectos'}
${personaBlock(persona)}
Paso ${stepNumber} de la secuencia (${channel}).

${rules}

Resultados de las variantes actuales (de mejor a peor):
${history}

${FOCUS[focus] ? `Objetivo de esta ronda: ${FOCUS[focus]}\n\n` : ''}Escribe ${count} variante(s) nuevas para probar en A/B. Si hay ganadoras, conserva lo que las hace funcionar y prueba UNA diferencia clara por variante (asunto, ángulo o problema). En "rationale" explica en una frase qué hipótesis prueba cada una.`;

  const { json, model } = await chatJSON({ system, user, fetchFn });
  const parsed = generatedSchema.parse(json);
  return {
    model,
    variants: parsed.variants.slice(0, count).map((v) => ({
      ...v,
      subject: isFirst || !sameThread ? v.subject : '',
      quality: channel === 'email' ? lintTemplate({ subject: v.subject, body: v.body, stepNumber, threadReply: !isFirst }).issues : [],
    })),
  };
}
