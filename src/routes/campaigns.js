import { Router } from 'express';
import multer from 'multer';
import { z } from 'zod';
import { config } from '../config.js';
import { nowIso } from '../db.js';
import { randomToken } from '../lib/crypto.js';
import { parseProspectsFile } from '../lib/csv.js';
import { checkDraft } from '../lib/quality.js';
import { templateFields } from '../lib/template.js';
import { isValidTimeZone } from '../lib/time.js';
import { createMxChecker, LAWFUL_BASES, validateLeads } from '../lib/validate.js';
import { requireAuth } from '../middleware/auth.js';
import { analyzeProspect, decide } from '../services/jev.js';
import { candidatesFor, engagementFor, loadSequence, performanceStats, renderDraft } from '../services/scheduler.js';

const HHMM = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Formato HH:MM');
const MAX_TOTAL_STEPS = 7;
const segmentRef = z.string().trim().max(80).default(''); // segment name ('' = every segment)

const variantSchema = z.object({
  id: z.number().int().optional(),
  label: z.string().trim().min(1).max(60),
  angle: z.string().trim().max(500).default(''),
  segment: segmentRef,
  subject: z.string().trim().max(200).default(''),
  body: z.string().trim().min(1, 'El cuerpo no puede estar vacío').max(5000),
});

const snippetSchema = z.object({
  id: z.number().int().optional(),
  label: z.string().trim().min(1).max(60),
  description: z.string().trim().max(300).default(''),
  segment: segmentRef,
  text: z.string().trim().min(1).max(800),
});

const campaignSchema = z
  .object({
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
    approval_mode: z.enum(['all', 'first', 'issues', 'none']).default('first'),
    sender_ids: z.array(z.number().int()).default([]),
    segments: z
      .array(z.object({ id: z.number().int().optional(), name: z.string().trim().min(1).max(80), description: z.string().trim().max(500).default('') }))
      .max(12)
      .default([]),
    steps: z
      .array(
        z.object({
          channel: z.enum(['email', 'call', 'linkedin']).default('email'),
          delay_days: z.number().int().min(0).max(60).default(3),
          same_thread: z.boolean().default(true),
          variants: z.array(variantSchema).min(1, 'Cada paso necesita al menos una variante').max(12),
        }),
      )
      .max(MAX_TOTAL_STEPS, `Máximo ${MAX_TOTAL_STEPS} pasos por secuencia`)
      .default([]),
    hooks: z.array(snippetSchema).max(20).default([]),
    problems: z.array(snippetSchema).max(20).default([]),
    ctas: z
      .array(z.object({ id: z.number().int().optional(), label: z.string().trim().min(1).max(60), description: z.string().trim().max(300).default(''), text: z.string().trim().min(1).max(500) }))
      .max(6)
      .default([]),
  })
  .refine((c) => c.window_start < c.window_end, { message: 'La ventana de envío debe terminar después de empezar', path: ['window_end'] })
  .refine((c) => c.steps.filter((s) => s.channel === 'email').length <= config.sequence.maxSteps, {
    message: `Máximo ${config.sequence.maxSteps} correos por secuencia`,
    path: ['steps'],
  })
  .refine((c) => !c.steps.length || c.steps[0].channel === 'email', { message: 'El primer paso debe ser un correo', path: ['steps'] })
  .refine((c) => new Set(c.segments.map((s) => s.name.toLowerCase())).size === c.segments.length, { message: 'Nombres de segmento repetidos', path: ['segments'] });

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });

const STAT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id) AS prospects,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'active') AS active,
    (SELECT COUNT(*) FROM messages WHERE campaign_id = @id) AS sent,
    (SELECT COUNT(DISTINCT prospect_id) FROM messages WHERE campaign_id = @id) AS contacted,
    (SELECT COUNT(DISTINCT prospect_id) FROM messages WHERE campaign_id = @id AND open_count > 0) AS opened,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'replied' AND reply_category IS NOT NULL) AS replied,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND (reply_category = 'interested' OR outcome IN ('interested','meeting','opportunity','won'))) AS interested,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND outcome IN ('meeting','opportunity','won')) AS meetings,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND outcome IN ('opportunity','won')) AS opportunities,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND outcome = 'won') AS won,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'bounced') AS bounced,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'unsubscribed') AS unsubscribed,
    (SELECT COUNT(*) FROM prospects WHERE campaign_id = @id AND status = 'stopped') AS stopped,
    (SELECT COUNT(*) FROM drafts WHERE campaign_id = @id AND status = 'pending') AS pending_approval,
    (SELECT COUNT(*) FROM tasks WHERE campaign_id = @id AND status = 'open') AS open_tasks`;

export function campaignRoutes(db, { decideFn = decide, analyzeFn = analyzeProspect, now = () => new Date(), mx } = {}) {
  const router = Router();
  router.use(requireAuth(db));

  const own = (req, id = req.params.id) => db.prepare('SELECT * FROM campaigns WHERE id = ? AND user_id = ?').get(Number(id), req.user.id);
  const stats = (id) => {
    const s = db.prepare(STAT_SQL).get({ id });
    const pct = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : 0);
    return { ...s, open_rate: pct(s.opened, s.contacted), reply_rate: pct(s.replied, s.contacted), bounce_rate: pct(s.bounced, s.contacted), meeting_rate: pct(s.meetings, s.contacted) };
  };

  function fullCampaign(c) {
    const segments = db.prepare('SELECT id, name, description FROM segments WHERE campaign_id = ? ORDER BY id').all(c.id);
    const segName = (id) => segments.find((s) => s.id === id)?.name || '';
    const snippets = db.prepare('SELECT * FROM snippets WHERE campaign_id = ? ORDER BY id').all(c.id);
    const snippetOut = (kind) => snippets.filter((s) => s.kind === kind).map((s) => ({ id: s.id, label: s.label, description: s.description, segment: segName(s.segment_id), text: s.text }));
    return {
      ...c,
      send_days: c.send_days.split(',').map(Number),
      track_opens: Boolean(c.track_opens),
      include_unsubscribe: Boolean(c.include_unsubscribe),
      jev_enabled: Boolean(c.jev_enabled),
      stop_on_reply: Boolean(c.stop_on_reply),
      sender_ids: db.prepare('SELECT sender_id FROM campaign_senders WHERE campaign_id = ?').all(c.id).map((r) => r.sender_id),
      segments,
      steps: loadSequence(db, c.id).map((s) => ({
        id: s.id,
        step_number: s.step_number,
        channel: s.channel,
        delay_days: s.delay_days,
        same_thread: Boolean(s.same_thread),
        variants: s.variants.map((v) => ({ id: v.id, label: v.label, angle: v.angle, segment: segName(v.segment_id), subject: v.subject, body: v.body })),
      })),
      hooks: snippetOut('hook'),
      problems: snippetOut('problem'),
      ctas: db.prepare('SELECT id, label, description, text FROM ctas WHERE campaign_id = ? ORDER BY id').all(c.id),
      stats: stats(c.id),
    };
  }

  /** Saves everything keeping ids stable, so per-variant results survive edits. */
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
      approval_mode: data.approval_mode,
    };
    const keys = Object.keys(settings);
    let id = campaignId;
    if (!id) {
      id = Number(db.prepare(`INSERT INTO campaigns (user_id, ${keys.join(', ')}) VALUES (@user_id, ${keys.map((k) => `@${k}`).join(', ')})`).run({ ...settings, user_id: userId }).lastInsertRowid);
    } else {
      db.prepare(`UPDATE campaigns SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...settings, id });
    }

    db.prepare('DELETE FROM campaign_senders WHERE campaign_id = ?').run(id);
    const ownedSender = db.prepare('SELECT 1 FROM senders WHERE id = ? AND user_id = ?');
    for (const senderId of new Set(data.sender_ids)) {
      if (ownedSender.get(senderId, userId)) db.prepare('INSERT INTO campaign_senders (campaign_id, sender_id) VALUES (?, ?)').run(id, senderId);
    }

    // Generic upsert-by-id that deletes rows no longer present.
    function sync(table, scope, rows, insert, update) {
      const keep = [];
      for (const row of rows) {
        const current = row.id && db.prepare(`SELECT id FROM ${table} WHERE id = ? AND ${scope.column} = ?`).get(row.id, scope.value);
        if (current) {
          update(current.id, row);
          keep.push(current.id);
        } else {
          keep.push(insert(row));
        }
      }
      const extra = scope.extra ? ` AND ${scope.extra}` : '';
      db.prepare(`DELETE FROM ${table} WHERE ${scope.column} = ?${extra}${keep.length ? ` AND id NOT IN (${keep.map(() => '?').join(',')})` : ''}`).run(scope.value, ...keep);
    }

    sync('segments', { column: 'campaign_id', value: id }, data.segments,
      (s) => Number(db.prepare('INSERT INTO segments (campaign_id, name, description) VALUES (?, ?, ?)').run(id, s.name, s.description).lastInsertRowid),
      (sid, s) => db.prepare('UPDATE segments SET name = ?, description = ? WHERE id = ?').run(s.name, s.description, sid));
    const segmentIds = new Map(db.prepare('SELECT id, name FROM segments WHERE campaign_id = ?').all(id).map((s) => [s.name.toLowerCase(), s.id]));
    const segId = (name) => (name ? segmentIds.get(name.toLowerCase()) ?? null : null);

    const existingSteps = db.prepare('SELECT * FROM steps WHERE campaign_id = ?').all(id);
    data.steps.forEach((step, index) => {
      const number = index + 1;
      const delay = number === 1 ? 0 : step.delay_days;
      let stepRow = existingSteps.find((s) => s.step_number === number);
      if (stepRow) {
        db.prepare('UPDATE steps SET delay_days = ?, same_thread = ?, channel = ? WHERE id = ?').run(delay, step.same_thread ? 1 : 0, step.channel, stepRow.id);
      } else {
        stepRow = { id: Number(db.prepare('INSERT INTO steps (campaign_id, step_number, delay_days, same_thread, channel) VALUES (?, ?, ?, ?, ?)').run(id, number, delay, step.same_thread ? 1 : 0, step.channel).lastInsertRowid) };
      }
      sync('variants', { column: 'step_id', value: stepRow.id }, step.variants,
        (v) => Number(db.prepare('INSERT INTO variants (step_id, label, angle, segment_id, subject, body) VALUES (?, ?, ?, ?, ?, ?)').run(stepRow.id, v.label, v.angle, segId(v.segment), v.subject, v.body).lastInsertRowid),
        (vid, v) => db.prepare('UPDATE variants SET label = ?, angle = ?, segment_id = ?, subject = ?, body = ? WHERE id = ?').run(v.label, v.angle, segId(v.segment), v.subject, v.body, vid));
    });
    db.prepare('DELETE FROM steps WHERE campaign_id = ? AND step_number > ?').run(id, data.steps.length);

    for (const kind of ['hook', 'problem']) {
      sync('snippets', { column: 'campaign_id', value: id, extra: `kind = '${kind}'` }, kind === 'hook' ? data.hooks : data.problems,
        (s) => Number(db.prepare('INSERT INTO snippets (campaign_id, kind, segment_id, label, description, text) VALUES (?, ?, ?, ?, ?, ?)').run(id, kind, segId(s.segment), s.label, s.description, s.text).lastInsertRowid),
        (sid, s) => db.prepare('UPDATE snippets SET segment_id = ?, label = ?, description = ?, text = ? WHERE id = ?').run(segId(s.segment), s.label, s.description, s.text, sid));
    }
    sync('ctas', { column: 'campaign_id', value: id }, data.ctas,
      (c) => Number(db.prepare('INSERT INTO ctas (campaign_id, label, description, text) VALUES (?, ?, ?, ?)').run(id, c.label, c.description, c.text).lastInsertRowid),
      (cid, c) => db.prepare('UPDATE ctas SET label = ?, description = ?, text = ? WHERE id = ?').run(c.label, c.description, c.text, cid));
    return id;
  });

  /** Blocking problems and non-blocking recommendations before/while running a campaign. */
  function readiness(c) {
    const full = fullCampaign(c);
    const problems = [];
    const recommendations = [];
    const senders = db.prepare('SELECT s.* FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id WHERE cs.campaign_id = ?').all(c.id);
    if (!senders.length) problems.push('Asigna al menos un sender de Google Workspace.');
    else if (!senders.some((s) => s.status === 'active')) problems.push('Ningún sender asignado está activo.');
    for (const s of senders) {
      if (!s.display_name?.trim() || !s.signature_html?.trim()) problems.push(`El sender ${s.email} necesita nombre real y firma.`);
    }
    if (!full.steps.length) problems.push('La secuencia no tiene pasos.');
    const first = full.steps[0];
    if (first?.variants.some((v) => !v.subject)) problems.push('Todas las variantes del primer correo necesitan asunto.');
    full.steps.forEach((s) => {
      if (s.channel !== 'email') return;
      if (!s.same_thread && s.step_number > 1 && s.variants.some((v) => !v.subject)) {
        problems.push(`Paso ${s.step_number}: si no va en el mismo hilo, cada variante necesita asunto.`);
      }
      const used = new Set(s.variants.flatMap((v) => templateFields(v.body)));
      if (used.has('cta') && !full.ctas.length) problems.push(`Paso ${s.step_number} usa {{cta}} pero no hay CTAs.`);
      if (used.has('gancho') && !full.hooks.length) problems.push(`Paso ${s.step_number} usa {{gancho}} pero no hay ganchos.`);
      if (used.has('problema') && !full.problems.length) problems.push(`Paso ${s.step_number} usa {{problema}} pero no hay hipótesis de problema.`);
    });
    if (first) {
      const groups = full.segments.length ? full.segments.map((sg) => sg.name) : [''];
      for (const g of groups) {
        const n = first.variants.filter((v) => v.segment === g || (!v.segment && !first.variants.some((x) => x.segment === g))).length;
        if (n < 2) recommendations.push(`Primer correo${g ? ` (segmento "${g}")` : ''}: crea 2–3 variantes de asunto para probar.`);
      }
    }
    if (!c.icp.trim()) recommendations.push('Describe el ICP para que Jev puntúe el encaje y priorice.');
    if (!full.hooks.length) recommendations.push('Agrega ganchos de personalización ({{gancho}}) basados en datos verificables del archivo.');
    return { problems, recommendations };
  }

  router.get('/', (req, res) => {
    const rows = db.prepare('SELECT * FROM campaigns WHERE user_id = ? ORDER BY id DESC').all(req.user.id);
    res.json({ campaigns: rows.map((c) => ({ id: c.id, name: c.name, status: c.status, created_at: c.created_at, stats: stats(c.id) })) });
  });

  router.post('/', (req, res) => {
    const id = saveCampaign(req.user.id, null, campaignSchema.parse(req.body));
    res.status(201).json({ campaign: fullCampaign(own(req, id)) });
  });

  router.get('/:id', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    res.json({ campaign: fullCampaign(c), readiness: readiness(c), max_steps: config.sequence.maxSteps, max_total_steps: MAX_TOTAL_STEPS });
  });

  router.put('/:id', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    saveCampaign(req.user.id, c.id, campaignSchema.parse(req.body));
    const updated = own(req);
    const ready = readiness(updated);
    const response = { campaign: fullCampaign(updated), readiness: ready };
    if (updated.status === 'active' && ready.problems.length) {
      db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(c.id);
      response.campaign.status = 'paused';
      response.warning = `Campaña pausada: ${ready.problems.join(' ')}`;
    }
    res.json(response);
  });

  router.post('/:id/status', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const { status } = z.object({ status: z.enum(['active', 'paused']) }).parse(req.body);
    if (status === 'active') {
      const { problems } = readiness(c);
      if (problems.length) return res.status(400).json({ error: problems.join(' ') });
      db.prepare("UPDATE prospects SET next_send_at = ? WHERE campaign_id = ? AND status = 'active' AND next_send_at IS NULL AND current_step = 0 AND NOT EXISTS (SELECT 1 FROM drafts d WHERE d.prospect_id = prospects.id AND d.status = 'pending')").run(nowIso(now()), c.id);
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
    const perf = performanceStats(db, c.id);
    const byStep = db.prepare('SELECT step_number, COUNT(*) AS sent, SUM(open_count > 0) AS opened FROM messages WHERE campaign_id = ? GROUP BY step_number ORDER BY step_number').all(c.id);
    const variants = db.prepare(
      `SELECT v.id, v.label, s.step_number, sg.name AS segment FROM variants v JOIN steps s ON s.id = v.step_id
       LEFT JOIN segments sg ON sg.id = v.segment_id WHERE s.campaign_id = ? AND s.channel = 'email' ORDER BY s.step_number, v.id`,
    ).all(c.id);
    const opened = new Map(db.prepare('SELECT variant_id AS id, SUM(open_count > 0) AS n FROM messages WHERE campaign_id = ? GROUP BY variant_id').all(c.id).map((r) => [r.id, r.n]));
    const bySegment = db.prepare(
      `SELECT COALESCE(sg.name, 'Sin segmento') AS segment, COUNT(*) AS prospects,
         SUM(p.current_step > 0) AS contacted, SUM(p.status = 'replied' AND p.reply_category IS NOT NULL) AS replied,
         SUM(COALESCE(p.outcome IN ('meeting','opportunity','won'), 0)) AS meetings, ROUND(AVG(p.fit_score), 2) AS avg_fit
       FROM prospects p LEFT JOIN segments sg ON sg.id = p.segment_id WHERE p.campaign_id = ? GROUP BY sg.id ORDER BY prospects DESC`,
    ).all(c.id);
    res.json({
      totals: stats(c.id),
      by_step: byStep,
      by_variant: variants.map((v) => ({ ...v, opened: opened.get(v.id) || 0, ...(perf.variants.get(v.id) || { sent: 0, replied: 0, positive: 0 }), id: v.id })),
      by_cta: db.prepare('SELECT id, label FROM ctas WHERE campaign_id = ? ORDER BY id').all(c.id).map((ct) => ({ ...ct, ...(perf.ctas.get(ct.id) || { sent: 0, replied: 0, positive: 0 }), id: ct.id })),
      by_segment: bySegment,
      replies: db.prepare('SELECT reply_category AS category, COUNT(*) AS n FROM prospects WHERE campaign_id = ? AND reply_category IS NOT NULL GROUP BY reply_category').all(c.id),
      validation: db.prepare('SELECT validation_status AS status, COUNT(*) AS n FROM prospects WHERE campaign_id = ? GROUP BY validation_status').all(c.id),
      engines: db.prepare('SELECT d.engine, COUNT(*) AS n FROM decisions d JOIN prospects p ON p.id = d.prospect_id WHERE p.campaign_id = ? GROUP BY d.engine').all(c.id),
    });
  });

  // ---------------------------------------------------------------------------
  // Import + validation
  // ---------------------------------------------------------------------------
  router.post('/:id/prospects/import', upload.single('file'), async (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    if (!req.file) return res.status(400).json({ error: 'Adjunta un archivo CSV o Excel (.xlsx) en el campo "file".' });
    const { source, lawful_basis: lawfulBasis } = z.object({
      source: z.string().trim().min(2, 'Indica el origen de los datos (fuente autorizada).').max(120),
      lawful_basis: z.enum(Object.keys(LAWFUL_BASES), { message: 'Indica la base legal para contactar a estos leads.' }),
    }).parse(req.body);

    let parsed;
    try {
      parsed = await parseProspectsFile(req.file.buffer, { filename: req.file.originalname, mimetype: req.file.mimetype });
    } catch (err) {
      return res.status(400).json({ error: err.message });
    }

    // Duplicates inside the file are dropped before validation.
    const seen = new Set();
    const unique = [];
    let duplicatesInFile = 0;
    for (const p of parsed.prospects) {
      if (seen.has(p.email)) duplicatesInFile += 1;
      else {
        seen.add(p.email);
        unique.push(p);
      }
    }
    // MX lookups are cached per domain; high concurrency keeps large files within a request.
    const validations = await validateLeads(unique, { mx: mx || createMxChecker({ timeoutMs: 3000 }), concurrency: 48 });

    const suppressed = db.prepare('SELECT 1 FROM suppressions WHERE user_id = ? AND email = ?');
    const elsewhere = db.prepare('SELECT 1 FROM prospects p JOIN campaigns c ON c.id = p.campaign_id WHERE c.user_id = ? AND p.email = ? AND p.campaign_id != ? LIMIT 1');
    const insert = db.prepare(
      `INSERT OR IGNORE INTO prospects (campaign_id, email, first_name, last_name, company, title, industry, country, phone, linkedin_url,
         source, lawful_basis, fields_json, validation_status, validation_notes, status, stop_reason, next_send_at, unsubscribe_token)
       VALUES (@campaign_id, @email, @first_name, @last_name, @company, @title, @industry, @country, @phone, @linkedin_url,
         @source, @lawful_basis, @fields_json, @validation_status, @validation_notes, @status, @stop_reason, @next_send_at, @unsubscribe_token)`,
    );
    const result = {
      imported: 0,
      duplicates: duplicatesInFile,
      suppressed: 0,
      valid: 0,
      risky: 0,
      invalid: parsed.invalid.length,
      invalid_rows: parsed.invalid,
      risky_rows: [],
      contacted_elsewhere: 0,
      mapping: parsed.mapping,
      headers: parsed.headers,
    };
    const nextSend = c.status === 'active' ? nowIso(now()) : null;
    db.transaction(() => {
      unique.forEach((p, i) => {
        if (suppressed.get(req.user.id, p.email)) {
          result.suppressed += 1;
          return;
        }
        const v = validations[i];
        const notes = [...v.notes];
        if (elsewhere.get(req.user.id, p.email, c.id)) {
          notes.push('ya está en otra campaña');
          result.contacted_elsewhere += 1;
        }
        const invalid = v.status === 'invalid';
        const r = insert.run({
          campaign_id: c.id,
          ...p,
          source: p.source || source,
          lawful_basis: LAWFUL_BASES[p.lawful_basis] ? p.lawful_basis : lawfulBasis,
          fields_json: JSON.stringify(p.fields),
          validation_status: v.status,
          validation_notes: notes.join('; '),
          status: invalid ? 'stopped' : 'active',
          stop_reason: invalid ? `Validación: ${notes.join('; ')}` : null,
          next_send_at: invalid ? null : nextSend,
          unsubscribe_token: randomToken(),
        });
        if (!r.changes) {
          result.duplicates += 1;
          return;
        }
        result.imported += 1;
        if (invalid) {
          result.invalid += 1;
          result.invalid_rows.push({ email: p.email, reason: notes.join('; ') });
        } else if (v.status === 'risky') {
          result.risky += 1;
          if (result.risky_rows.length < 50) result.risky_rows.push({ email: p.email, reason: notes.join('; ') });
        } else result.valid += 1;
      });
    })();
    if (c.status === 'completed' && result.imported) db.prepare("UPDATE campaigns SET status = 'paused' WHERE id = ?").run(c.id);
    res.json(result);
  });

  router.get('/:id/prospects', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const page = Math.max(1, Number(req.query.page) || 1);
    const size = 50;
    const where = ['p.campaign_id = @id'];
    if (req.query.status) where.push('p.status = @status');
    if (req.query.validation) where.push('p.validation_status = @validation');
    if (req.query.segment) where.push(req.query.segment === 'none' ? 'p.segment_id IS NULL' : 'p.segment_id = @segment');
    if (req.query.q) where.push('(p.email LIKE @q OR p.first_name LIKE @q OR p.last_name LIKE @q OR p.company LIKE @q OR p.title LIKE @q)');
    const params = { id: c.id, status: req.query.status, validation: req.query.validation, segment: Number(req.query.segment) || null, q: `%${req.query.q || ''}%` };
    const total = db.prepare(`SELECT COUNT(*) AS n FROM prospects p WHERE ${where.join(' AND ')}`).get(params).n;
    const rows = db.prepare(
      `SELECT p.id, p.email, p.first_name, p.last_name, p.company, p.title, p.industry, p.status, p.current_step, p.next_send_at, p.fit_score,
          p.stop_reason, p.reply_category, p.last_error, p.validation_status, p.validation_notes, p.outcome, p.intel_at, sg.name AS segment,
          (SELECT COALESCE(SUM(open_count), 0) FROM messages m WHERE m.prospect_id = p.id) AS opens,
          (SELECT COUNT(*) FROM drafts d WHERE d.prospect_id = p.id AND d.status = 'pending') AS pending_drafts
       FROM prospects p LEFT JOIN segments sg ON sg.id = p.segment_id
       WHERE ${where.join(' AND ')} ORDER BY p.id LIMIT ${size} OFFSET ${(page - 1) * size}`,
    ).all(params);
    const sample = db.prepare('SELECT fields_json FROM prospects WHERE campaign_id = ? LIMIT 1').get(c.id);
    res.json({
      prospects: rows,
      total,
      page,
      pages: Math.ceil(total / size),
      merge_fields: ['first_name', 'last_name', 'full_name', 'company', 'title', 'industry', 'country', 'sender_name', 'sender_first_name', 'gancho', 'problema', 'cta', ...Object.keys(JSON.parse(sample?.fields_json || '{}'))],
    });
  });

  // ---------------------------------------------------------------------------
  // Generation preview + simulation
  // ---------------------------------------------------------------------------
  function sampleProspect(c, prospectId) {
    return (prospectId && db.prepare('SELECT * FROM prospects WHERE id = ? AND campaign_id = ?').get(prospectId, c.id))
      || db.prepare("SELECT * FROM prospects WHERE campaign_id = ? AND status = 'active' ORDER BY id LIMIT 1").get(c.id)
      || { id: 0, email: 'ana@ejemplo.com', first_name: 'Ana', last_name: 'Pérez', company: 'Ejemplo S.A.', title: 'Gerente de Ventas', industry: '', fields_json: '{}', segment_id: null };
  }

  router.post('/:id/preview', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const { prospect_id: prospectId, step_number: stepNumber, variant_id: variantId } = z.object({
      prospect_id: z.number().int().optional(),
      step_number: z.number().int().min(1),
      variant_id: z.number().int().optional(),
    }).parse(req.body);
    const sequence = loadSequence(db, c.id);
    const step = sequence.find((s) => s.step_number === stepNumber);
    if (!step) return res.status(404).json({ error: 'Paso no encontrado (guarda la campaña primero)' });
    const variant = step.variants.find((v) => v.id === variantId) || step.variants[0];
    const prospect = sampleProspect(c, prospectId);
    const sender = db.prepare('SELECT s.* FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id WHERE cs.campaign_id = ? LIMIT 1').get(c.id);
    const candidates = candidatesFor(db, { campaign: c, prospect, step, sender });
    const firstSubject = prospect.first_subject || sequence[0]?.variants[0]?.subject?.replace(/\{\{[^}]+\}\}/g, '…');
    const rendered = renderDraft({
      prospect, sender, variant, step,
      hook: candidates.hooks[0] || null, problem: candidates.problems[0] || null, cta: candidates.ctas[0] || null,
      threadSubject: stepNumber > 1 ? firstSubject : null, fallbackSubject: firstSubject,
    });
    const quality = step.channel === 'email'
      ? checkDraft({ subject: rendered.subject, body: rendered.body, stepNumber, threadReply: rendered.sameThread, personalized: rendered.personalized, missing: rendered.missing, sender, prospect })
      : null;
    res.json({
      prospect: { id: prospect.id, email: prospect.email, name: `${prospect.first_name} ${prospect.last_name}`.trim() },
      variant: { id: variant.id, label: variant.label },
      channel: step.channel,
      ...rendered,
      signature_html: sender?.signature_html || '',
      quality,
      available_hooks: candidates.hooks.map((h) => h.label),
    });
  });

  /** Runs analysis + message decision for one prospect without sending, to inspect what Jev would do. */
  router.post('/:id/simulate-decision', async (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const { prospect_id: prospectId } = z.object({ prospect_id: z.number().int() }).parse(req.body);
    const prospect = db.prepare('SELECT * FROM prospects WHERE id = ? AND campaign_id = ?').get(prospectId, c.id);
    if (!prospect) return res.status(404).json({ error: 'Prospecto no encontrado' });
    const segments = db.prepare('SELECT * FROM segments WHERE campaign_id = ? ORDER BY id').all(c.id);
    const analysis = await analyzeFn({ campaign: c, prospect, segments });
    const sequence = loadSequence(db, c.id);
    const step = sequence.find((s) => s.step_number === prospect.current_step + 1);
    if (!step || step.channel !== 'email') return res.json({ analysis, step_number: step?.step_number ?? null, decision: null });
    const p = { ...prospect, segment_id: analysis.segmentId ?? prospect.segment_id };
    const sender = db.prepare('SELECT s.* FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id WHERE cs.campaign_id = ? LIMIT 1').get(c.id);
    const candidates = candidatesFor(db, { campaign: c, prospect: p, step, sender });
    const decision = await decideFn({
      campaign: c,
      prospect: p,
      segment: segments.find((s) => s.id === p.segment_id) || null,
      stepNumber: step.step_number,
      totalSteps: sequence.length,
      engagement: engagementFor(db, p, c, now()),
      variants: candidates.variants.map((v) => ({ ...v, preview: renderDraft({ prospect: p, sender, variant: v, step }).body })),
      ctas: candidates.ctas,
      hooks: candidates.hooks,
      problems: candidates.problems,
    });
    const label = (list, id) => list.find((x) => x.id === id)?.label || null;
    res.json({
      analysis: { ...analysis, segment: segments.find((s) => s.id === analysis.segmentId)?.name || null },
      step_number: step.step_number,
      decision: {
        ...decision,
        labels: {
          variant: label(candidates.variants, decision.variantId),
          hook: label(candidates.hooks, decision.hookId),
          problem: label(candidates.problems, decision.problemId),
          cta: label(candidates.ctas, decision.ctaId),
        },
      },
    });
  });

  router.get('/:id/drafts', (req, res) => {
    const c = own(req);
    if (!c) return res.status(404).json({ error: 'Campaña no encontrada' });
    const status = ['pending', 'approved', 'rejected', 'sent'].includes(req.query.status) ? req.query.status : 'pending';
    const drafts = db.prepare(
      `SELECT d.*, p.email, p.first_name, p.last_name, p.company, p.title, p.validation_status, sg.name AS segment, s.email AS sender_email
       FROM drafts d JOIN prospects p ON p.id = d.prospect_id LEFT JOIN segments sg ON sg.id = p.segment_id LEFT JOIN senders s ON s.id = d.sender_id
       WHERE d.campaign_id = ? AND d.status = ? ORDER BY d.step_number, d.id LIMIT 200`,
    ).all(c.id, status);
    res.json({ drafts: drafts.map((d) => ({ ...d, quality: JSON.parse(d.quality_json), decision: JSON.parse(d.decision_json), quality_json: undefined, decision_json: undefined })) });
  });

  return router;
}
