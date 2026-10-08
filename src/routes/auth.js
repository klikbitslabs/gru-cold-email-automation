import { Router } from 'express';
import bcrypt from 'bcryptjs';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth, signUserToken } from '../middleware/auth.js';

const credentials = z.object({
  email: z.string().trim().toLowerCase().email(),
  password: z.string().min(8, 'La contraseña debe tener al menos 8 caracteres').max(200),
  name: z.string().trim().max(120).optional(),
});

export function authRoutes(db) {
  const router = Router();
  const limiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: config.isTest ? 1000 : 20, standardHeaders: 'draft-7', legacyHeaders: false });

  router.post('/register', limiter, async (req, res) => {
    if (!config.allowRegistration) return res.status(403).json({ error: 'El registro está deshabilitado' });
    const { email, password, name } = credentials.parse(req.body);
    if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) {
      return res.status(409).json({ error: 'Ya existe una cuenta con ese correo' });
    }
    const hash = await bcrypt.hash(password, 12);
    const { lastInsertRowid } = db.prepare('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)').run(email, name || '', hash);
    const user = { id: Number(lastInsertRowid), email, name: name || '' };
    res.status(201).json({ token: signUserToken(user), user });
  });

  router.post('/login', limiter, async (req, res) => {
    const { email, password } = credentials.pick({ email: true }).extend({ password: z.string().min(1) }).parse(req.body);
    const row = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
    // Compare against a dummy hash when the user does not exist to keep timing uniform.
    const ok = await bcrypt.compare(password, row?.password_hash || '$2a$12$C6UzMDM.H6dfI/f/IKcEeO1uZ5yQZr6pDZOxJr8VOMjK6Ad0WZ7Ga');
    if (!row || !ok) return res.status(401).json({ error: 'Correo o contraseña incorrectos' });
    const user = { id: row.id, email: row.email, name: row.name };
    res.json({ token: signUserToken(user), user });
  });

  router.get('/me', requireAuth(db), (req, res) => res.json({ user: req.user }));

  return router;
}
