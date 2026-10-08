// Companies (accounts): contacts grouped by company across campaigns.
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.js';

export function companyRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));

  router.get('/', (req, res) => {
    const q = `%${req.query.q || ''}%`;
    const companies = db.prepare(
      `SELECT co.id, co.name, co.domain, co.industry,
         COUNT(p.id) AS contacts,
         COALESCE(SUM(p.current_step > 0), 0) AS contacted,
         COALESCE(SUM(p.status = 'replied' AND p.reply_category IS NOT NULL AND p.reply_category NOT IN ('bounce')), 0) AS replied,
         COALESCE(SUM(p.outcome IN ('meeting','opportunity','won')), 0) AS meetings,
         COALESCE(SUM(p.lead_status = 'ready' AND p.status = 'active'), 0) AS ready,
         COALESCE(SUM(p.lead_status = 'research' AND p.status = 'active'), 0) AS research,
         COALESCE(SUM(p.lead_status = 'excluded' OR p.status IN ('unsubscribed','bounced')), 0) AS excluded,
         ROUND(MAX(p.fit_score), 2) AS best_fit,
         MAX(m.sent_at) AS last_contact
       FROM companies co
       JOIN prospects p ON p.company_id = co.id
       LEFT JOIN messages m ON m.prospect_id = p.id
       WHERE co.user_id = ? AND (co.name LIKE ? OR co.domain LIKE ? OR co.industry LIKE ?)
       GROUP BY co.id ORDER BY replied DESC, contacted DESC, contacts DESC, co.name LIMIT 500`,
    ).all(req.user.id, q, q, q);
    res.json({ companies: companies.map((c) => ({ ...c, account_status: accountStatus(c) })) });
  });

  router.get('/:id', (req, res) => {
    const company = db.prepare('SELECT * FROM companies WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
    if (!company) return res.status(404).json({ error: 'Empresa no encontrada' });
    const contacts = db.prepare(
      `SELECT p.id, p.email, p.first_name, p.last_name, p.title, p.status, p.lead_status, p.lead_status_reasons, p.current_step,
         p.reply_category, p.outcome, p.fit_score, p.next_send_at, c.name AS campaign, c.id AS campaign_id,
         (SELECT MAX(sent_at) FROM messages m WHERE m.prospect_id = p.id) AS last_contact,
         (SELECT COALESCE(SUM(open_count), 0) FROM messages m WHERE m.prospect_id = p.id) AS opens
       FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
       WHERE p.company_id = ? ORDER BY p.current_step DESC, p.id`,
    ).all(company.id);
    res.json({ company, contacts });
  });

  return router;
}

/** Account-level status: the first positive signal at the company wins. */
export function accountStatus(c) {
  if (c.meetings) return 'meeting';
  if (c.replied) return 'replied';
  if (c.contacted) return 'in_progress';
  if (c.ready) return 'ready';
  if (c.research) return 'research';
  return 'excluded';
}
