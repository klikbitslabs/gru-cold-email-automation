// Advanced analytics and the decision center (recommendations + automation permissions).
import { Router } from 'express';
import { z } from 'zod';
import { computeAnalytics } from '../lib/analytics.js';
import { isValidTimeZone } from '../lib/time.js';
import { requireAuth } from '../middleware/auth.js';
import {
  AUTOMATION_PRESETS, RECOMMENDATION_TYPES, applyRecommendation, getPermissions, runDecisions, setPermissions,
} from '../services/decisions.js';
import { generateVariants } from '../services/openai.js';

const DAY_MS = 86400000;
const toRec = (r) => ({
  ...r,
  evidence: JSON.parse(r.evidence_json || '{}'),
  action: r.action_json ? JSON.parse(r.action_json) : null,
  evidence_json: undefined,
  action_json: undefined,
});

export function analyticsRoutes(db, { now = () => new Date(), generateFn = generateVariants } = {}) {
  const router = Router();
  // Per-route auth: mounted on /api next to public endpoints.
  const auth = requireAuth(db);

  router.get('/analytics', auth, (req, res) => {
    const q = z.object({
      days: z.coerce.number().int().min(1).max(365).default(30),
      from: z.string().optional(),
      to: z.string().optional(),
      campaign_id: z.coerce.number().int().optional(),
      brand_id: z.coerce.number().int().optional(),
      tz: z.string().optional(),
    }).parse(req.query);
    const to = q.to ? new Date(q.to) : now();
    const from = q.from ? new Date(q.from) : new Date(to.getTime() - q.days * DAY_MS);
    if (Number.isNaN(from.getTime()) || Number.isNaN(to.getTime()) || from >= to) return res.status(400).json({ error: 'Rango de fechas inválido' });
    const tz = q.tz && isValidTimeZone(q.tz) ? q.tz : 'UTC';
    res.json(computeAnalytics(db, { userId: req.user.id, from, to, campaignId: q.campaign_id, brandId: q.brand_id, tz }));
  });

  router.get('/decisions', auth, (req, res) => {
    const open = db.prepare(
      `SELECT r.*, c.name AS campaign FROM recommendations r LEFT JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.user_id = ? AND r.status = 'open'
       ORDER BY CASE r.severity WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, r.action_json IS NULL, r.id`,
    ).all(req.user.id).map(toRec);
    const history = db.prepare(
      `SELECT r.*, c.name AS campaign FROM recommendations r LEFT JOIN campaigns c ON c.id = r.campaign_id
       WHERE r.user_id = ? AND r.status != 'open' ORDER BY r.decided_at DESC LIMIT 50`,
    ).all(req.user.id).map(toRec);
    res.json({
      open,
      history,
      permissions: getPermissions(db, req.user.id),
      types: RECOMMENDATION_TYPES,
      presets: AUTOMATION_PRESETS,
    });
  });

  router.get('/decisions/count', auth, (req, res) => {
    res.json({ open: db.prepare("SELECT COUNT(*) AS n FROM recommendations WHERE user_id = ? AND status = 'open'").get(req.user.id).n });
  });

  router.post('/decisions/refresh', auth, async (req, res) => {
    res.json(await runDecisions(db, { userId: req.user.id, generateFn, now, log: { warn() {} } }));
  });

  router.put('/decisions/permissions', auth, (req, res) => {
    const input = z.record(z.string(), z.boolean()).parse(req.body);
    res.json({ permissions: setPermissions(db, req.user.id, input, now()) });
  });

  router.post('/decisions/:id/:action', auth, async (req, res) => {
    const { action } = req.params;
    if (!['approve', 'dismiss'].includes(action)) return res.status(404).json({ error: 'Acción desconocida' });
    const rec = db.prepare('SELECT * FROM recommendations WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!rec) return res.status(404).json({ error: 'Recomendación no encontrada' });
    if (action === 'dismiss') {
      if (rec.status !== 'open') return res.status(400).json({ error: 'La recomendación ya no está abierta.' });
      db.prepare("UPDATE recommendations SET status = 'dismissed', decided_at = ? WHERE id = ?").run(now().toISOString(), rec.id);
      return res.json({ ok: true });
    }
    return res.json(await applyRecommendation(db, rec, { generateFn, now }));
  });

  return router;
}
