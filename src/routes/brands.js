// Brands: commercial context per brand (several brands per account).
import { Router } from 'express';
import { z } from 'zod';
import { requireAuth } from '../middleware/auth.js';

const text = (max) => z.string().trim().max(max).default('');
export const brandSchema = z.object({
  name: z.string().trim().min(1, 'La marca necesita nombre').max(120),
  website: text(300),
  value_proposition: text(2000),
  tone: text(500),
  industries: text(1500),
  functions: text(1500),
  problems: text(2000),
  ref_subject: text(200),
  ref_email: text(3000),
  ref_call: text(2000),
  avoid: text(1000),
});

export function brandRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));
  const own = (req) => db.prepare('SELECT * FROM brands WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  const keys = Object.keys(brandSchema.shape);

  router.get('/', (req, res) => {
    const brands = db.prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM campaigns c WHERE c.brand_id = b.id) AS campaigns
       FROM brands b WHERE b.user_id = ? ORDER BY b.name`,
    ).all(req.user.id);
    res.json({ brands });
  });

  router.post('/', (req, res) => {
    const data = brandSchema.parse(req.body);
    const id = Number(db.prepare(`INSERT INTO brands (user_id, ${keys.join(', ')}) VALUES (@user_id, ${keys.map((k) => `@${k}`).join(', ')})`)
      .run({ ...data, user_id: req.user.id }).lastInsertRowid);
    res.status(201).json({ brand: db.prepare('SELECT * FROM brands WHERE id = ?').get(id) });
  });

  router.put('/:id', (req, res) => {
    const brand = own(req);
    if (!brand) return res.status(404).json({ error: 'Marca no encontrada' });
    const data = brandSchema.parse(req.body);
    db.prepare(`UPDATE brands SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...data, id: brand.id });
    res.json({ brand: db.prepare('SELECT * FROM brands WHERE id = ?').get(brand.id) });
  });

  router.delete('/:id', (req, res) => {
    const brand = own(req);
    if (!brand) return res.status(404).json({ error: 'Marca no encontrada' });
    db.prepare('DELETE FROM brands WHERE id = ?').run(brand.id);
    res.status(204).end();
  });

  return router;
}
