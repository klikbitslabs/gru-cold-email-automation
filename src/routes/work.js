// Day-to-day work: reviewing drafts, completing call/LinkedIn tasks, recording outcomes.
import { Router } from 'express';
import { z } from 'zod';
import { nowIso } from '../db.js';
import { checkDraft } from '../lib/quality.js';
import { requireAuth } from '../middleware/auth.js';
import { abRecommendations } from '../lib/ab.js';
import { abGroups, approveDrafts, generateForStep } from '../services/decisions.js';
import { nextAction } from '../lib/leads.js';
import { LAWFUL_BASES } from '../lib/validate.js';
import { analyzeProspect } from '../services/jev.js';
import { generateVariants } from '../services/openai.js';
import { advanceProspect, analyzeAndClassify, loadSequence, setOutcome } from '../services/scheduler.js';
import { openaiConfigured } from '../services/settings.js';

const OUTCOMES = ['interested', 'meeting', 'opportunity', 'won', 'lost'];
const TASK_OUTCOMES = {
  no_answer: 'Sin respuesta',
  conversation: 'Conversación',
  connected: 'Conexión aceptada (LinkedIn)',
  meeting: 'Reunión agendada',
  not_interested: 'No interesado',
  done: 'Hecho',
};

export function workRoutes(db, { now = () => new Date(), analyzeFn = analyzeProspect, generateFn = generateVariants } = {}) {
  const router = Router();
  // Per-route auth: this router is mounted on /api next to public endpoints.
  const auth = requireAuth(db);

  const ownDraft = (req) => db.prepare(
    'SELECT d.* FROM drafts d JOIN campaigns c ON c.id = d.campaign_id WHERE d.id = ? AND c.user_id = ?',
  ).get(Number(req.params.id), req.user.id);
  const ownProspect = (req, id = req.params.id) => db.prepare(
    'SELECT p.* FROM prospects p JOIN campaigns c ON c.id = p.campaign_id WHERE p.id = ? AND c.user_id = ?',
  ).get(Number(id), req.user.id);
  const ownTask = (req) => db.prepare(
    'SELECT t.* FROM tasks t JOIN campaigns c ON c.id = t.campaign_id WHERE t.id = ? AND c.user_id = ?',
  ).get(Number(req.params.id), req.user.id);

  function recheck(draft, subject, body) {
    const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(draft.prospect_id);
    const sender = db.prepare('SELECT * FROM senders WHERE id = ?').get(draft.sender_id);
    const previous = JSON.parse(draft.quality_json || '{}');
    const quality = checkDraft({
      subject,
      body,
      stepNumber: draft.step_number,
      threadReply: Boolean(draft.same_thread),
      personalized: previous.personalized,
      sender,
      prospect,
    });
    quality.personalized = previous.personalized;
    return quality;
  }

  function approve(draft, at) {
    db.prepare("UPDATE drafts SET status = 'approved', reviewed_at = ? WHERE id = ?").run(nowIso(at), draft.id);
    // Make the prospect due again so the next tick sends it (inside the sending window).
    db.prepare("UPDATE prospects SET next_send_at = ? WHERE id = ? AND status = 'active'").run(nowIso(at), draft.prospect_id);
  }

  // ---------------------------------------------------------------------------
  // Drafts (approval queue)
  // ---------------------------------------------------------------------------
  router.patch('/drafts/:id', auth, (req, res) => {
    const draft = ownDraft(req);
    if (!draft || draft.status !== 'pending') return res.status(404).json({ error: 'Borrador no encontrado o ya revisado' });
    const { subject, body } = z.object({ subject: z.string().trim().min(1).max(200), body: z.string().trim().min(1).max(5000) }).parse(req.body);
    const quality = recheck(draft, subject, body);
    db.prepare('UPDATE drafts SET subject = ?, body = ?, quality_json = ? WHERE id = ?').run(subject, body, JSON.stringify(quality), draft.id);
    res.json({ quality });
  });

  router.post('/drafts/:id/approve', auth, (req, res) => {
    const draft = ownDraft(req);
    if (!draft || draft.status !== 'pending') return res.status(404).json({ error: 'Borrador no encontrado o ya revisado' });
    const { force } = z.object({ force: z.boolean().default(false) }).parse(req.body || {});
    const quality = JSON.parse(draft.quality_json || '{}');
    if (quality.errors && !force) {
      return res.status(400).json({ error: `El borrador tiene ${quality.errors} error(es) de calidad. Edítalo o confirma que quieres enviarlo igualmente.`, quality });
    }
    approve(draft, now());
    res.json({ ok: true });
  });

  router.post('/drafts/:id/reject', auth, (req, res) => {
    const draft = ownDraft(req);
    if (!draft || draft.status !== 'pending') return res.status(404).json({ error: 'Borrador no encontrado o ya revisado' });
    const { action } = z.object({ action: z.enum(['regenerate', 'stop']).default('regenerate') }).parse(req.body || {});
    const at = nowIso(now());
    db.prepare("UPDATE drafts SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(at, draft.id);
    if (action === 'stop') {
      db.prepare("UPDATE prospects SET status = 'stopped', next_send_at = NULL, stop_reason = 'Descartado en revisión' WHERE id = ?").run(draft.prospect_id);
    } else {
      db.prepare("UPDATE prospects SET next_send_at = ? WHERE id = ? AND status = 'active'").run(at, draft.prospect_id);
    }
    res.json({ ok: true });
  });

  /** Approves every pending draft of a campaign that passed quality control (no errors). */
  router.post('/campaigns/:id/drafts/approve-all', auth, (req, res) => {
    const campaign = db.prepare('SELECT id FROM campaigns WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json(approveDrafts(db, campaign.id, now()));
  });

  // ---------------------------------------------------------------------------
  // Tasks (cold call / LinkedIn)
  // ---------------------------------------------------------------------------
  router.get('/tasks', auth, (req, res) => {
    const status = ['open', 'done', 'skipped'].includes(req.query.status) ? req.query.status : 'open';
    const tasks = db.prepare(
      `SELECT t.*, p.email, p.first_name, p.last_name, p.company, p.title, p.phone, p.linkedin_url, c.name AS campaign_name
       FROM tasks t JOIN prospects p ON p.id = t.prospect_id JOIN campaigns c ON c.id = t.campaign_id
       WHERE c.user_id = ? AND t.status = ? ORDER BY t.created_at LIMIT 300`,
    ).all(req.user.id, status);
    res.json({ tasks, outcomes: TASK_OUTCOMES });
  });

  router.post('/tasks/:id/complete', auth, (req, res) => {
    const task = ownTask(req);
    if (!task || task.status !== 'open') return res.status(404).json({ error: 'Tarea no encontrada o ya cerrada' });
    const { outcome, note, skip } = z.object({
      outcome: z.enum(Object.keys(TASK_OUTCOMES)).default('done'),
      note: z.string().trim().max(1000).default(''),
      skip: z.boolean().default(false),
    }).parse(req.body || {});
    const at = now();
    const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(task.prospect_id);
    db.transaction(() => {
      db.prepare('UPDATE tasks SET status = ?, outcome = ?, note = ?, completed_at = ? WHERE id = ?')
        .run(skip ? 'skipped' : 'done', skip ? null : outcome, note, nowIso(at), task.id);
      if (!skip && outcome === 'meeting') {
        setOutcome(db, prospect, 'meeting', at);
      } else if (!skip && outcome === 'not_interested') {
        db.prepare("UPDATE prospects SET status = 'stopped', next_send_at = NULL, stop_reason = 'No interesado (llamada/LinkedIn)', reply_category = 'not_interested' WHERE id = ?").run(prospect.id);
        const userId = db.prepare('SELECT user_id FROM campaigns WHERE id = ?').get(task.campaign_id).user_id;
        db.prepare("INSERT OR IGNORE INTO suppressions (user_id, email, reason) VALUES (?, ?, 'not_interested')").run(userId, prospect.email);
      } else if (prospect.status === 'active') {
        advanceProspect(db, prospect, loadSequence(db, task.campaign_id), task.step_number, at);
      }
    })();
    res.json({ ok: true });
  });

  // ---------------------------------------------------------------------------
  // Prospects
  // ---------------------------------------------------------------------------
  router.get('/prospects/:id', auth, (req, res) => {
    const p = ownProspect(req);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const messages = db.prepare(
      `SELECT m.id, m.step_number, m.subject, m.body_text, m.sent_at, m.open_count, m.first_opened_at, m.last_opened_at,
              v.label AS variant_label, ct.label AS cta_label, s.email AS sender_email
       FROM messages m LEFT JOIN variants v ON v.id = m.variant_id LEFT JOIN ctas ct ON ct.id = m.cta_id LEFT JOIN senders s ON s.id = m.sender_id
       WHERE m.prospect_id = ? ORDER BY m.step_number`,
    ).all(p.id);
    const opens = db.prepare(
      'SELECT oe.message_id, oe.opened_at, oe.user_agent, oe.suspected_bot FROM open_events oe JOIN messages m ON m.id = oe.message_id WHERE m.prospect_id = ? ORDER BY oe.opened_at DESC LIMIT 100',
    ).all(p.id);
    const decisions = db.prepare('SELECT step_number, engine, action, detail_json, created_at FROM decisions WHERE prospect_id = ? ORDER BY id DESC LIMIT 50').all(p.id)
      .map(({ detail_json: detail, ...d }) => ({ ...d, detail: JSON.parse(detail) }));
    const tasks = db.prepare('SELECT id, step_number, channel, status, outcome, note, created_at, completed_at FROM tasks WHERE prospect_id = ? ORDER BY id').all(p.id);
    const drafts = db.prepare("SELECT id, step_number, status, subject FROM drafts WHERE prospect_id = ? AND status IN ('pending','approved') ORDER BY id").all(p.id);
    const segment = p.segment_id ? db.prepare('SELECT name FROM segments WHERE id = ?').get(p.segment_id)?.name : null;
    const company = p.company_id ? db.prepare('SELECT id, name, domain FROM companies WHERE id = ?').get(p.company_id) : null;
    const intel = p.intel_json ? JSON.parse(p.intel_json) : null;
    const questions = [...(intel?.questions || []), nextAction(db, p)];
    const { seen_message_ids_json: _seen, pending_decision_json: _pending, unsubscribe_token: _token, fields_json: fieldsJson, intel_json: intelJson, ...prospect } = p;
    res.json({
      prospect: { ...prospect, segment, company_info: company, fields: JSON.parse(fieldsJson || '{}'), intel },
      questions,
      messages,
      opens,
      decisions,
      tasks,
      drafts,
    });
  });

  router.patch('/prospects/:id', auth, async (req, res) => {
    const p = ownProspect(req);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const { status, outcome, data } = z.object({
      status: z.enum(['active', 'stopped']).optional(),
      outcome: z.enum(OUTCOMES).optional(),
      // Research: complete the lead's data and re-run the analysis right away.
      data: z.object({
        first_name: z.string().trim().max(120).optional(),
        last_name: z.string().trim().max(120).optional(),
        title: z.string().trim().max(200).optional(),
        company: z.string().trim().max(200).optional(),
        industry: z.string().trim().max(200).optional(),
        country: z.string().trim().max(100).optional(),
        phone: z.string().trim().max(60).optional(),
        linkedin_url: z.string().trim().max(300).optional(),
        source: z.string().trim().max(120).optional(),
        lawful_basis: z.enum(Object.keys(LAWFUL_BASES)).optional(),
      }).optional(),
    }).parse(req.body);
    const at = now();
    if (data && Object.keys(data).length) {
      const keys = Object.keys(data);
      db.prepare(`UPDATE prospects SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...data, id: p.id });
      // Leads excluded only by the analysis can come back once their data is fixed.
      if (p.status === 'stopped' && /^Excluido/.test(p.stop_reason || '')) {
        db.prepare("UPDATE prospects SET status = 'active', stop_reason = NULL, next_send_at = ? WHERE id = ?").run(nowIso(at), p.id);
      }
      const fresh = db.prepare('SELECT * FROM prospects WHERE id = ?').get(p.id);
      const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(p.campaign_id);
      const { verdict } = await analyzeAndClassify(db, fresh, campaign, { analyzeFn, now });
      if (verdict.status === 'ready' && !fresh.next_send_at && fresh.status === 'active' && campaign.status === 'active') {
        db.prepare('UPDATE prospects SET next_send_at = ? WHERE id = ?').run(nowIso(at), p.id);
      }
      return res.json({ ok: true, lead_status: verdict.status, reasons: verdict.reasons });
    }
    if (outcome) setOutcome(db, p, outcome, at);
    if (status === 'stopped') {
      db.prepare("UPDATE prospects SET status = 'stopped', next_send_at = NULL, stop_reason = 'Detenido manualmente' WHERE id = ?").run(p.id);
      db.prepare("UPDATE drafts SET status = 'rejected', reviewed_at = ? WHERE prospect_id = ? AND status IN ('pending','approved')").run(nowIso(at), p.id);
    } else if (status === 'active') {
      if (p.status !== 'stopped' && p.status !== 'active') {
        return res.status(400).json({ error: `No se puede reactivar un prospecto en estado "${p.status}"` });
      }
      if (p.validation_status === 'invalid') return res.status(400).json({ error: 'El email del prospecto es inválido.' });
      db.prepare("UPDATE prospects SET status = 'active', next_send_at = ?, stop_reason = NULL WHERE id = ?").run(p.next_send_at || nowIso(at), p.id);
    }
    res.json({ ok: true });
  });

  router.delete('/prospects/:id', auth, (req, res) => {
    const p = ownProspect(req);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    db.prepare('DELETE FROM prospects WHERE id = ?').run(p.id);
    res.status(204).end();
  });

  // ---------------------------------------------------------------------------
  // Variants: approve AI proposals, pause/resume in the A/B rotation
  // ---------------------------------------------------------------------------
  const ownVariant = (req) => db.prepare(
    `SELECT v.*, s.campaign_id, s.step_number FROM variants v JOIN steps s ON s.id = v.step_id JOIN campaigns c ON c.id = s.campaign_id
     WHERE v.id = ? AND c.user_id = ?`,
  ).get(Number(req.params.id), req.user.id);

  router.post('/variants/:id/:action', auth, (req, res) => {
    const { action } = req.params;
    if (!['approve', 'pause', 'activate', 'reject'].includes(action)) return res.status(404).json({ error: 'Acción desconocida' });
    const v = ownVariant(req);
    if (!v) return res.status(404).json({ error: 'Variante no encontrada' });
    if (action === 'reject') {
      if (v.status !== 'proposed') return res.status(400).json({ error: 'Solo se descartan variantes propuestas' });
      db.prepare('DELETE FROM variants WHERE id = ?').run(v.id);
      return res.json({ ok: true });
    }
    if (action === 'pause') {
      const others = db.prepare("SELECT COUNT(*) AS n FROM variants WHERE step_id = ? AND id != ? AND status = 'active'").get(v.step_id, v.id).n;
      if (!others) return res.status(400).json({ error: 'No se puede pausar la única variante activa del paso.' });
    }
    db.prepare('UPDATE variants SET status = ? WHERE id = ?').run(action === 'pause' ? 'paused' : 'active', v.id);
    return res.json({ ok: true });
  });

  router.post('/campaigns/:id/ai/variants', auth, async (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (generateFn === generateVariants && !openaiConfigured()) {
      return res.status(400).json({ error: 'Configura la API key de OpenAI en Integraciones para generar textos.' });
    }
    const input = z.object({
      step_number: z.number().int().min(1),
      segment: z.string().trim().max(80).default(''),
      count: z.number().int().min(1).max(3).default(2),
      base_variant_id: z.number().int().optional(),
    }).parse(req.body);
    const result = await generateForStep(db, {
      campaign, stepNumber: input.step_number, segmentName: input.segment, count: input.count, baseVariantId: input.base_variant_id, generateFn,
    });
    res.status(201).json(result);
  });

  router.get('/campaigns/:id/ab', auth, (req, res) => {
    const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!campaign) return res.status(404).json({ error: 'Campaña no encontrada' });
    const list = abGroups(db, campaign.id);
    res.json({ groups: list, recommendations: abRecommendations(list), openai: openaiConfigured() });
  });

  return router;
}
