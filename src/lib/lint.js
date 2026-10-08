// Copy linter encoding cold-email best practices (see docs/BEST_PRACTICES.md).
// Returns warnings, never blocks: the user stays in control of the copy.

const SPAM_WORDS = [
  'gratis', 'free', 'garantizado', 'guarantee', '100%', 'oferta exclusiva', 'act now', 'actúa ahora',
  'urgente', 'urgent', 'click here', 'haz clic aquí', 'dinero fácil', 'risk-free', 'sin riesgo',
  'limited time', 'tiempo limitado', 'winner', 'ganador', 'revolucionario', 'revolutionary',
  'buy now', 'compra ahora', '$$$', 'no obligation', 'sin compromiso',
];

const MEETING_ASK_RE = /(30|45|60)\s*min|agendar|agenda una|book a (call|meeting)|calendly|demo de \d+/i;

const words = (text) => (String(text).match(/[\p{L}\p{N}'’]+/gu) || []).length;

export function lintEmail({ subject = '', body = '', stepNumber = 1 }) {
  const warnings = [];
  const plainBody = body.replace(/\{\{[^}]+\}\}/g, 'x');
  const wordCount = words(plainBody);
  const maxWords = stepNumber === 1 ? 125 : 90;

  if (wordCount > maxWords) {
    warnings.push({
      code: 'too_long',
      message: `El cuerpo tiene ${wordCount} palabras. Apunta a 50–${maxWords} (${stepNumber === 1 ? 'primer correo' : 'follow-up'}); que se lea en menos de 60 segundos.`,
    });
  }
  if (stepNumber === 1 || subject.trim()) {
    const subjectWords = words(subject);
    if (stepNumber === 1 && !subject.trim()) warnings.push({ code: 'no_subject', message: 'El primer correo necesita asunto.' });
    if (subjectWords > 6 || subject.length > 50) {
      warnings.push({ code: 'long_subject', message: 'Asunto largo: usa 2–6 palabras (< 50 caracteres), en minúsculas, como un correo entre colegas.' });
    }
    if (/^(re|fwd?):/i.test(subject.trim()) && stepNumber === 1) {
      warnings.push({ code: 'fake_reply', message: 'No uses "Re:"/"Fwd:" falsos en el primer correo; daña la confianza.' });
    }
    if (/[!]{1,}|[A-ZÁÉÍÓÚÑ]{5,}/.test(subject)) {
      warnings.push({ code: 'shouty_subject', message: 'Evita signos de exclamación y MAYÚSCULAS en el asunto.' });
    }
  }
  const lower = `${subject} ${body}`.toLowerCase();
  const spam = SPAM_WORDS.filter((w) => lower.includes(w));
  if (spam.length) warnings.push({ code: 'spam_words', message: `Palabras que activan filtros de spam: ${spam.join(', ')}.` });

  const links = (body.match(/https?:\/\//g) || []).length;
  if (links > 1) warnings.push({ code: 'links', message: `${links} links en el cuerpo. Usa máximo 1 (idealmente 0 en el primer correo) para mejor entregabilidad.` });
  if (stepNumber === 1 && /<img|\.png|\.jpg|\.gif/i.test(body)) {
    warnings.push({ code: 'images', message: 'Evita imágenes y adjuntos en el primer correo.' });
  }
  if (!/\{\{/.test(body)) {
    warnings.push({ code: 'no_personalization', message: 'Sin campos de personalización. Abre con algo específico del prospecto ({{first_name}}, {{company}}, un dato del CSV).' });
  }
  const questions = (body.match(/\?/g) || []).length;
  if (questions === 0 && !/\{\{\s*cta/.test(body)) {
    warnings.push({ code: 'no_cta', message: 'No hay una pregunta/CTA clara. Termina con una sola pregunta de baja fricción (o usa {{cta}}).' });
  }
  if (questions > 2) warnings.push({ code: 'many_asks', message: 'Varias preguntas: deja una sola petición clara.' });
  if (stepNumber === 1 && MEETING_ASK_RE.test(body)) {
    warnings.push({ code: 'big_ask', message: 'Pedir una reunión en el primer correo es mucha fricción. Prueba "¿te interesa que te envíe más info?" o pedir consejo.' });
  }
  const iCount = (lower.match(/\b(yo|nosotros|nuestro|nuestra|we|our|i)\b/g) || []).length;
  const youCount = (lower.match(/\b(tú|tu|tus|usted|ustedes|su|sus|you|your|te)\b/g) || []).length;
  if (iCount > youCount + 2) {
    warnings.push({ code: 'self_focused', message: 'El texto habla más de ti que del prospecto. Enfócalo en su problema y el resultado para él.' });
  }
  return { wordCount, warnings };
}
