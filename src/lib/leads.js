// Automatic lead states and the five questions answered before acting.
//   ready     — Apto para campaña: relevant company and role, verified email, enough data,
//               permitted contact basis and no exclusions.
//   research  — Requiere investigación: missing title, industry, source or verification. Not scheduled.
//   excluded  — Excluido de campaña: opt-out, permanent bounce, active duplicate, not appropriate,
//               prohibited origin or non-permitted legal use.

import { LAWFUL_BASES } from './validate.js';

export const LEAD_STATUS_LABEL = { ready: 'Apto para campaña', research: 'Requiere investigación', excluded: 'Excluido de campaña' };

const ANSWER = { yes: 'sí', partial: 'parcial', unclear: 'no está claro', unknown: 'sin datos', no: 'no' };

/**
 * @param input {
 *   prospect, analysis (from analyzeProspect), brand, suppressed, activeElsewhere,
 *   verifiable: { ok, hooks: string[], fields: string[] }
 * }
 * @returns {{ status, reasons: string[], questions: Array<{ id, question, answer, ok, detail }> }}
 */
export function classifyLead({ prospect, analysis, brand, suppressed, activeElsewhere, verifiable }) {
  const excluded = [];
  const research = [];
  const industry = prospect.industry || analysis.inferredIndustry || '';

  // Exclusions (hard stops).
  if (['unsubscribed'].includes(prospect.status) || suppressed) excluded.push('opt-out / lista de supresión');
  if (prospect.status === 'bounced') excluded.push('rebote permanente');
  if (prospect.validation_status === 'invalid') excluded.push(`email inválido (${prospect.validation_notes})`);
  if (activeElsewhere) excluded.push('duplicado activo en otra campaña');
  if (analysis.exclude) excluded.push('contacto no apropiado para la oferta');
  if (analysis.companyFit === 'no') excluded.push('la empresa no encaja con la marca');
  if (analysis.roleFit === 'no') excluded.push('el cargo no tiene relación con lo que vendemos');
  if (prospect.lawful_basis && !LAWFUL_BASES[prospect.lawful_basis]) excluded.push('base legal no permitida');

  // Research needed (not scheduled until resolved).
  if (!prospect.title) research.push('falta el cargo');
  if (!industry) research.push('falta la industria');
  if (!prospect.source) research.push('falta la procedencia del dato');
  if (/no se pudo verificar/.test(prospect.validation_notes || '')) research.push('email sin verificar');
  if (brand && analysis.companyFit !== 'yes' && analysis.companyFit !== 'partial' && analysis.companyFit !== 'no') research.push('no está claro si la empresa encaja con la marca');
  if (brand && ['unclear', 'unknown'].includes(analysis.roleFit) && prospect.title) research.push('no está claro si el cargo es relevante');
  if (!verifiable.ok) research.push('no hay datos verificables para personalizar');

  const status = excluded.length ? 'excluded' : research.length ? 'research' : 'ready';
  const brandName = brand?.name || 'la marca';
  const questions = [
    {
      id: 'company_fit',
      question: `¿Esta empresa realmente encaja con ${brandName}?`,
      answer: ANSWER[analysis.companyFit] || 'sin datos',
      ok: ['yes', 'partial'].includes(analysis.companyFit),
      detail: industry ? `Industria: ${industry}${!prospect.industry && analysis.inferredIndustry ? ' (inferida)' : ''}` : 'Sin industria en los datos',
    },
    {
      id: 'role_fit',
      question: '¿Esta persona tiene responsabilidades relacionadas con lo que vendemos?',
      answer: ANSWER[analysis.roleFit] || 'sin datos',
      ok: ['yes', 'partial'].includes(analysis.roleFit),
      detail: prospect.title ? `Cargo: ${prospect.title}` : 'Sin cargo en los datos',
    },
    {
      id: 'problem',
      question: '¿Qué problema podría importarle según su cargo e industria?',
      answer: analysis.problem || 'sin hipótesis',
      ok: Boolean(analysis.problem),
      detail: analysis.problem ? 'Hipótesis de la marca elegida para esta persona' : 'Define los problemas en la marca',
    },
    {
      id: 'verifiable',
      question: '¿Tenemos información suficiente y verificable para personalizar el mensaje?',
      answer: verifiable.ok ? 'sí' : 'no',
      ok: verifiable.ok,
      detail: verifiable.ok
        ? `Ganchos disponibles: ${verifiable.hooks.join(', ') || '—'}${verifiable.fields.length ? ` · datos: ${verifiable.fields.join(', ')}` : ''}`
        : 'Ningún gancho tiene todos sus datos y no hay datos adicionales del prospecto',
    },
  ];
  return { status, reasons: excluded.length ? excluded : research, questions };
}

/** Question 5 — next appropriate action given the contact history (computed live). */
export function nextAction(db, prospect) {
  const step = (n) => db.prepare('SELECT s.* FROM steps s WHERE s.campaign_id = ? AND s.step_number = ?').get(prospect.campaign_id, n);
  const answer = (text, ok = true) => ({
    id: 'next_action',
    question: '¿Cuál es la siguiente acción apropiada según su historial de contactos?',
    answer: text,
    ok,
  });
  if (prospect.status === 'replied') return answer(`Atender la conversación (${prospect.outcome || prospect.reply_category || 'respondió'}); la secuencia está detenida.`);
  if (prospect.status !== 'active') return answer(`Ninguna: ${prospect.stop_reason || prospect.status}.`, false);
  if (prospect.lead_status === 'excluded') return answer(`Ninguna: excluido (${prospect.lead_status_reasons}).`, false);
  if (prospect.lead_status === 'research') return answer(`Investigar antes de contactar: ${prospect.lead_status_reasons}.`, false);
  if (prospect.company_id) {
    const colleague = db.prepare(
      "SELECT first_name, email FROM prospects WHERE company_id = ? AND id != ? AND status = 'replied' LIMIT 1",
    ).get(prospect.company_id, prospect.id);
    if (colleague) return answer(`Esperar: ${colleague.first_name || colleague.email} de la misma empresa ya respondió.`, false);
  }
  const draft = db.prepare("SELECT step_number, status FROM drafts WHERE prospect_id = ? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 1").get(prospect.id);
  if (draft?.status === 'pending') return answer(`Revisar y aprobar el borrador del paso ${draft.step_number}.`);
  const task = db.prepare("SELECT step_number, channel FROM tasks WHERE prospect_id = ? AND status = 'open' LIMIT 1").get(prospect.id);
  if (task) return answer(`Completar la tarea de ${task.channel === 'call' ? 'llamada' : 'LinkedIn'} (paso ${task.step_number}).`);
  const next = step(prospect.current_step + 1);
  if (!next) return answer('Secuencia completa: esperar respuesta.');
  const what = next.channel === 'email' ? (next.step_number === 1 ? 'primer correo' : 'correo de seguimiento') : next.channel === 'call' ? 'llamada' : 'contacto por LinkedIn';
  const when = prospect.next_send_at ? new Date(prospect.next_send_at).toISOString().slice(0, 16).replace('T', ' ') : 'al activar la campaña';
  return answer(`Paso ${next.step_number}: ${what} — programado ${draft?.status === 'approved' ? '(aprobado) ' : ''}para ${when} UTC.`);
}
