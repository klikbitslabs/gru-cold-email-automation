// Decision center: reads the results and recommends what to change (copy, senders, sending
// windows, caps, approvals). Each recommendation carries its evidence and an executable action.
// A person approves or dismisses it — or grants automatic permission for that type, in which
// case the platform applies it on its own (hourly, from the scheduler) and records it.

import { nowIso } from '../db.js';
import { AB_MIN_SENDS, abRecommendations } from '../lib/ab.js';
import { lintTemplate } from '../lib/quality.js';
import { campaignSchedule, localParts, parseHHMM } from '../lib/time.js';
import { generateVariants } from './openai.js';
import { loadSequence, performanceStats } from './scheduler.js';
import { openaiConfigured } from './settings.js';

const DAY_MS = 86400000;
const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);

/** Types the user can let the platform apply automatically. `insight` is information only. */
export const RECOMMENDATION_TYPES = {
  pause_variant: {
    label: 'Pausar variantes perdedoras',
    help: 'Cuando una variante rinde significativamente peor que la ganadora (≥30 envíos por variante, prueba estadística).',
  },
  generate_variants: {
    label: 'Proponer textos nuevos con IA',
    help: 'Retadores de la ganadora, asuntos nuevos si la apertura es baja y seguimientos nuevos si no hay respuestas. Se crean como "propuestas".',
  },
  activate_variants: {
    label: 'Activar variantes propuestas sin errores',
    help: 'Las propuestas que pasan el control de calidad entran a la prueba A/B.',
  },
  approve_drafts: {
    label: 'Aprobar borradores sin errores',
    help: 'Los correos que pasaron el control de calidad salen sin esperar revisión manual. Los que tienen errores siempre esperan a una persona.',
  },
  pause_sender: {
    label: 'Pausar remitentes con rebote alto',
    help: 'Protege la reputación del dominio si un buzón supera 5% de rebote en 14 días.',
  },
  adjust_schedule: {
    label: 'Ajustar la ventana de envío',
    help: 'Mueve las horas de envío hacia cuando tus prospectos realmente abren.',
  },
  raise_cap: {
    label: 'Subir el límite diario',
    help: 'Solo si el límite se alcanza cada día, hay leads aptos esperando, los buzones tienen capacidad y el rebote es bajo.',
  },
};

/** Presets for the permissions panel. */
export const AUTOMATION_PRESETS = {
  supervised: [],
  recommended: ['pause_variant', 'generate_variants', 'pause_sender', 'adjust_schedule'],
  autopilot: Object.keys(RECOMMENDATION_TYPES),
};

// ---------------------------------------------------------------------------
// Shared helpers (also used by the HTTP routes)
// ---------------------------------------------------------------------------

/** Variants of each email step/segment with their results (input for A/B decisions). */
export function abGroups(db, campaignId) {
  const perf = performanceStats(db, campaignId).variants;
  const opened = new Map(
    db.prepare('SELECT variant_id AS id, SUM(open_count > 0) AS n FROM messages WHERE campaign_id = ? GROUP BY variant_id').all(campaignId).map((r) => [r.id, r.n]),
  );
  const rows = db.prepare(
    `SELECT v.*, s.step_number, s.same_thread, sg.name AS segment FROM variants v JOIN steps s ON s.id = v.step_id LEFT JOIN segments sg ON sg.id = v.segment_id
     WHERE s.campaign_id = ? AND s.channel = 'email' ORDER BY s.step_number, v.id`,
  ).all(campaignId);
  const groups = new Map();
  for (const v of rows) {
    const key = `${v.step_number}|${v.segment || ''}`;
    if (!groups.has(key)) groups.set(key, { step_number: v.step_number, segment: v.segment || '', variants: [] });
    const st = perf.get(v.id) || { sent: 0, replied: 0, positive: 0 };
    groups.get(key).variants.push({
      id: v.id, label: v.label, status: v.status, origin: v.origin, rationale: v.rationale, subject: v.subject, body: v.body,
      same_thread: v.same_thread, sent: st.sent, replied: st.replied, positive: st.positive, opened: opened.get(v.id) || 0,
    });
  }
  return [...groups.values()];
}

/** Approves every pending draft of a campaign that passed quality control. */
export function approveDrafts(db, campaignId, at) {
  const pending = db.prepare("SELECT * FROM drafts WHERE campaign_id = ? AND status = 'pending'").all(campaignId);
  let approved = 0;
  db.transaction(() => {
    for (const d of pending) {
      if (JSON.parse(d.quality_json || '{}').errors) continue;
      db.prepare("UPDATE drafts SET status = 'approved', reviewed_at = ? WHERE id = ?").run(nowIso(at), d.id);
      // Make the prospect due again so the next tick sends it (inside the sending window).
      db.prepare("UPDATE prospects SET next_send_at = ? WHERE id = ? AND status = 'active'").run(nowIso(at), d.prospect_id);
      approved += 1;
    }
  })();
  return { approved, skipped_with_errors: pending.length - approved };
}

/** Asks the AI for new proposed variants of one step (they still need approval to be sent). */
export async function generateForStep(db, { campaign, stepNumber, segmentName = '', count = 2, baseVariantId, focus = '', generateFn = generateVariants }) {
  if (generateFn === generateVariants && !openaiConfigured()) {
    throw Object.assign(new Error('Configura la API key de OpenAI en Integraciones para generar textos.'), { status: 400 });
  }
  const step = loadSequence(db, campaign.id).find((st) => st.step_number === stepNumber);
  if (!step) throw Object.assign(new Error('Paso no encontrado'), { status: 404 });
  const brand = campaign.brand_id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(campaign.brand_id) : null;
  if (!brand) throw Object.assign(new Error('Asigna una marca a la campaña: la IA escribe con su contexto.'), { status: 400 });
  const segment = segmentName ? db.prepare('SELECT * FROM segments WHERE campaign_id = ? AND name = ?').get(campaign.id, segmentName) : null;

  const perf = performanceStats(db, campaign.id).variants;
  const opened = new Map(db.prepare('SELECT variant_id AS id, SUM(open_count > 0) AS n FROM messages WHERE campaign_id = ? GROUP BY variant_id').all(campaign.id).map((r) => [r.id, r.n]));
  const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
  const performance = step.variants
    .filter((v) => v.status !== 'proposed' && (!segment || !v.segment_id || v.segment_id === segment.id))
    .filter((v) => !baseVariantId || v.id === baseVariantId || (perf.get(v.id)?.sent || 0) > 0)
    .map((v) => {
      const st = perf.get(v.id) || { sent: 0, replied: 0 };
      return { subject: v.subject, body: v.body, sent: st.sent, open_rate: rate(opened.get(v.id) || 0, st.sent), reply_rate: rate(st.replied, st.sent) };
    });
  const sample = db.prepare('SELECT fields_json FROM prospects WHERE campaign_id = ? LIMIT 1').get(campaign.id);
  const result = await generateFn({
    brand,
    campaign,
    segment,
    stepNumber: step.step_number,
    channel: step.channel,
    sameThread: Boolean(step.same_thread),
    count,
    focus,
    performance,
    fields: Object.keys(JSON.parse(sample?.fields_json || '{}')).slice(0, 15),
  });
  const created = [];
  db.transaction(() => {
    for (const v of result.variants) {
      const id = Number(db.prepare(
        "INSERT INTO variants (step_id, label, angle, segment_id, subject, body, status, origin, rationale) VALUES (?, ?, ?, ?, ?, ?, 'proposed', 'ai', ?)",
      ).run(step.id, `IA · ${v.label}`.slice(0, 60), v.angle, segment?.id ?? null, v.subject, v.body, v.rationale).lastInsertRowid);
      created.push({ id, ...v });
    }
  })();
  return { model: result.model, variants: created };
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/** Best contiguous block of `length` hours (between 06:00 and 22:00) by opens. */
function bestBlock(hourly, length) {
  let best = { start: 8, opens: -1 };
  for (let start = 6; start + length <= 22; start += 1) {
    const opens = hourly.slice(start, start + length).reduce((a, b) => a + b, 0);
    if (opens > best.opens) best = { start, opens };
  }
  return best;
}

const hhmm = (h) => `${String(h).padStart(2, '0')}:00`;

function scheduleCandidate(db, campaign, at) {
  const since = new Date(at - 60 * DAY_MS).toISOString();
  const opens = db.prepare(
    `SELECT oe.opened_at FROM open_events oe JOIN messages m ON m.id = oe.message_id
     WHERE m.campaign_id = ? AND oe.suspected_bot = 0 AND oe.opened_at >= ?`,
  ).all(campaign.id, since);
  if (opens.length < 40) return null;
  const schedule = campaignSchedule(campaign);
  const enabled = Object.entries(schedule).filter(([, d]) => d.on);
  if (!enabled.length) return null;
  const hourly = Array(24).fill(0);
  let inside = 0;
  let counted = 0;
  for (const o of opens) {
    const lp = localParts(new Date(o.opened_at), campaign.timezone);
    const day = schedule[lp.weekday];
    if (!day?.on) continue;
    counted += 1;
    hourly[lp.hour] += 1;
    if (lp.minuteOfDay >= parseHHMM(day.start) && lp.minuteOfDay < parseHHMM(day.end)) inside += 1;
  }
  if (counted < 40) return null;
  const lengths = enabled.map(([, d]) => Math.max(1, Math.round((parseHHMM(d.end) - parseHHMM(d.start)) / 60))).sort((a, b) => a - b);
  const length = Math.min(16, Math.max(4, lengths[Math.floor(lengths.length / 2)]));
  const block = bestBlock(hourly, length);
  const current = inside / counted;
  const proposed = block.opens / counted;
  if (current >= 0.6 || proposed - current < 0.15) return null;
  const next = Object.fromEntries(Object.entries(schedule).map(([d, v]) => [d, v.on ? { on: true, start: hhmm(block.start), end: hhmm(block.start + length) } : v]));
  return {
    type: 'adjust_schedule',
    key: `schedule:${campaign.id}`,
    severity: 'medium',
    title: `${campaign.name}: enviar de ${hhmm(block.start)} a ${hhmm(block.start + length)}`,
    reason: `Solo el ${pct(inside, counted)}% de las aperturas (${counted} en 60 días) ocurre dentro de la ventana actual; en ${hhmm(block.start)}–${hhmm(block.start + length)} (${campaign.timezone}) ocurre el ${pct(block.opens, counted)}%.`,
    evidence: { hourly, opens: counted, current_coverage: pct(inside, counted), proposed_coverage: pct(block.opens, counted) },
    action: { kind: 'update_campaign', campaign_id: campaign.id, fields: { schedule_json: JSON.stringify(next) } },
  };
}

function campaignCandidates(db, campaign, at, { canGenerate }) {
  const out = [];
  const name = campaign.name;
  const groups = abGroups(db, campaign.id);
  const hasBrand = Boolean(campaign.brand_id);
  const proposedIn = (g) => g.variants.some((v) => v.status === 'proposed');

  // Copy: A/B pauses + one "new copy" recommendation per step/segment (subject > follow-up > challenger).
  const generate = new Map();
  const wantCopy = (g, focus, severity, title, reason, baseId, evidence) => {
    const key = `generate:${campaign.id}:${g.step_number}:${g.segment}`;
    const rank = { subject: 3, followup: 2, challenger: 1 };
    if (proposedIn(g) || (generate.has(key) && rank[generate.get(key).evidence.focus] >= rank[focus])) return;
    const ready = canGenerate && hasBrand;
    generate.set(key, {
      type: 'generate_variants',
      key,
      severity,
      title: `${name} · ${title}`,
      reason: ready ? reason : `${reason} Configura OpenAI en Integraciones y asigna una marca para generarlas automáticamente, o escribe una variante manual.`,
      evidence: { focus, step_number: g.step_number, segment: g.segment, ...evidence },
      action: ready ? { kind: 'generate_variants', campaign_id: campaign.id, step_number: g.step_number, segment: g.segment, base_variant_id: baseId, count: 2, focus } : null,
    });
  };
  for (const r of abRecommendations(groups)) {
    if (r.type === 'pause') {
      out.push({
        type: 'pause_variant',
        key: `pause_variant:${r.variant_id}`,
        severity: 'high',
        title: `${name} · ${r.title}`,
        reason: r.reason,
        evidence: { variant_id: r.variant_id, winner_id: r.winner_id, confidence: r.confidence, step_number: r.step_number, segment: r.segment },
        action: { kind: 'pause_variant', variant_id: r.variant_id },
      });
    } else if (r.type === 'challenge') {
      const g = groups.find((x) => x.step_number === r.step_number && x.segment === r.segment);
      const sent = g.variants.reduce((a, v) => a + v.sent, 0);
      if (sent >= AB_MIN_SENDS) wantCopy(g, 'challenger', 'low', r.title, r.reason, r.variant_id, { sent });
    }
  }
  for (const g of groups) {
    const active = g.variants.filter((v) => v.status === 'active');
    // Low open rate on a subject the prospect actually sees.
    for (const v of active) {
      const ownSubject = g.step_number === 1 || !v.same_thread;
      if (ownSubject && v.sent >= 40 && v.opened / v.sent < 0.2) {
        wantCopy(g, 'subject', 'medium', `Paso ${g.step_number}${g.segment ? ` · ${g.segment}` : ''}: apertura baja en "${v.label}"`,
          `Apertura ${pct(v.opened, v.sent)}% en ${v.sent} envíos (referencia sana: 30–60%). Prueba asuntos nuevos; si la apertura sigue baja en todas las variantes revisa también la entregabilidad.`, v.id, { variant_id: v.id, open_rate: pct(v.opened, v.sent), sent: v.sent });
      }
    }
    // A follow-up step that never gets replies.
    const sent = active.reduce((a, v) => a + v.sent, 0);
    const replied = active.reduce((a, v) => a + v.replied, 0);
    if (g.step_number > 1 && sent >= 40 && replied === 0) {
      wantCopy(g, 'followup', 'medium', `Paso ${g.step_number}${g.segment ? ` · ${g.segment}` : ''}: el seguimiento no genera respuestas`,
        `${sent} envíos y 0 respuestas en este paso. Cambia el ángulo (otro problema, prueba social o cierre respetuoso).`, active[0]?.id, { sent });
    }
  }
  out.push(...generate.values());

  // AI proposals waiting for a person.
  const proposed = db.prepare(
    `SELECT v.*, s.step_number, s.same_thread FROM variants v JOIN steps s ON s.id = v.step_id WHERE s.campaign_id = ? AND v.status = 'proposed' ORDER BY v.id`,
  ).all(campaign.id);
  if (proposed.length) {
    const clean = proposed.filter((v) => !lintTemplate({ subject: v.subject, body: v.body, stepNumber: v.step_number, threadReply: v.step_number > 1 && Boolean(v.same_thread) })
      .issues.some((i) => i.severity === 'error'));
    out.push({
      type: 'activate_variants',
      key: `activate:${campaign.id}`,
      severity: 'medium',
      title: `${name}: ${proposed.length} variante(s) propuesta(s) esperando aprobación`,
      reason: clean.length
        ? `${clean.length} pasan el control de calidad y pueden entrar a la prueba A/B${clean.length < proposed.length ? `; ${proposed.length - clean.length} tienen errores y deben editarse en Secuencia` : ''}.`
        : 'Todas tienen errores de calidad: edítalas en la pestaña Secuencia.',
      evidence: { variants: proposed.map((v) => ({ id: v.id, label: v.label, step_number: v.step_number, subject: v.subject, ok: clean.includes(v) })) },
      action: clean.length ? { kind: 'activate_variants', variant_ids: clean.map((v) => v.id) } : null,
    });
  }

  // Approval backlog.
  const drafts = db.prepare("SELECT quality_json, created_at FROM drafts WHERE campaign_id = ? AND status = 'pending'").all(campaign.id);
  if (drafts.length) {
    const ok = drafts.filter((d) => !JSON.parse(d.quality_json || '{}').errors);
    const oldest = drafts.reduce((m, d) => (d.created_at < m ? d.created_at : m), drafts[0].created_at);
    const waitingHours = Math.round((at - new Date(oldest)) / 3600000);
    if (ok.length && (ok.length >= 10 || waitingHours >= 2)) {
      out.push({
        type: 'approve_drafts',
        key: `approve_drafts:${campaign.id}`,
        severity: waitingHours >= 24 ? 'high' : 'medium',
        title: `${name}: ${ok.length} borrador(es) listos para enviar`,
        reason: `Pasaron el control de calidad y esperan aprobación (el más antiguo hace ${waitingHours} h).${drafts.length > ok.length ? ` ${drafts.length - ok.length} con errores seguirán esperando revisión.` : ''}`,
        evidence: { ready: ok.length, with_errors: drafts.length - ok.length, waiting_hours: waitingHours },
        action: { kind: 'approve_drafts', campaign_id: campaign.id },
      });
    }
  }

  // Sending window vs. when prospects open.
  const schedule = scheduleCandidate(db, campaign, at);
  if (schedule) out.push(schedule);

  // Daily cap reached with leads waiting.
  if (campaign.status === 'active' && campaign.max_per_day) {
    const sent24 = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE campaign_id = ? AND sent_at > ?').get(campaign.id, new Date(at - DAY_MS).toISOString()).n;
    const waiting = db.prepare(
      "SELECT COUNT(*) AS n FROM prospects WHERE campaign_id = ? AND status = 'active' AND lead_status = 'ready' AND next_send_at IS NOT NULL AND next_send_at <= ?",
    ).get(campaign.id, at.toISOString()).n;
    if (sent24 >= campaign.max_per_day && waiting >= 20) {
      const capacity = db.prepare(
        "SELECT COALESCE(SUM(s.daily_limit), 0) AS n FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id WHERE cs.campaign_id = ? AND s.status = 'active'",
      ).get(campaign.id).n;
      const recent = db.prepare(
        `SELECT COUNT(DISTINCT m.prospect_id) AS contacted, COUNT(DISTINCT CASE WHEN p.status = 'bounced' THEN p.id END) AS bounced
         FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE m.campaign_id = ? AND m.sent_at > ?`,
      ).get(campaign.id, new Date(at - 14 * DAY_MS).toISOString());
      const bounce = pct(recent.bounced, recent.contacted);
      const target = Math.min(capacity, Math.ceil(campaign.max_per_day * 1.25));
      if (bounce < 3 && target > campaign.max_per_day) {
        out.push({
          type: 'raise_cap',
          key: `raise_cap:${campaign.id}`,
          severity: 'low',
          title: `${name}: subir el límite diario a ${target}`,
          reason: `Se alcanzó el límite de ${campaign.max_per_day} correos en 24 h y hay ${waiting} leads aptos esperando. Rebote de 14 días ${bounce}% y capacidad de los buzones ${capacity}/día.`,
          evidence: { sent_24h: sent24, waiting, capacity, bounce_rate: bounce },
          action: { kind: 'update_campaign', campaign_id: campaign.id, fields: { max_per_day: target } },
        });
      } else if (capacity <= campaign.max_per_day) {
        out.push({
          type: 'insight',
          key: `capacity:${campaign.id}`,
          severity: 'low',
          title: `${name}: los buzones están al máximo`,
          reason: `Hay ${waiting} leads aptos esperando y los senders suman ${capacity} envíos/día. Agrega otro sender de Google Workspace (con dominio calentado) para crecer sin dañar la reputación.`,
          evidence: { waiting, capacity },
          action: null,
        });
      }
    }
  }

  // Leads stuck in research.
  const research = db.prepare(
    "SELECT lead_status_reasons AS reasons FROM prospects WHERE campaign_id = ? AND status = 'active' AND lead_status = 'research'",
  ).all(campaign.id);
  if (research.length >= 5) {
    const counts = new Map();
    for (const r of research) for (const reason of String(r.reasons).split('; ').filter(Boolean)) counts.set(reason, (counts.get(reason) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3);
    out.push({
      type: 'insight',
      key: `research:${campaign.id}`,
      severity: 'low',
      title: `${name}: ${research.length} leads requieren investigación`,
      reason: `No se contactan hasta completar sus datos. Motivos principales: ${top.map(([r, n]) => `${r} (${n})`).join(', ')}. Completa cargo, industria y procedencia en el CSV o en la ficha del prospecto.`,
      evidence: { total: research.length, reasons: Object.fromEntries(top) },
      action: null,
    });
  }

  // Unsubscribe spike (last 7 days).
  const week = db.prepare(
    `SELECT COUNT(DISTINCT m.prospect_id) AS contacted, COUNT(DISTINCT CASE WHEN p.status = 'unsubscribed' THEN p.id END) AS unsub
     FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE m.campaign_id = ? AND m.sent_at > ?`,
  ).get(campaign.id, new Date(at - 7 * DAY_MS).toISOString());
  if (week.contacted >= 30 && week.unsub / week.contacted > 0.02) {
    out.push({
      type: 'insight',
      key: `unsubscribe:${campaign.id}`,
      severity: 'high',
      title: `${name}: bajas por encima del 2%`,
      reason: `${week.unsub} bajas de ${week.contacted} contactados en 7 días (${pct(week.unsub, week.contacted)}%). Revisa el encaje del segmento y el tono; demasiadas bajas y quejas afectan la entregabilidad.`,
      evidence: week,
      action: null,
    });
  }

  // Segments that respond far below the campaign average.
  const segments = db.prepare(
    `SELECT COALESCE(sg.name, 'Sin segmento') AS segment, COUNT(DISTINCT p.id) AS contacted,
       COUNT(DISTINCT CASE WHEN p.status = 'replied' AND p.reply_category NOT IN ('bounce','auto_reply') THEN p.id END) AS replied
     FROM prospects p JOIN messages m ON m.prospect_id = p.id LEFT JOIN segments sg ON sg.id = p.segment_id
     WHERE p.campaign_id = ? GROUP BY p.segment_id`,
  ).all(campaign.id);
  const total = segments.reduce((a, s) => ({ contacted: a.contacted + s.contacted, replied: a.replied + s.replied }), { contacted: 0, replied: 0 });
  const avg = total.contacted ? total.replied / total.contacted : 0;
  if (segments.length > 1 && avg > 0) {
    for (const s of segments) {
      if (s.contacted >= 40 && s.replied / s.contacted < avg * 0.5) {
        out.push({
          type: 'insight',
          key: `segment:${campaign.id}:${s.segment}`,
          severity: 'medium',
          title: `${name}: el segmento "${s.segment}" responde poco`,
          reason: `Respuesta ${pct(s.replied, s.contacted)}% vs ${pct(total.replied, total.contacted)}% de la campaña (${s.contacted} contactados). Revisa su problema/gancho en la marca o prioriza otros segmentos.`,
          evidence: s,
          action: null,
        });
      }
    }
  }
  return out;
}

function senderCandidates(db, userId, at) {
  const out = [];
  const since = new Date(at - 14 * DAY_MS).toISOString();
  for (const s of db.prepare("SELECT * FROM senders WHERE user_id = ? AND status IN ('active','error')").all(userId)) {
    if (s.status === 'error') {
      out.push({
        type: 'insight',
        key: `sender_error:${s.id}`,
        severity: 'high',
        title: `${s.email}: el sender no puede enviar`,
        reason: `Google devolvió un error (${s.last_error || 'credenciales'}). Vuelve a conectarlo en Senders.`,
        evidence: { sender_id: s.id },
        action: null,
      });
      continue;
    }
    const r = db.prepare(
      `SELECT COUNT(*) AS sent, COUNT(DISTINCT CASE WHEN p.status = 'bounced' THEN p.id END) AS bounced
       FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE m.sender_id = ? AND m.sent_at > ?`,
    ).get(s.id, since);
    if (r.sent >= 20 && r.bounced / r.sent > 0.05) {
      out.push({
        type: 'pause_sender',
        key: `pause_sender:${s.id}`,
        severity: 'high',
        title: `Pausar ${s.email}: rebote ${pct(r.bounced, r.sent)}%`,
        reason: `${r.bounced} rebotes en ${r.sent} envíos en 14 días (límite sano: 2–3%, máximo 5%). Pausa el buzón y limpia la base antes de seguir.`,
        evidence: { sender_id: s.id, ...r, bounce_rate: pct(r.bounced, r.sent) },
        action: { kind: 'pause_sender', sender_id: s.id },
      });
    }
  }
  return out;
}

export function detectRecommendations(db, userId, at = new Date(), { canGenerate = openaiConfigured() } = {}) {
  const campaigns = db.prepare("SELECT * FROM campaigns WHERE user_id = ? AND status IN ('active','paused')").all(userId);
  const list = [...senderCandidates(db, userId, at)];
  for (const c of campaigns) for (const r of campaignCandidates(db, c, at, { canGenerate })) list.push({ campaign_id: c.id, ...r });
  return list;
}

// ---------------------------------------------------------------------------
// Persistence, permissions and execution
// ---------------------------------------------------------------------------

const t = (type) => Object.hasOwn(RECOMMENDATION_TYPES, type);

export function getPermissions(db, userId) {
  const rows = db.prepare('SELECT type, auto FROM automation_permissions WHERE user_id = ?').all(userId);
  const map = Object.fromEntries(Object.keys(RECOMMENDATION_TYPES).map((t) => [t, false]));
  for (const r of rows) if (t(r.type)) map[r.type] = Boolean(r.auto);
  return map;
}

export function setPermissions(db, userId, changes, at = new Date()) {
  const stmt = db.prepare(
    `INSERT INTO automation_permissions (user_id, type, auto, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (user_id, type) DO UPDATE SET auto = excluded.auto, updated_at = excluded.updated_at`,
  );
  db.transaction(() => {
    for (const [type, auto] of Object.entries(changes)) if (t(type)) stmt.run(userId, type, auto ? 1 : 0, nowIso(at));
  })();
  return getPermissions(db, userId);
}

/** Stores the current recommendations: new ones open, existing ones refresh, gone ones resolve. */
export function syncRecommendations(db, userId, candidates, at = new Date()) {
  const iso = nowIso(at);
  const seen = new Set();
  db.transaction(() => {
    for (const c of candidates) {
      seen.add(c.key);
      const open = db.prepare("SELECT id FROM recommendations WHERE user_id = ? AND key = ? AND status = 'open'").get(userId, c.key);
      const row = {
        title: c.title, reason: c.reason, severity: c.severity, type: c.type,
        evidence_json: JSON.stringify(c.evidence || {}), action_json: c.action ? JSON.stringify(c.action) : null, updated_at: iso,
      };
      if (open) {
        db.prepare(
          'UPDATE recommendations SET title = @title, reason = @reason, severity = @severity, type = @type, evidence_json = @evidence_json, action_json = @action_json, updated_at = @updated_at WHERE id = @id',
        ).run({ ...row, id: open.id });
        continue;
      }
      // Respect recent decisions: a dismissal silences the same recommendation for 14 days,
      // an applied one for 3 days (time for the change to show up in the data).
      const recent = db.prepare(
        `SELECT 1 FROM recommendations WHERE user_id = ? AND key = ? AND (
           (status = 'dismissed' AND decided_at > ?) OR (status IN ('approved','auto_applied','failed') AND decided_at > ?))`,
      ).get(userId, c.key, new Date(at - 14 * DAY_MS).toISOString(), new Date(at - 3 * DAY_MS).toISOString());
      if (recent) continue;
      db.prepare(
        `INSERT INTO recommendations (user_id, campaign_id, type, key, severity, title, reason, evidence_json, action_json, created_at, updated_at)
         VALUES (@user_id, @campaign_id, @type, @key, @severity, @title, @reason, @evidence_json, @action_json, @updated_at, @updated_at)`,
      ).run({ ...row, user_id: userId, campaign_id: c.campaign_id ?? null, key: c.key });
    }
    for (const r of db.prepare("SELECT id, key FROM recommendations WHERE user_id = ? AND status = 'open'").all(userId)) {
      if (!seen.has(r.key)) {
        db.prepare("UPDATE recommendations SET status = 'resolved', result = 'La condición ya no se cumple.', decided_at = ? WHERE id = ?").run(iso, r.id);
      }
    }
  })();
}

/** Executes a recommendation's action. Returns a human-readable result. */
export async function applyAction(db, userId, action, { generateFn = generateVariants, now = () => new Date() } = {}) {
  const ownCampaign = (id) => {
    const c = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(id, userId);
    if (!c) throw new Error('La campaña ya no existe.');
    return c;
  };
  switch (action.kind) {
    case 'pause_variant': {
      const v = db.prepare(
        'SELECT v.* FROM variants v JOIN steps s ON s.id = v.step_id JOIN campaigns c ON c.id = s.campaign_id WHERE v.id = ? AND c.user_id = ?',
      ).get(action.variant_id, userId);
      if (!v) throw new Error('La variante ya no existe.');
      if (v.status !== 'active') return 'La variante ya no estaba activa.';
      const others = db.prepare("SELECT COUNT(*) AS n FROM variants WHERE step_id = ? AND id != ? AND status = 'active'").get(v.step_id, v.id).n;
      if (!others) throw new Error('Es la única variante activa del paso.');
      db.prepare("UPDATE variants SET status = 'paused' WHERE id = ?").run(v.id);
      return `Variante "${v.label}" pausada.`;
    }
    case 'generate_variants': {
      const campaign = ownCampaign(action.campaign_id);
      const r = await generateForStep(db, {
        campaign, stepNumber: action.step_number, segmentName: action.segment, count: action.count, baseVariantId: action.base_variant_id, focus: action.focus, generateFn,
      });
      return `${r.variants.length} variante(s) propuesta(s) creadas: ${r.variants.map((v) => `"${v.label}"`).join(', ')}. Revísalas en Secuencia.`;
    }
    case 'activate_variants': {
      let n = 0;
      for (const id of action.variant_ids) {
        n += db.prepare(
          `UPDATE variants SET status = 'active' WHERE id = ? AND status = 'proposed'
             AND step_id IN (SELECT s.id FROM steps s JOIN campaigns c ON c.id = s.campaign_id WHERE c.user_id = ?)`,
        ).run(id, userId).changes;
      }
      return `${n} variante(s) activadas en la prueba A/B.`;
    }
    case 'approve_drafts': {
      ownCampaign(action.campaign_id);
      const r = approveDrafts(db, action.campaign_id, now());
      return `${r.approved} borrador(es) aprobados${r.skipped_with_errors ? `; ${r.skipped_with_errors} con errores siguen esperando revisión` : ''}.`;
    }
    case 'pause_sender': {
      const n = db.prepare("UPDATE senders SET status = 'paused' WHERE id = ? AND user_id = ? AND status = 'active'").run(action.sender_id, userId).changes;
      return n ? 'Sender pausado.' : 'El sender ya no estaba activo.';
    }
    case 'update_campaign': {
      ownCampaign(action.campaign_id);
      const allowed = ['schedule_json', 'max_per_day'];
      const fields = Object.fromEntries(Object.entries(action.fields).filter(([k]) => allowed.includes(k)));
      if (!Object.keys(fields).length) throw new Error('Nada que actualizar.');
      db.prepare(`UPDATE campaigns SET ${Object.keys(fields).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id: action.campaign_id });
      return fields.max_per_day ? `Límite diario actualizado a ${fields.max_per_day}.` : 'Ventana de envío actualizada.';
    }
    default:
      throw new Error('Acción desconocida.');
  }
}

/** Approves (person) or auto-applies (permission) one open recommendation. */
export async function applyRecommendation(db, rec, { auto = false, ...deps } = {}) {
  if (rec.status !== 'open') throw Object.assign(new Error('La recomendación ya no está abierta.'), { status: 400 });
  if (!rec.action_json) throw Object.assign(new Error('Esta recomendación es informativa: no tiene una acción automática.'), { status: 400 });
  const at = nowIso((deps.now || (() => new Date()))());
  try {
    const result = await applyAction(db, rec.user_id, JSON.parse(rec.action_json), deps);
    db.prepare('UPDATE recommendations SET status = ?, result = ?, decided_at = ? WHERE id = ?').run(auto ? 'auto_applied' : 'approved', result, at, rec.id);
    return { ok: true, result };
  } catch (err) {
    if (auto) db.prepare("UPDATE recommendations SET status = 'failed', result = ?, decided_at = ? WHERE id = ?").run(String(err.message).slice(0, 500), at, rec.id);
    throw err;
  }
}

/**
 * Full cycle for one user (or all users): detect → store → auto-apply permitted types.
 * Called hourly by the scheduler and on demand from the Decisiones page.
 */
export async function runDecisions(db, { userId, generateFn = generateVariants, now = () => new Date(), log = console } = {}) {
  const users = userId ? [{ id: userId }] : db.prepare('SELECT id FROM users').all();
  const summary = { open: 0, auto_applied: 0, failed: 0 };
  for (const u of users) {
    const at = now();
    const canGenerate = generateFn !== generateVariants || openaiConfigured();
    syncRecommendations(db, u.id, detectRecommendations(db, u.id, at, { canGenerate }), at);
    const perms = getPermissions(db, u.id);
    const open = db.prepare("SELECT * FROM recommendations WHERE user_id = ? AND status = 'open' AND action_json IS NOT NULL ORDER BY id").all(u.id);
    for (const rec of open) {
      if (!perms[rec.type]) continue;
      try {
        await applyRecommendation(db, rec, { auto: true, generateFn, now });
        summary.auto_applied += 1;
      } catch (err) {
        summary.failed += 1;
        log.warn?.(`[decisions] auto-apply ${rec.key} failed: ${err.message}`);
      }
    }
    summary.open += db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE user_id = ? AND status = 'open'").get(u.id).n;
  }
  return summary;
}
