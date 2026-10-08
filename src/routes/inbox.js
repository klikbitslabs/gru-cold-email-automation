// Tareas: the single inbox where the platform asks for permission (group messages, suggested
// changes, replies to answer, drafts to review), plus message groups and background jobs.
import { Router } from 'express';
import { z } from 'zod';
import { nowIso } from '../db.js';
import { decrypt } from '../lib/crypto.js';
import { requireAuth } from '../middleware/auth.js';
import { RECOMMENDATION_TYPES } from '../services/decisions.js';
import { gmailForRefreshToken } from '../services/google.js';
import {
  GROUP_BY, approveGroup, generateGroupMessages, listGroups, mergeGroups, regroupCampaign, saveGroupMessages,
} from '../services/groups.js';
import { draftReply, generateVariants } from '../services/openai.js';
import { sendReply } from '../services/replies.js';
import { JOBS } from '../services/scheduler.js';
import { openaiConfigured } from '../services/settings.js';

const toRec = ({ evidence_json: e, action_json: a, ...r }) => ({ ...r, evidence: JSON.parse(e || '{}'), action: a ? JSON.parse(a) : null });

export function inboxRoutes(db, {
  now = () => new Date(),
  generateFn = generateVariants,
  draftFn = draftReply,
  gmailFor = (sender) => gmailForRefreshToken(decrypt(sender.refresh_token_enc)),
} = {}) {
  const router = Router();
  // Per-route auth: mounted on /api next to public endpoints.
  const auth = requireAuth(db);
  const ownCampaign = (req, id = req.params.id) => db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  const ownGroup = (req) => db.prepare(
    'SELECT g.* FROM message_groups g JOIN campaigns c ON c.id = g.campaign_id WHERE g.id = ? AND c.user_id = ?',
  ).get(Number(req.params.id), req.user.id);
  const ownReply = (req) => db.prepare(
    'SELECT r.* FROM replies r JOIN campaigns c ON c.id = r.campaign_id WHERE r.id = ? AND c.user_id = ?',
  ).get(Number(req.params.id), req.user.id);

  function inbox(userId) {
    const groups = db.prepare(
      `SELECT g.id, g.label, g.status, g.campaign_id, c.name AS campaign, c.approval_mode,
         (SELECT COUNT(*) FROM prospects p WHERE p.group_id = g.id AND p.lead_status = 'ready' AND p.status = 'active') AS ready,
         (SELECT COUNT(*) FROM variants v WHERE v.group_id = g.id AND v.status = 'proposed') AS proposed
       FROM message_groups g JOIN campaigns c ON c.id = g.campaign_id
       WHERE c.user_id = ? AND c.status != 'completed' AND (g.status IN ('new','pending') OR EXISTS (SELECT 1 FROM variants v WHERE v.group_id = g.id AND v.status = 'proposed'))
       ORDER BY ready DESC, g.id`,
    ).all(userId).filter((g) => g.ready > 0 || g.proposed > 0);
    const replies = db.prepare(
      `SELECT r.*, p.first_name, p.last_name, p.email, p.title, p.company, c.name AS campaign, pe.name AS persona
       FROM replies r JOIN prospects p ON p.id = r.prospect_id JOIN campaigns c ON c.id = r.campaign_id LEFT JOIN personas pe ON pe.id = p.persona_id
       WHERE c.user_id = ? AND r.status = 'open' ORDER BY r.received_at`,
    ).all(userId);
    const recs = db.prepare(
      `SELECT r.*, c.name AS campaign FROM recommendations r LEFT JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.user_id = ? AND r.status = 'open'
       ORDER BY CASE r.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.id`,
    ).all(userId).map(toRec);
    const drafts = db.prepare(
      `SELECT c.id AS campaign_id, c.name AS campaign, COUNT(*) AS pending,
         SUM(CASE WHEN json_extract(d.quality_json, '$.errors') > 0 THEN 1 ELSE 0 END) AS with_errors
       FROM drafts d JOIN campaigns c ON c.id = d.campaign_id WHERE c.user_id = ? AND d.status = 'pending' GROUP BY c.id`,
    ).all(userId);
    const tasks = db.prepare(
      "SELECT COUNT(*) AS n FROM tasks t JOIN campaigns c ON c.id = t.campaign_id WHERE c.user_id = ? AND t.status = 'open'",
    ).get(userId).n;
    const changes = recs.filter((r) => r.action);
    const alerts = recs.filter((r) => !r.action);
    const draftCount = drafts.reduce((a, d) => a + d.pending, 0);
    return {
      counts: {
        groups: groups.length, replies: replies.length, changes: changes.length, alerts: alerts.length, drafts: draftCount, tasks,
        total: groups.length + replies.length + changes.length + draftCount + tasks,
      },
      groups,
      replies,
      changes,
      alerts,
      drafts,
      types: RECOMMENDATION_TYPES,
    };
  }

  router.get('/inbox', auth, (req, res) => res.json(inbox(req.user.id)));
  router.get('/inbox/count', auth, (req, res) => res.json(inbox(req.user.id).counts));

  router.get('/jobs', auth, (req, res) => {
    const rows = new Map(db.prepare('SELECT * FROM jobs').all().map((j) => [j.name, j]));
    res.json({ jobs: Object.entries(JOBS).map(([name, info]) => ({ name, ...info, ...(rows.get(name) || {}) })) });
  });

  // -------------------------------------------------------------------------
  // Message groups
  // -------------------------------------------------------------------------
  router.get('/campaigns/:id/groups', auth, (req, res) => {
    const c = ownCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ group_by: c.group_by, approval_mode: c.approval_mode, options: GROUP_BY, openai: openaiConfigured() || generateFn !== generateVariants, groups: listGroups(db, c) });
  });

  router.post('/campaigns/:id/groups/regroup', auth, (req, res) => {
    const c = ownCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const { group_by: groupBy } = z.object({ group_by: z.enum(Object.keys(GROUP_BY)) }).parse(req.body);
    db.prepare('UPDATE campaigns SET group_by = ? WHERE id = ?').run(groupBy, c.id);
    regroupCampaign(db, { ...c, group_by: groupBy });
    res.json({ groups: listGroups(db, ownCampaign(req)) });
  });

  router.post('/campaigns/:id/groups/merge', auth, (req, res) => {
    const c = ownCampaign(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const input = z.object({ target_id: z.number().int(), source_ids: z.array(z.number().int()).min(1), label: z.string().trim().max(120).optional() }).parse(req.body);
    const get = (id) => db.prepare('SELECT * FROM message_groups WHERE id = ? AND campaign_id = ?').get(id, c.id);
    const target = get(input.target_id);
    const sources = input.source_ids.filter((id) => id !== input.target_id).map(get);
    if (!target || sources.some((s) => !s)) return res.status(404).json({ error: 'Grupo no encontrado' });
    mergeGroups(db, target, sources);
    if (input.label) db.prepare('UPDATE message_groups SET label = ? WHERE id = ?').run(input.label, target.id);
    res.json({ groups: listGroups(db, c) });
  });

  router.post('/groups/:id/generate', auth, async (req, res) => {
    const g = ownGroup(req);
    if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(g.campaign_id);
    res.json(await generateGroupMessages(db, { campaign, group: g, generateFn }));
  });

  router.put('/groups/:id', auth, (req, res) => {
    const g = ownGroup(req);
    if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
    const input = z.object({
      label: z.string().trim().min(1).max(120).optional(),
      messages: z.array(z.object({ id: z.number().int(), subject: z.string().trim().max(200).default(''), body: z.string().trim().min(1, 'El mensaje no puede estar vacío').max(5000) })).default([]),
    }).parse(req.body);
    if (input.label) db.prepare('UPDATE message_groups SET label = ? WHERE id = ?').run(input.label, g.id);
    saveGroupMessages(db, g, input.messages);
    res.json({ ok: true });
  });

  router.post('/groups/:id/:action', auth, (req, res) => {
    const { action } = req.params;
    if (!['approve', 'pause', 'resume'].includes(action)) return res.status(404).json({ error: 'Acción desconocida' });
    const g = ownGroup(req);
    if (!g) return res.status(404).json({ error: 'Grupo no encontrado' });
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(g.campaign_id);
    if (action === 'approve') approveGroup(db, campaign, g, now());
    else if (action === 'pause') db.prepare("UPDATE message_groups SET status = 'paused' WHERE id = ?").run(g.id);
    else db.prepare("UPDATE message_groups SET status = CASE WHEN approved_at IS NULL THEN 'pending' ELSE 'approved' END WHERE id = ?").run(g.id);
    res.json({ ok: true });
  });

  // -------------------------------------------------------------------------
  // Replies
  // -------------------------------------------------------------------------
  router.patch('/replies/:id', auth, (req, res) => {
    const r = ownReply(req);
    if (!r) return res.status(404).json({ error: 'Respuesta no encontrada' });
    const { body } = z.object({ body: z.string().trim().min(1).max(5000) }).parse(req.body);
    db.prepare('UPDATE replies SET draft_body = ? WHERE id = ?').run(body, r.id);
    res.json({ ok: true });
  });

  router.post('/replies/:id/redraft', auth, async (req, res) => {
    const r = ownReply(req);
    if (!r) return res.status(404).json({ error: 'Respuesta no encontrada' });
    if (draftFn === draftReply && !openaiConfigured()) return res.status(400).json({ error: 'Configura OpenAI en Integraciones para redactar con IA.' });
    const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(r.prospect_id);
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(r.campaign_id);
    const brand = campaign.brand_id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(campaign.brand_id) : null;
    const persona = prospect.persona_id ? db.prepare('SELECT * FROM personas WHERE id = ?').get(prospect.persona_id) : null;
    const sender = r.sender_id ? db.prepare('SELECT * FROM senders WHERE id = ?').get(r.sender_id) : null;
    const last = db.prepare('SELECT body_text FROM messages WHERE prospect_id = ? ORDER BY step_number DESC LIMIT 1').get(prospect.id);
    const out = await draftFn({ brand, persona, prospect, sender, category: r.category, replyText: r.snippet, lastEmail: last?.body_text || '', meetingLink: brand?.meeting_link || '' });
    db.prepare("UPDATE replies SET draft_subject = ?, draft_body = ?, draft_engine = 'ai' WHERE id = ?").run(out.subject || '', out.body, r.id);
    res.json({ body: out.body });
  });

  router.post('/replies/:id/send', auth, async (req, res) => {
    const r = ownReply(req);
    if (!r) return res.status(404).json({ error: 'Respuesta no encontrada' });
    const { body } = z.object({ body: z.string().trim().min(1, 'La respuesta está vacía').max(5000) }).parse(req.body);
    if (/\[(día|hora|Responde)/i.test(body)) return res.status(400).json({ error: 'Completa los marcadores [día] / [hora] / [Responde…] antes de enviar.' });
    res.json(await sendReply(db, r, { body, gmailFor, now }));
  });

  router.post('/replies/:id/dismiss', auth, (req, res) => {
    const r = ownReply(req);
    if (!r) return res.status(404).json({ error: 'Respuesta no encontrada' });
    db.prepare("UPDATE replies SET status = 'dismissed', handled_at = ? WHERE id = ? AND status = 'open'").run(nowIso(now()), r.id);
    res.json({ ok: true });
  });

  return router;
}
