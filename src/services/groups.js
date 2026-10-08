// Message groups ("clusters"): prospects grouped by industry × buyer persona (or another
// criterion chosen per campaign). Each group gets its own short sequence written in simple
// language; the user approves it once and every prospect of the group then receives it.

import { nowIso } from '../db.js';
import { lintTemplate } from '../lib/quality.js';
import { generateVariants } from './openai.js';
import { candidatesFor, loadSequence, renderDraft } from './scheduler.js';
import { openaiConfigured } from './settings.js';

export const GROUP_BY = {
  industry_persona: 'Industria × perfil',
  persona: 'Perfil de comprador',
  industry: 'Industria',
  segment: 'Segmento',
  single: 'Un solo grupo',
};

const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
const nice = (s) => {
  const t = String(s || '').trim();
  return t ? t.charAt(0).toUpperCase() + t.slice(1) : t;
};

/** Group identity of a prospect for the campaign's grouping criterion. */
export function groupIdentity(groupBy, { industry, persona, segment }) {
  const ind = nice(industry) || 'Sin industria';
  const per = persona?.name || 'Sin perfil';
  switch (groupBy) {
    case 'persona':
      return { key: `p:${persona?.id || 0}`, label: per, industry: '', persona_id: persona?.id ?? null, segment_id: null };
    case 'industry':
      return { key: `i:${norm(ind)}`, label: ind, industry: ind, persona_id: null, segment_id: null };
    case 'segment':
      return { key: `s:${segment?.id || 0}`, label: segment?.name || 'Sin segmento', industry: '', persona_id: null, segment_id: segment?.id ?? null };
    case 'single':
      return { key: 'all', label: 'Todos los prospectos', industry: '', persona_id: null, segment_id: null };
    default:
      return { key: `i:${norm(ind)}|p:${persona?.id || 0}`, label: `${ind} · ${per}`, industry: ind, persona_id: persona?.id ?? null, segment_id: null };
  }
}

/** Puts a prospect in its group (creating the group the first time). Excluded leads have none. */
export function assignGroup(db, campaign, prospect) {
  if (prospect.lead_status === 'excluded') {
    db.prepare('UPDATE prospects SET group_id = NULL WHERE id = ?').run(prospect.id);
    return null;
  }
  const persona = prospect.persona_id ? db.prepare('SELECT id, name FROM personas WHERE id = ?').get(prospect.persona_id) : null;
  const segment = prospect.segment_id ? db.prepare('SELECT id, name FROM segments WHERE id = ?').get(prospect.segment_id) : null;
  const id = groupIdentity(campaign.group_by || 'industry_persona', { industry: prospect.industry, persona, segment });
  let group = db.prepare(
    `SELECT g.* FROM message_groups g WHERE g.campaign_id = ? AND (g.key = ? OR EXISTS (SELECT 1 FROM json_each(g.keys_json) j WHERE j.value = ?))`,
  ).get(campaign.id, id.key, id.key);
  if (!group) {
    const gid = Number(db.prepare(
      'INSERT INTO message_groups (campaign_id, key, label, industry, persona_id, segment_id) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(campaign.id, id.key, id.label, id.industry, id.persona_id, id.segment_id).lastInsertRowid);
    group = db.prepare('SELECT * FROM message_groups WHERE id = ?').get(gid);
  }
  db.prepare('UPDATE prospects SET group_id = ? WHERE id = ?').run(group.id, prospect.id);
  return group;
}

/** Re-clusters every lead of the campaign (after changing the criterion). Empty groups are removed. */
export function regroupCampaign(db, campaign) {
  const prospects = db.prepare("SELECT * FROM prospects WHERE campaign_id = ? AND intel_at IS NOT NULL").all(campaign.id);
  db.transaction(() => {
    for (const p of prospects) assignGroup(db, campaign, p);
    db.prepare('DELETE FROM message_groups WHERE campaign_id = ? AND NOT EXISTS (SELECT 1 FROM prospects p WHERE p.group_id = message_groups.id)').run(campaign.id);
  })();
}

const emailSteps = (db, campaignId) => loadSequence(db, campaignId).filter((s) => s.channel === 'email');

/** Groups of a campaign with their leads and their messages per email step (with quality issues). */
export function listGroups(db, campaign) {
  const steps = emailSteps(db, campaign.id);
  const groups = db.prepare(
    `SELECT g.*, pe.name AS persona,
       (SELECT COUNT(*) FROM prospects p WHERE p.group_id = g.id) AS prospects,
       (SELECT COUNT(*) FROM prospects p WHERE p.group_id = g.id AND p.lead_status = 'ready' AND p.status = 'active') AS ready,
       (SELECT COUNT(*) FROM prospects p WHERE p.group_id = g.id AND p.lead_status = 'research') AS research,
       (SELECT COUNT(DISTINCT p.company_id) FROM prospects p WHERE p.group_id = g.id) AS companies,
       (SELECT COUNT(*) FROM messages m JOIN prospects p ON p.id = m.prospect_id WHERE p.group_id = g.id) AS sent,
       (SELECT COUNT(*) FROM prospects p WHERE p.group_id = g.id AND p.status = 'replied' AND p.reply_category NOT IN ('bounce','auto_reply')) AS replied,
       (SELECT COUNT(*) FROM prospects p WHERE p.group_id = g.id AND p.outcome IN ('meeting','opportunity','won')) AS meetings
     FROM message_groups g LEFT JOIN personas pe ON pe.id = g.persona_id
     WHERE g.campaign_id = ? ORDER BY ready DESC, g.id`,
  ).all(campaign.id);
  const variants = db.prepare(
    `SELECT v.*, s.step_number, s.same_thread FROM variants v JOIN steps s ON s.id = v.step_id
     WHERE s.campaign_id = ? AND v.group_id IS NOT NULL AND v.status IN ('active','proposed') ORDER BY s.step_number, v.id`,
  ).all(campaign.id);
  const sender = db.prepare(
    "SELECT s.* FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id WHERE cs.campaign_id = ? ORDER BY s.status = 'active' DESC, s.id LIMIT 1",
  ).get(campaign.id);
  // How a real prospect of the group will read each message (personalization filled in).
  const preview = (g, st, v) => {
    const prospect = db.prepare("SELECT * FROM prospects WHERE group_id = ? ORDER BY lead_status = 'ready' DESC, id LIMIT 1").get(g.id);
    if (!prospect) return null;
    const c = candidatesFor(db, { campaign, prospect, step: st, sender });
    const r = renderDraft({ prospect, sender, variant: v, cta: c.ctas[0], hook: c.hooks[0], problem: c.problems[0], step: st, threadSubject: null, fallbackSubject: '' });
    return { to: [prospect.first_name, prospect.last_name].filter(Boolean).join(' ') || prospect.email, company: prospect.company, subject: r.subject, body: r.body, missing: r.missing };
  };
  return groups.map((g) => ({
    ...g,
    keys: JSON.parse(g.keys_json || '[]'),
    keys_json: undefined,
    messages: steps.map((st) => ({
      step_number: st.step_number,
      same_thread: Boolean(st.same_thread) && st.step_number > 1,
      delay_days: st.delay_days,
      variants: variants.filter((v) => v.group_id === g.id && v.step_number === st.step_number).map((v) => ({
        id: v.id, status: v.status, origin: v.origin, label: v.label, subject: v.subject, body: v.body, rationale: v.rationale,
        issues: lintTemplate({ subject: v.subject, body: v.body, stepNumber: st.step_number, threadReply: st.step_number > 1 && Boolean(st.same_thread) }).issues,
        preview: preview(g, st, v),
      })),
    })),
  }));
}

/**
 * Writes the group's sequence: with OpenAI, one message per email step written for the group's
 * industry and persona in simple language; without it, the campaign's base templates.
 * Messages are saved as proposals until the user approves the group.
 */
export async function generateGroupMessages(db, { campaign, group, generateFn = generateVariants }) {
  const steps = emailSteps(db, campaign.id);
  if (!steps.length) throw Object.assign(new Error('La campaña no tiene pasos de correo.'), { status: 400 });
  const brand = campaign.brand_id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(campaign.brand_id) : null;
  const persona = group.persona_id ? db.prepare('SELECT * FROM personas WHERE id = ?').get(group.persona_id) : null;
  const segment = group.segment_id ? db.prepare('SELECT * FROM segments WHERE id = ?').get(group.segment_id) : null;
  const useAI = Boolean(brand) && (generateFn !== generateVariants || openaiConfigured());
  const sample = db.prepare('SELECT fields_json FROM prospects WHERE campaign_id = ? LIMIT 1').get(campaign.id);
  const fields = Object.keys(JSON.parse(sample?.fields_json || '{}')).slice(0, 15);
  const created = [];
  const drafts = [];
  // Generate first (network), then write everything in one transaction.
  for (const step of steps) {
    if (useAI) {
      const result = await generateFn({
        brand, campaign, segment, persona, industry: group.industry, stepNumber: step.step_number, channel: 'email',
        sameThread: Boolean(step.same_thread), count: 1, focus: 'simple', performance: [], fields,
      });
      const v = result.variants[0];
      drafts.push({ step, subject: v.subject, body: v.body, rationale: v.rationale || '', origin: 'ai' });
    } else {
      const base = step.variants.filter((v) => !v.group_id && v.status === 'active');
      const pick = base.find((v) => persona && v.persona_id === persona.id) || base.find((v) => !v.persona_id) || base[0];
      if (pick) drafts.push({ step, subject: pick.subject, body: pick.body, rationale: `Plantilla base "${pick.label}"`, origin: 'manual' });
    }
  }
  db.transaction(() => {
    db.prepare("DELETE FROM variants WHERE group_id = ? AND status = 'proposed'").run(group.id);
    for (const d of drafts) {
      const id = Number(db.prepare(
        "INSERT INTO variants (step_id, label, angle, segment_id, persona_id, group_id, subject, body, status, origin, rationale) VALUES (?, ?, '', ?, ?, ?, ?, ?, 'proposed', ?, ?)",
      ).run(d.step.id, `${group.label} · paso ${d.step.step_number}`.slice(0, 60), group.segment_id, group.persona_id, group.id, d.subject, d.body, d.origin, d.rationale).lastInsertRowid);
      created.push({ id, step_number: d.step.step_number });
    }
    if (group.status !== 'approved') db.prepare("UPDATE message_groups SET status = 'pending' WHERE id = ?").run(group.id);
  })();
  return { engine: useAI ? 'ai' : 'template', variants: created };
}

/** Edits the subject/body of the group's messages. */
export function saveGroupMessages(db, group, list) {
  const stmt = db.prepare('UPDATE variants SET subject = ?, body = ? WHERE id = ? AND group_id = ?');
  db.transaction(() => {
    for (const v of list) stmt.run(v.subject ?? '', v.body, v.id, group.id);
  })();
}

/** Approves the group's proposed messages: they replace the previous ones and sending can start. */
export function approveGroup(db, campaign, group, at = new Date()) {
  const steps = emailSteps(db, campaign.id);
  const own = db.prepare(
    `SELECT v.*, s.step_number, s.same_thread FROM variants v JOIN steps s ON s.id = v.step_id WHERE v.group_id = ? AND v.status IN ('active','proposed')`,
  ).all(group.id);
  const problems = [];
  for (const st of steps) {
    const mine = own.filter((v) => v.step_number === st.step_number);
    if (!mine.length) problems.push(`Paso ${st.step_number}: falta el mensaje.`);
    for (const v of mine.filter((x) => x.status === 'proposed')) {
      const errors = lintTemplate({ subject: v.subject, body: v.body, stepNumber: st.step_number, threadReply: st.step_number > 1 && Boolean(st.same_thread) })
        .issues.filter((i) => i.severity === 'error');
      for (const e of errors) problems.push(`Paso ${st.step_number}: ${e.message}`);
    }
  }
  if (problems.length) throw Object.assign(new Error(problems.join(' ')), { status: 400 });
  db.transaction(() => {
    for (const st of steps) {
      const proposed = own.filter((v) => v.step_number === st.step_number && v.status === 'proposed');
      if (!proposed.length) continue;
      db.prepare("UPDATE variants SET status = 'paused' WHERE group_id = ? AND step_id = ? AND status = 'active'").run(group.id, st.id);
      for (const v of proposed) db.prepare("UPDATE variants SET status = 'active' WHERE id = ?").run(v.id);
    }
    db.prepare("UPDATE message_groups SET status = 'approved', approved_at = ? WHERE id = ?").run(nowIso(at), group.id);
  })();
}

/** Clusters several groups into one: their leads move to the target and keep arriving there. */
export function mergeGroups(db, target, sources) {
  db.transaction(() => {
    const keys = new Set(JSON.parse(target.keys_json || '[]'));
    for (const s of sources) {
      keys.add(s.key);
      for (const k of JSON.parse(s.keys_json || '[]')) keys.add(k);
      db.prepare('UPDATE prospects SET group_id = ? WHERE group_id = ?').run(target.id, s.id);
      db.prepare('DELETE FROM message_groups WHERE id = ?').run(s.id);
    }
    db.prepare('UPDATE message_groups SET keys_json = ? WHERE id = ?').run(JSON.stringify([...keys]), target.id);
  })();
}
