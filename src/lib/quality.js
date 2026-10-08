// Quality control for cold emails. Encodes the house rules for subjects and bodies.
// Severity: 'error' blocks sending until a person edits/approves; 'warning' sends the draft
// to the approval queue (in approval mode "issues"); 'info' is advisory only.

import { templateFields } from './template.js';

export const RULES = {
  subject: { minWords: 3, maxWords: 7, maxChars: 60 },
  body: { targetMin: 45, targetMax: 85, warnAbove: 110, hardMin: 25, paragraphs: 3 },
};

// Fields that do not count as meaningful personalization on their own.
const TRIVIAL_FIELDS = new Set([
  'first_name', 'last_name', 'full_name', 'email', 'company', 'sender_name', 'sender_first_name', 'sender_email',
  'cta', 'problema', 'unsubscribe_url',
]);

const HYPE_WORDS = [
  'gratis', 'free', 'garantizado', 'garantía total', '100%', 'increíble', 'revolucionario', 'revolucionaria',
  'oferta exclusiva', 'última oportunidad', 'urgente', 'actúa ahora', 'haz clic aquí', 'click here', 'sin riesgo',
  'dinero fácil', 'el mejor del mercado', 'líder absoluto', 'tiempo limitado', 'compra ahora', '$$$', 'imperdible',
];

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const words = (text) => (String(text).match(/[\p{L}\p{N}'’]+/gu) || []).length;
const issue = (severity, code, message) => ({ severity, code, message });

export function checkSubject(subject, { stepNumber = 1, threadReply = false } = {}) {
  const out = [];
  const s = String(subject || '').trim();
  if (!s) return [issue('error', 'no_subject', 'El correo no tiene asunto.')];
  if (/^(re|fwd?|rv):/i.test(s) && !threadReply) {
    out.push(issue('error', 'fake_reply', '"Re:" y "Fwd:" solo se usan en un hilo o reenvío real.'));
  }
  if (threadReply) return out; // "Re: <asunto original>" is fixed by the thread.

  const n = words(s);
  if (n < RULES.subject.minWords || n > RULES.subject.maxWords) {
    out.push(issue('warning', 'subject_length', `Asunto de ${n} palabras: preferentemente ${RULES.subject.minWords}–${RULES.subject.maxWords}.`));
  }
  if (s.length > RULES.subject.maxChars) out.push(issue('warning', 'subject_chars', `Asunto de ${s.length} caracteres: se corta en móviles.`));
  if (/\b[A-ZÁÉÍÓÚÑ]{4,}\b/.test(s.replace(/\b(CEO|CFO|CTO|COO|CMO|CRM|ERP|SaaS|B2B|B2C|KPI|ROI|SEO|API|IA|AI|USA|PYME|PYMES)\b/g, ''))) {
    out.push(issue('warning', 'subject_caps', 'Sin bloques en MAYÚSCULAS en el asunto: escritura normal.'));
  }
  if (/[!¡]/.test(s)) out.push(issue('warning', 'subject_exclamation', 'Evita exclamaciones en el asunto.'));
  if (/([?.,;:])\1|\?{2,}|\.{3}/.test(s)) out.push(issue('warning', 'subject_punctuation', 'Evita puntuación repetida en el asunto.'));
  if (EMOJI_RE.test(s) && stepNumber === 1) out.push(issue('error', 'subject_emoji', 'Sin emojis en el primer contacto B2B.'));
  const hype = HYPE_WORDS.filter((w) => s.toLowerCase().includes(w));
  if (hype.length) out.push(issue('warning', 'subject_hype', `Publicidad exagerada en el asunto: ${hype.join(', ')}.`));
  return out;
}

function paragraphsOf(body) {
  const blocks = String(body).split(/\n\s*\n/).map((b) => b.trim()).filter(Boolean);
  // A short greeting line ("Hola Ana,") is not a content paragraph.
  if (blocks.length && words(blocks[0]) <= 4 && /,\s*$/.test(blocks[0])) blocks.shift();
  return blocks;
}

/**
 * @param {object} opts
 *   template: true when checking an editor template (placeholders not rendered yet)
 *   personalized: true when a verifiable, non-trivial element is present
 */
export function checkBody(body, { stepNumber = 1, template = false, personalized } = {}) {
  const out = [];
  const text = String(body || '');
  const lower = text.toLowerCase();
  const fields = templateFields(text);

  if (!template) {
    const n = words(text);
    if (n >= RULES.body.warnAbove) {
      out.push(issue('warning', 'too_long', `${n} palabras: objetivo ${RULES.body.targetMin}–${RULES.body.targetMax}, máximo recomendado ${RULES.body.warnAbove}.`));
    } else if (n > RULES.body.targetMax) {
      out.push(issue('info', 'above_target', `${n} palabras: un poco sobre el objetivo de ${RULES.body.targetMin}–${RULES.body.targetMax}.`));
    } else if (n < RULES.body.hardMin && stepNumber === 1) {
      out.push(issue('warning', 'too_short', `${n} palabras: muy corto para un primer contacto (objetivo ${RULES.body.targetMin}–${RULES.body.targetMax}).`));
    }
  }

  if (stepNumber === 1) {
    const paragraphs = paragraphsOf(text);
    if (paragraphs.length < RULES.body.paragraphs) {
      out.push(issue('warning', 'structure', 'Estructura sugerida en 3 párrafos: 1) contexto real de la persona, 2) hipótesis de problema, 3) pregunta o propuesta breve.'));
    }
  }

  const questions = (text.match(/\?/g) || []).length + (fields.includes('cta') ? 1 : 0);
  if (questions > 1) out.push(issue('warning', 'many_ctas', 'Máximo una acción principal: deja una sola pregunta o propuesta.'));
  if (questions === 0) out.push(issue('warning', 'no_cta', 'Falta una pregunta o propuesta breve al final (o usa {{cta}}).'));

  const links = (text.match(/https?:\/\/|www\./gi) || []).length;
  if (links && stepNumber === 1) out.push(issue('error', 'links_first_email', 'Sin enlaces en el primer correo (el enlace de baja se agrega aparte).'));
  else if (links > 1) out.push(issue('warning', 'links', 'Máximo un enlace en los seguimientos.'));

  if (EMOJI_RE.test(text) && stepNumber === 1) out.push(issue('error', 'body_emoji', 'Sin emojis en el primer contacto B2B.'));
  if ((text.match(/!/g) || []).length > 1) out.push(issue('warning', 'exclamations', 'Tono sin exageraciones: evita exclamaciones.'));
  const hype = HYPE_WORDS.filter((w) => lower.includes(w));
  if (hype.length) out.push(issue('warning', 'hype', `Lenguaje publicitario exagerado: ${hype.join(', ')}.`));

  const hasRealPersonalization = personalized ?? (fields.includes('gancho') || fields.some((f) => !TRIVIAL_FIELDS.has(f)));
  if (stepNumber === 1 && !hasRealPersonalization) {
    out.push(issue('warning', 'personalization', 'Incluye al menos un elemento personal, verificable y no trivial ({{gancho}} o un dato del archivo más allá del nombre y la empresa).'));
  }
  return out;
}

/** Template check for the sequence editor (placeholders not rendered). */
export function lintTemplate({ subject = '', body = '', stepNumber = 1, threadReply = false }) {
  const issues = [
    ...(stepNumber === 1 || subject.trim() ? checkSubject(subject, { stepNumber, threadReply }) : []),
    ...checkBody(body, { stepNumber, template: true }),
  ];
  return { issues };
}

/**
 * Full check of a rendered draft for one prospect.
 * @returns {{ issues, errors, warnings, wordCount, passed }}
 */
export function checkDraft({ subject, body, stepNumber, threadReply, personalized, missing = [], sender, prospect }) {
  const issues = [...checkSubject(subject, { stepNumber, threadReply }), ...checkBody(body, { stepNumber, personalized })];
  if (missing.length) issues.push(issue('error', 'missing_fields', `Faltan datos para personalizar: ${missing.join(', ')}.`));
  if (!sender?.display_name?.trim() || !sender?.signature_html?.trim()) {
    issues.push(issue('error', 'signature', 'El remitente necesita nombre real y firma.'));
  }
  if (prospect?.validation_status === 'invalid') {
    issues.push(issue('error', 'invalid_lead', `Lead inválido: ${prospect.validation_notes}.`));
  } else if (prospect?.validation_status === 'risky') {
    issues.push(issue('warning', 'risky_lead', `Lead riesgoso: ${prospect.validation_notes}.`));
  }
  const errors = issues.filter((i) => i.severity === 'error');
  const warnings = issues.filter((i) => i.severity === 'warning');
  return { issues, errors: errors.length, warnings: warnings.length, wordCount: words(body), passed: !errors.length };
}

export { words as countWords };
