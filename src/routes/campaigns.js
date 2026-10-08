import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { nowIso } from '../db.js';
import { randomToken } from '../lib/crypto.js';
import { parseProspectsCsv } from '../lib/csv.js';
import { lintEmail } from '../lib/lint.js';
import { templateFields } from '../lib/template.js';
import { isValidTimeZone } from '../lib/time.js';
import { requireAuth } from '../middleware/auth.js';
import { decide } from '../services/jev.js';
import { engagementFor, loadSequence, renderStep } from '../services/scheduler.js';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM');

const variantSchema = z.object({
  id: z.number().int().optional(),
  label: z.string().trim().min(1).max(60),
  angle: z.string().trim().max(500).default(''),
  subject: z.string().trim().max(200).default(''),
  body: z.string().trim().min(1, 'El cuerpo del correo no puede estar vacío').max(5000),
});

const campaignSchema = z.object({
  name: z.string().trim().min(1).max(120),
  offer: z.string().trim().max(3000).default(''),
  icp: z.string().trim().max(3000).default(''),
  timezone: z.string().refine(isValidTimeZone, 'Zona horaria inválida').default('America/Panama'),
  send_days: z.array(z.number().int().min(1).max(7)).min(1).default([1, 2, 3, 4, 5]),
  window_start: HHMM.default('08:00'),
  window_end: HHMM.default('17:00'),
  track_opens: z.boolean().default(true),
  include_unsubscribe: z.boolean().default(true),
  jev_enabled: z.boolean().default(true),
  stop_on_reply: z.boolean().default(true),
  sender_ids: z.array(z.number().int()).default([]),
  steps: z
    .array(
      z.object({
        delay_days: z.number().int().min(0).max(60).default(3),
        same_thread: z.boolean().default(true),
        variants: z.array(variantSchema).min(1, 'Cada paso necesita al menos una variante').max(5),
      }),
    )
    .max(config.sequence.maxSteps, `Máximo ${config.sequence.maxSteps} envíos por secuencia`)
    .default([]),
  ctas: z
    .array(
      z.object({
        id: z.number().int().optional(),
        label: z.string().trim().min(1).max(60),
        description: z.string().trim().max(300).default(''),
        text: z.string().trim().min(1).max(500),
      }),
    )
    .max(6)
    .default([]),
}).refine((c) => c.window_start < c.window_end, { message: 'La ventana de envío debe terminar después de empezar', path: ['window_end'] });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

const STAT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id) AS prospects,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'active') AS active,
    (SELECT COUNT(*) FROM messages WHERE campaign_id = @id) AS sent,
    (SELECT COUNT(DISTINCT prospect_id) FROM messages WHERE campaign_id = @id) AS contacted,
    (SELECT COUNT(DISTINCT prospect_id) FROM messages WHERE campaign_id = @id AND open_count > 0) AS opened,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'replied') AS replied,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND reply_category = 'interested') AS interested,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'bounced') AS bounced,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'unsubscribed') AS unsubscribed,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'stopped') AS stopped`;

export function campaignRoutes(db, { decideFn = decide, now = () => new Date() } = {}) {
  const router = Router();
  router.use(requireAuth(db));

  const own = (req, id = req.params.id) => db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  const stats = (id) => {
    const s = db.prepare(STAT_SQL).get({ id });
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
    return { ...s, open_rate: pct(s.opened, s.contacted), reply_rate: pct(s.replied, s.contacted), bounce_rate: pct(s.bounced, s.contacted) };
  };

  function fullCampaign(c) {
    const steps = loadSequence(db, c.id).map((s) => ({
      id: s.id,
      step_number: s.step_number,
      delay_days: s.delay_days,
      same_thread: Boolean(s.same_thread),
      variants: s.variants.map(({ id, label, angle, subject, body }) => ({ id, label, angle, subject, body })),
    }));
    return {
      ...c,
      send_days: c.send_days.split(',').map(Number),
      track_opens: Boolean(c.track_opens),
      include_unsubscribe: Boolean(c.include_unsubscribe),
      jev_enabled: Boolean(c.jev_enabled),
      stop_on_reply: Boolean(c.stop_on_reply),
      sender_ids: db.prepare('SELECT sender_id FROM campaign_senders WHERE campaign_id = ?').all(c.id).map((r) => r.sender_id),
      steps,
      ctas: db.prepare('SELECT id, label, description, text FROM ctas WHERE campaign_id = ? ORDER BY id').all(c.id),
      stats: stats(c.id),
    };
  }

  /** Saves settings, senders, steps/variants and CTAs, keeping ids stable so per-variant stats survive edits. */
  const saveCampaign = db.transaction((userId, campaignId, data) => {
    const settings = {
      name: data.name,
      offer: data.offer,
      icp: data.icp,
      timezone: data.timezone,
      send_days: [...new Set(data.send_days)].sort().join(','),
      window_start: data.window_start,
      window_end: data.window_end,
      track_opens: data.track_opens ? 1 : 0,
      include_unsubscribe: data.include_unsubscribe ? 1 : 0,
      jev_enabled: data.jev_enabled ? 1 : 0,
      stop_on_reply: data.stop_on_reply ? 1 : 0,
    };
    let id = campaignId;
    if (!id) {
      id = Number(db.prepare(`INSERT INTO campaigns (user_id, ${Object.keys(settings).join(', ')}) VALUES (@user_id, ${Object.keys(settings).map((k) => `@${k}`).join(', ')})`).run({ ...settings, user_id: userId }).lastInsertRowid);
    } else {
      db.prepare(`UPDATE campaigns SET ${Object.keys(settings).map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...settings, id });
    }

    db.prepare('DELETE FROM campaign_senders WHERE campaign_id = ?').run(id);
    const ownedSender = db.prepare('SELECT 1 FROM senders WHERE id = ? AND user_id = ?');
    for (const senderId of new Set(data.sender_ids)) {
      if (ownedSender.get(senderId, userId)) db.prepare('INSERT INTO campaign_senders (campaign_id, sender_id) VALUES (?, ?)').run(id, senderId);
    }

    const existingSteps = db.prepare('SELECT * FROM steps WHERE campaign_id = ?').all(id);
    data.steps.forEach((step, index) => {
      const number = index + 1;
      let stepRow = existingSteps.find((s) => s.step_number === number);
      if (stepRow) {
        db.prepare('UPDATE steps SET delay_days = ?, same_thread = ? WHERE id = ?').run(number === 1 ? 0 : step.delay_days, step.same_thread ? 1 : 0, stepRow.id);
      } else {
        stepRow = { id: Number(db.prepare('INSERT INTO steps (campaign_id, step_number, delay_days, same_thread) VALUES (?, ?, ?, ?)').run(id, number, number === 1 ? 0 : step.delay_days, step.same_thread ? 1 : 0).lastInsertRowid) };
      }
      const keep = [];
      for (const v of step.variants) {
        const current = v.id && db.prepare('SELECT id FROM variants WHERE id = ? AND step_id = ?').get(v.id, stepRow.id);
        if (current) {
          db.prepare('UPDATE variants SET label = ?, angle = ?, subject = ?, body = ? WHERE id = ?').run(v.label, v.angle, v.subject, v.body, current.id);
          keep.push(current.id);
        } else {
          keep.push(Number(db.prepare('INSERT INTO variants (step_id, label, angle, subject, body) VALUES (?, ?, ?, ?, ?)').run(stepRow.id, v.label, v.angle, v.subject, v.body).lastInsertRowid));
        }
      }
      db.prepare(`DELETE FROM variants WHERE step_id = ? AND id NOT IN (${keep.map(() => '?').join(',')})`).run(stepRow.id, ...keep);
    });
    db.prepare('DELETE FROM steps WHERE campaign_id = ? AND step_number > ?').run(id, data.steps.length);

    const keepCtas = [];
    for (const cta of data.ctas) {
      const current = cta.id && db.prepare('SELECT id FROM ctas WHERE id = ? AND campaign_id = ?').get(cta.id, id);
      if (current) {
        db.prepare('UPDATE ctas SET label = ?, description = ?, text = ? WHERE id = ?').run(cta.label, cta.description, cta.text, current.id);
        keepCtas.push(current.id);
      } else {
        keepCtas.push(Number(db.prepare('INSERT INTO ctas (campaign_id, label, description, text) VALUES (?, ?, ?, ?)').run(id, cta.label, cta.description, cta.text).lastInsertRowid));
      }
    }
    db.prepare(`DELETE FROM ctas WHERE campaign_id = ? ${keepCtas.length ? `AND id NOT IN (${keepCtas.map(() => '?').join(',')})` : ''}`).run(id, ...keepCtas);
    return id;
  });

  function activationProblems(c) {
    const full = fullCampaign(c);
    const problems = [];
    if (!full.sender_ids.length) problems.push('Asigna al menos un sender de Google Workspace.');
    const activeSenders = db.prepare(`SELECT COUNT(*) AS n FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id WHERE cs.campaign_id = ? AND s.status = 'active'`).get(c.id).n;
    if (full.sender_ids.length && !activeSenders) problems.push('Ningún sender asignado está activo.');
    if (!full.steps.length) problems.push('La secuencia no tiene pasos.');
    if (full.steps[0]?.variants.some((v) => !v.subject)) problems.push('Todas las variantes del paso 1 necesitan asunto.');
    full.steps.forEach((s) => {
      if (!s.same_thread && s.step_number > 1 && s.variants.some((v) => !v.subject)) {
        problems.push(`Paso ${s.step_number}: si no va en el mismo hilo, cada variante necesita asunto.`);
      }
      if (s.variants.some((v) => templateFields(v.body).includes('cta')) && !full.ctas.length) {
        problems.push(`Paso ${s.step_number} usa {{cta}} pero la campaña no tiene CTAs.`);
      }
    });
    return problems;
  }

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM campaigns WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ campaigns: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, created_at: c.created_at, stats: stats(c.id) })) });
  });

  router.post('/', (req, res) => {
    const data = campaignSchema.parse(req.body);
    const id = saveCampaign(req.user.id, null, data);
    res.status(201).json({ campaign: fullCampaign(own(req, id)) });
  });

  router.get('/:id', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ campaign: fullCampaign(c), max_steps: config.sequence.maxSteps });
  });

  router.put('/:id', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const data = campaignSchema.parse(req.body);
    saveCampaign(req.user.id, c.id, data);
    const updated = own(req);
    const response = { campaign: fullCampaign(updated) };
    if (updated.status === 'active') {
      const problems = activationProblems(updated);
      if (problems.length) {
        db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(c.id);
        response.campaign.status = 'paused';
        response.warning = `Campaña pausada: ${problems.join(' ')}`;
      }
    }
    res.json(response);
  });

  router.post('/:id/status', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const { status } = z.object({ status: z.enum(['active', 'paused']) }).parse(req.body);
    if (status === 'active') {
      const problems = activationProblems(c);
      if (problems.length) return res.status(400).json({ error: problems.join(' ') });
      // Prospects waiting for their first email become due immediately.
      db.prepare("UPDATE prospects SET next_send_at = ? WHERE campaign_id = ? AND status = 'active' AND next_send_at IS NULL AND current_step = 0").run(nowIso(now()), c.id);
    }
    db.prepare('UPDATE campaigns SET status = ? WHERE id = ?').run(status, c.id);
    res.json({ campaign: fullCampaign(own(req)) });
  });

  router.delete('/:id', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    db.prepare('DELETE FROM campaigns WHERE id = ?').run(c.id);
    res.status(204).end();
  });

  router.get('/:id/stats', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const byStep = db.prepare(
      `SELECT step_number, COUNT(*) AS sent, SUM(open_count > 0) AS opened FROM messages WHERE campaign_id = ? GROUP BY step_number ORDER BY step_number`,
    ).all(c.id);
    const byVariant = db.prepare(
      `SELECT v.id, v.label, s.step_number, COUNT(m.id) AS sent, COALESCE(SUM(m.open_count > 0), 0) AS opened,
              COUNT(DISTINCT CASE WHEN p.status = 'replied' AND p.current_step = s.step_number THEN p.id END) AS replied
       FROM variants v JOIN steps s ON s.id = v.step_id
       LEFT JOIN messages m ON m.variant_id = v.id LEFT JOIN prospects p ON p.id = m.prospect_id
       WHERE s.campaign_id = ? GROUP BY v.id ORDER BY s.step_number, v.id`,
    ).all(c.id);
    const byCta = db.prepare(
      `SELECT ct.id, ct.label, COUNT(m.id) AS sent, COUNT(DISTINCT CASE WHEN p.status = 'replied' THEN p.id END) AS replied
       FROM ctas ct LEFT JOIN messages m ON m.cta_id = ct.id LEFT JOIN prospects p ON p.id = m.prospect_id
       WHERE ct.campaign_id = ? GROUP BY ct.id ORDER BY ct.id`,
    ).all(c.id);
    const replies = db.prepare(
      'SELECT reply_category AS category, COUNT(*) AS n FROM prospects WHERE campaign_id = ? AND reply_category IS NOT NULL GROUP BY reply_category',
    ).all(c.id);
    const engines = db.prepare(
      `SELECT d.engine, COUNT(*) AS n FROM decisions d JOIN prospects p ON p.id = d.prospect_id WHERE p.campaign_id = ? GROUP BY d.engine`,
    ).all(c.id);
    res.json({ totals: stats(c.id), by_step: byStep, by_variant: byVariant, by_cta: byCta, replies, engines });
  });

  // ---------------------------------------------------------------------------
  // Prospects
  // ---------------------------------------------------------------------------
  router.post('/:id/prospects/import', upload.single('file'), (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (!req.file) return res.status(400).json({ error: 'Adjunta un archivo CSV en el campo "file"' });
    let parsed;
    try {
      parsed = parseProspectsCsv(req.file.buffer);
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }
    const suppressed = db.prepare('SELECT 1 FROM suppressions WHERE user_id = ? AND email = ?');
    const insert = db.prepare(
      `INSERT OR IGNORE INTO prospects (campaign_id, email, first_name, last_name, company, title, fields_json, next_send_at, unsubscribe_token)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const result = { imported: 0, duplicates: 0, suppressed: 0, invalid: parsed.invalid, mapping: parsed.mapping, headers: parsed.headers };
    const nextSend = c.status === 'active' ? nowIso(now()) : null;
    db.transaction(() => {
      for (const p of parsed.prospects) {
        if (suppressed.get(req.user.id, p.email)) {
          result.suppressed += 1;
          continue;
        }
        const r = insert.run(c.id, p.email, p.first_name, p.last_name, p.company, p.title, JSON.stringify(p.fields), nextSend, randomToken());
        if (r.changes) result.imported += 1;
        else result.duplicates += 1;
      }
    })();
    if (c.status === 'completed' && result.imported) db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(c.id);
    res.json(result);
  });

  router.get('/:id/prospects', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = 50;
    const where = ['campaign_id = @id'];
    if (req.query.status) where.push('status = @status');
    if (req.query.q) where.push("(email LIKE @q OR first_name LIKE @q OR last_name LIKE @q OR company LIKE @q)");
    const params = { id: c.id, status: req.query.status, q: `%${req.query.q || ''}%` };
    const total = db.prepare(`SELECT COUNT(*) AS n FROM prospects WHERE ${where.join(' AND ')}`).get(params).n;
    const rows = db.prepare(
      `SELECT id, email, first_name, last_name, company, title, status, current_step, next_send_at, fit_score, stop_reason, reply_category, last_error,
        (SELECT COALESCE(SUM(open_count), 0) FROM messages m WHERE m.prospect_id = prospects.id) AS opens
       FROM prospects WHERE ${where.join(' AND ')} ORDER BY id LIMIT ${size} OFFSET ${(page - 1) * size}`,
    ).all(params);
    const fields = db.prepare('SELECT fields_json FROM prospects WHERE campaign_id = ? LIMIT 1').get(c.id);
    res.json({
      prospects: rows,
      total,
      page,
      pages: Math.ceil(total / size),
      merge_fields: ['first_name', 'last_name', 'full_name', 'company', 'title', 'email', 'sender_name', 'sender_first_name', 'cta', ...Object.keys(JSON.parse(fields?.fields_json || '{}'))],
    });
  });

  /** Renders a step for a prospect (or sample data) and lints it. */
  router.post('/:id/preview', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const { prospect_id, step_number, variant_id, cta_id } = z.object({
      prospect_id: z.number().int().optional(),
      step_number: z.number().int().min(1),
      variant_id: z.number().int().optional(),
      cta_id: z.number().int().optional(),
    }).parse(req.body);
    const step = loadSequence(db, c.id).find((s) => s.step_number === step_number);
    if (!step) return res.status(404).json({ error: 'Paso no encontrado (guarda la campaña primero)' });
    const variant = step.variants.find((v) => v.id === variant_id) || step.variants[0];
    const prospect = (prospect_id && db.prepare('SELECT * FROM prospects WHERE id = ? AND campaign_id = ?').get(prospect_id, c.id))
      || db.prepare('SELECT * FROM prospects WHERE campaign_id = ? ORDER BY id LIMIT 1').get(c.id)
      || { id: 0, email: 'ana@ejemplo.com', first_name: 'Ana', last_name: 'Pérez', company: 'Ejemplo S.A.', title: 'Gerente de Ventas', fields_json: '{}' };
    const sender = db.prepare('SELECT s.* FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id WHERE cs.campaign_id = ? LIMIT 1').get(c.id);
    const ctas = db.prepare('SELECT * FROM ctas WHERE campaign_id = ? ORDER BY id').all(c.id);
    const cta = ctas.find((x) => x.id === cta_id) || ctas[0] || null;
    const firstVariant = loadSequence(db, c.id)[0]?.variants[0];
    const threadSubject = step_number > 1 ? prospect.first_subject || firstVariant?.subject?.replace(/\{\{[^}]+\}\}/g, '…') : null;
    const rendered = renderStep({ prospect, sender, variant, cta, step, threadSubject, fallbackSubject: threadSubject });
    res.json({
      prospect: { id: prospect.id, email: prospect.email, name: `${prospect.first_name} ${prospect.last_name}`.trim() },
      variant: { id: variant.id, label: variant.label },
      ...rendered,
      signature_html: sender?.signature_html || '',
      lint: lintEmail({ subject: variant.subject, body: variant.body, stepNumber: step_number }),
    });
  });

  /** Runs the decision engine for a prospect without sending, to inspect what Jev would do. */
  router.post('/:id/simulate-decision', async (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const { prospect_id } = z.object({ prospect_id: z.number().int() }).parse(req.body);
    const prospect = db.prepare('SELECT * FROM prospects WHERE id = ? AND campaign_id = ?').get(prospect_id, c.id);
    if (!prospect) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const sequence = loadSequence(db, c.id);
    const step = sequence.find((s) => s.step_number === prospect.current_step + 1);
    if (!step) return res.status(400).json({ error: 'El prospecto ya completó la secuencia' });
    const at = now();
    const decision = await decideFn({
      campaign: c,
      prospect,
      stepNumber: step.step_number,
      totalSteps: Math.min(sequence.length, config.sequence.maxSteps),
      engagement: engagementFor(db, prospect, c, at),
      variants: step.variants.map((v) => ({ ...v, preview: renderStep({ prospect, variant: v, cta: null, step }).body })),
      ctas: db.prepare('SELECT * FROM ctas WHERE campaign_id = ? ORDER BY id').all(c.id),
    });
    res.json({ step_number: step.step_number, decision });
  });

  return router;
}

export function prospectRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));
  const own = (req) => db.prepare(
    'SELECT p.* FROM prospects p JOIN campaigns c ON c.id = p.campaign_id WHERE p.id = ? AND c.user_id = ?',
  ).get(Number(req.params.id), req.user.id);

  router.get('/:id', (req, res) => {
    const p = own(req);
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
      .map((d) => ({ ...d, detail: JSON.parse(d.detail_json), detail_json: undefined }));
    const { seen_message_ids_json, pending_decision_json, unsubscribe_token, ...prospect } = p;
    prospect.fields = JSON.parse(p.fields_json || '{}');
    delete prospect.fields_json;
    res.json({ prospect, messages, opens, decisions });
  });

  router.patch('/:id', (req, res) => {
    const p = own(req);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const { status } = z.object({ status: z.enum(['active', 'stopped']) }).parse(req.body);
    if (status === 'active' && !['stopped', 'active'].includes(p.status)) {
      return res.status(400).json({ error: `No se puede reactivar un prospecto en estado "${p.status}"` });
    }
    db.prepare('UPDATE prospects SET status = ?, next_send_at = ?, stop_reason = ? WHERE id = ?').run(
      status,
      status === 'active' ? p.next_send_at || nowIso() : null,
      status === 'stopped' ? 'Detenido manualmente' : null,
      p.id,
    );
    res.json({ ok: true });
  });

  router.delete('/:id', (req, res) => {
    const p = own(req);
    if (!p) return res.status(404).json({ error: 'Prospecto no encontrado' });
    db.prepare('DELETE FROM prospects WHERE id = ?').run(p.id);
    res.status(204).end();
  });

  return router;
}
