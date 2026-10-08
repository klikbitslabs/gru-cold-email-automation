import jwt from 'jsonwebtoken';
import { config } from '../config.js';

export function signUserToken(user) {
  return jwt.sign({ sub: String(user.id), email: user.email }, config.jwtSecret, {
    expiresIn: config.jwtExpiresIn,
    algorithm: 'HS256',
  });
}

/** Short-lived token carried through the Google OAuth `state` parameter. */
export function signOAuthState(userId) {
  return jwt.sign({ sub: String(userId), purpose: 'google_oauth' }, config.jwtSecret, { expiresIn: '10m', algorithm: 'HS256' });
}

export function verifyOAuthState(state) {
  const payload = jwt.verify(state, config.jwtSecret, { algorithms: ['HS256'] });
  if (payload.purpose !== 'google_oauth') throw new Error('invalid state');
  return Number(payload.sub);
}

export function requireAuth(db) {
  const findUser = db.prepare('SELECT id, email, name FROM users WHERE id = ?');
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'No autenticado' });
    try {
      const payload = jwt.verify(token, config.jwtSecret, { algorithms: ['HS256'] });
      if (payload.purpose) throw new Error('wrong token type');
      const user = findUser.get(Number(payload.sub));
      if (!user) return res.status(401).json({ error: 'Usuario no encontrado' });
      req.user = user;
      return next();
    } catch {
      return res.status(401).json({ error: 'Token inválido o expirado' });
    }
  };
}
