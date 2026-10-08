// Brands: commercial context per brand (several brands per account).
import { Router } from 'express';
import { z } from 'zod';
import { SUGGESTED_PERSONAS } from '../lib/personas.js';
import { requireAuth } from '../middleware/auth.js';

const text = (max) => z.string().trim().max(max).default('');
export const personaSchema = z.object({
  id: z.number().int().optional(),
  name: z.string().trim().min(1, 'Cada perfil necesita nombre').max(80),
  match_titles: text(1000),
  motivation: text(1000),
  problem: text(1000),
  argument: text(1000),
  proof: text(1000),
  cta: text(400),
  avoid: text(500),
});
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
  meeting_link: text(300),
  personas: z.array(personaSchema).max(12).default([]),
});

export function brandRoutes(db) {
  const router = Router();
  router.use(requireAuth(db));
  const own = (req) => db.prepare('SELECT * FROM brands WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);
  const keys = Object.keys(brandSchema.shape).filter((k) => k !== 'personas');
  const PERSONA_FIELDS = ['name', 'match_titles', 'motivation', 'problem', 'argument', 'proof', 'cta', 'avoid'];
  const personasOf = (brandId) => db.prepare('SELECT * FROM personas WHERE brand_id = ? ORDER BY position, id').all(brandId);
  const withPersonas = (brand) => ({ ...brand, personas: personasOf(brand.id) });

  /** Replaces the brand's personas: updates the ones with id, inserts new ones, deletes the rest. */
  function savePersonas(brandId, list) {
    const existing = new Set(personasOf(brandId).map((p) => p.id));
    const keep = new Set();
    list.forEach((p, position) => {
      const row = { ...Object.fromEntries(PERSONA_FIELDS.map((f) => [f, p[f]])), position, brand_id: brandId };
      if (p.id && existing.has(p.id)) {
        db.prepare(`UPDATE personas SET ${PERSONA_FIELDS.map((f) => `${f} = @${f}`).join(', ')}, position = @position WHERE id = @id`).run({ ...row, id: p.id });
        keep.add(p.id);
      } else {
        db.prepare(`INSERT INTO personas (brand_id, ${PERSONA_FIELDS.join(', ')}, position) VALUES (@brand_id, ${PERSONA_FIELDS.map((f) => `@${f}`).join(', ')}, @position)`).run(row);
      }
    });
    for (const id of existing) if (!keep.has(id)) db.prepare('DELETE FROM personas WHERE id = ?').run(id);
  }

  router.get('/personas/suggested', (req, res) => res.json({ personas: SUGGESTED_PERSONAS }));

  router.get('/', (req, res) => {
    const brands = db.prepare(
      `SELECT b.*, (SELECT COUNT(*) FROM campaigns c WHERE c.brand_id = b.id) AS campaigns
       FROM brands b WHERE b.user_id = ? ORDER BY b.name`,
    ).all(req.user.id).map(withPersonas);
    res.json({ brands });
  });

  router.post('/', (req, res) => {
    const { personas, ...data } = brandSchema.parse(req.body);
    const id = db.transaction(() => {
      const newId = Number(db.prepare(`INSERT INTO brands (user_id, ${keys.join(', ')}) VALUES (@user_id, ${keys.map((k) => `@${k}`).join(', ')})`)
        .run({ ...data, user_id: req.user.id }).lastInsertRowid);
      savePersonas(newId, personas);
      return newId;
    })();
    res.status(201).json({ brand: withPersonas(db.prepare('SELECT * FROM brands WHERE id = ?').get(id)) });
  });

  router.put('/:id', (req, res) => {
    const brand = own(req);
    if (!brand) return res.status(404).json({ error: 'Marca no encontrada' });
    const { personas, ...data } = brandSchema.parse(req.body);
    db.transaction(() => {
      db.prepare(`UPDATE brands SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...data, id: brand.id });
      // Personas are only replaced when the client sends them (older clients omit the field).
      if (req.body.personas !== undefined) savePersonas(brand.id, personas);
    })();
    res.json({ brand: withPersonas(db.prepare('SELECT * FROM brands WHERE id = ?').get(brand.id)) });
  });

  router.delete('/:id', (req, res) => {
    const brand = own(req);
    if (!brand) return res.status(404).json({ error: 'Marca no encontrada' });
    db.prepare('DELETE FROM brands WHERE id = ?').run(brand.id);
    res.status(204).end();
  });

  return router;
}
