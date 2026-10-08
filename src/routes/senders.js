import { Router } from 'express';
import { z } from 'zod';
import { googleConfigured } from '../config.js';
import { decrypt, encrypt } from '../lib/crypto.js';
import { buildMime, formatAddress, toBase64Url } from '../lib/mime.js';
import { buildEmailBody, sanitizeSignature } from '../lib/template.js';
import { requireAuth, signOAuthState, verifyOAuthState } from '../middleware/auth.js';
import { exchangeCode, getAuthUrl, gmailForRefreshToken, validateWorkspaceAccount } from '../services/google.js';

const PUBLIC_FIELDS = 'id, email, display_name, google_domain, signature_html, daily_limit, min_delay_seconds, status, last_error, last_sent_at, created_at';

const senderPatch = z.object({
  display_name: z.string().trim().max(120).optional(),
  signature_html: z.string().max(20000).optional(),
  daily_limit: z.number().int().min(1).max(500).optional(),
  min_delay_seconds: z.number().int().min(30).max(3600).optional(),
  status: z.enum(['active', 'paused']).optional(),
});

export function senderRoutes(db, { gmailFor = (s) => gmailForRefreshToken(decrypt(s.refresh_token_enc)) } = {}) {
  const router = Router();
  const auth = requireAuth(db);
  const own = (req) => db.prepare('SELECT * FROM senders WHERE id = ? AND user_id = ?').get(Number(req.params.id), req.user.id);

  // OAuth callback is hit by Google's redirect, so it authenticates through the signed `state`.
  router.get('/google/callback', async (req, res) => {
    const back = (params) => res.redirect(`/#/senders?${new URLSearchParams(params)}`);
    try {
      if (req.query.error) return back({ error: String(req.query.error) });
      const userId = verifyOAuthState(String(req.query.state || ''));
      const identity = await exchangeCode(String(req.query.code || ''));
      const problem = validateWorkspaceAccount(identity);
      if (problem) return back({ error: problem });

      let signature = '';
      try {
        signature = await gmailForRefreshToken(identity.refreshToken).getSignature(identity.email);
      } catch {
        signature = '';
      }
      const existing = db.prepare('SELECT id, signature_html FROM senders WHERE user_id = ? AND email = ?').get(userId, identity.email);
      if (existing) {
        db.prepare("UPDATE senders SET refresh_token_enc = ?, status = 'active', last_error = NULL, google_domain = ?, signature_html = CASE WHEN signature_html = '' THEN ? ELSE signature_html END WHERE id = ?")
          .run(encrypt(identity.refreshToken), identity.hostedDomain, sanitizeSignature(signature), existing.id);
      } else {
        db.prepare('INSERT INTO senders (user_id, email, display_name, google_domain, refresh_token_enc, signature_html) VALUES (?, ?, ?, ?, ?, ?)')
          .run(userId, identity.email, identity.name, identity.hostedDomain, encrypt(identity.refreshToken), sanitizeSignature(signature));
      }
      return back({ connected: identity.email });
    } catch (err) {
      return back({ error: `No se pudo conectar la cuenta: ${err.message}` });
    }
  });

  router.use(auth);

  router.get('/', (req, res) => {
    const senders = db.prepare(`SELECT ${PUBLIC_FIELDS} FROM senders WHERE user_id = ? ORDER BY id`).all(req.user.id);
    const since = new Date(Date.now() - 86400000).toISOString();
    const count = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND sent_at > ?');
    res.json({ senders: senders.map((s) => ({ ...s, sent_last_24h: count.get(s.id, since).n })) });
  });

  router.get('/google/connect', (req, res) => {
    if (!googleConfigured()) {
      return res.status(400).json({ error: 'Configura GOOGLE_CLIENT_ID y GOOGLE_CLIENT_SECRET en el servidor (ver README).' });
    }
    res.json({ url: getAuthUrl(signOAuthState(req.user.id), req.query.email ? String(req.query.email) : undefined) });
  });

  router.patch('/:id', (req, res) => {
    const sender = own(req);
    if (!sender) return res.status(404).json({ error: 'Sender no encontrado' });
    const patch = senderPatch.parse(req.body);
    if (patch.signature_html !== undefined) patch.signature_html = sanitizeSignature(patch.signature_html);
    if (patch.status === 'active') patch.last_error = null;
    const keys = Object.keys(patch);
    if (keys.length) {
      db.prepare(`UPDATE senders SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...patch, id: sender.id });
    }
    res.json({ sender: db.prepare(`SELECT ${PUBLIC_FIELDS} FROM senders WHERE id = ?`).get(sender.id) });
  });

  router.post('/:id/import-signature', async (req, res) => {
    const sender = own(req);
    if (!sender) return res.status(404).json({ error: 'Sender no encontrado' });
    const signature = sanitizeSignature(await gmailFor(sender).getSignature(sender.email));
    db.prepare('UPDATE senders SET signature_html = ? WHERE id = ?').run(signature, sender.id);
    res.json({ signature_html: signature });
  });

  router.post('/:id/test', async (req, res) => {
    const sender = own(req);
    if (!sender) return res.status(404).json({ error: 'Sender no encontrado' });
    const to = z.object({ to: z.string().email() }).parse(req.body).to;
    const { text, html } = buildEmailBody({
      body: 'Este es un correo de prueba de tu herramienta de outreach. Si lo ves con tu firma, el sender está listo.',
      signatureHtml: sender.signature_html,
    });
    const mime = buildMime({ from: formatAddress(sender.display_name, sender.email), to, subject: 'prueba de envío', text, html });
    const sent = await gmailFor(sender).send({ raw: toBase64Url(mime) });
    res.json({ ok: true, id: sent.id });
  });

  router.delete('/:id', (req, res) => {
    const sender = own(req);
    if (!sender) return res.status(404).json({ error: 'Sender no encontrado' });
    db.prepare('DELETE FROM senders WHERE id = ?').run(sender.id);
    res.status(204).end();
  });

  return router;
}

