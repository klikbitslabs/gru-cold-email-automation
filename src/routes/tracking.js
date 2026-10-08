import { Router, urlencoded } from 'express';
import { config } from '../config.js';
import { nowIso } from '../db.js';
import { escapeHtml } from '../lib/template.js';

// 1x1 transparent GIF.
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

// Security scanners and link-preview bots that fetch images without a human opening the email.
// GoogleImageProxy is NOT here: Gmail fetches through it when the recipient actually opens.
const BOT_UA = /bot|crawler|spider|preview|scanner|barracuda|mimecast|proofpoint|symantec|forcepoint|trendmicro|microsoft office protection|python-requests|curl|wget|headless/i;

export function trackingRoutes(db, { now = () => new Date() } = {}) {
  const router = Router();

  router.get('/t/o/:token', (req, res) => {
    const token = req.params.token.replace(/\.gif$/, '');
    const message = db.prepare('SELECT id, sent_at FROM messages WHERE tracking_token = ?').get(token);
    if (message) {
      const at = now();
      const ua = String(req.headers['user-agent'] || '').slice(0, 300);
      const tooSoon = at - new Date(message.sent_at) < config.tracking.botWindowSeconds * 1000;
      const bot = tooSoon || BOT_UA.test(ua) ? 1 : 0;
      db.prepare('INSERT INTO open_events (message_id, opened_at, ip, user_agent, suspected_bot) VALUES (?, ?, ?, ?, ?)')
        .run(message.id, nowIso(at), req.ip, ua, bot);
      if (!bot) {
        db.prepare('UPDATE messages SET open_count = open_count + 1, first_opened_at = COALESCE(first_opened_at, ?), last_opened_at = ? WHERE id = ?')
          .run(nowIso(at), nowIso(at), message.id);
      }
    }
    res.set({
      'Content-Type': 'image/gif',
      'Content-Length': PIXEL.length,
      'Cache-Control': 'no-store, no-cache, must-revalidate, private, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
    });
    res.end(PIXEL);
  });

  const page = (title, body) => `<!doctype html><html lang="es"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:system-ui,sans-serif;max-width:480px;margin:15vh auto;padding:0 16px;color:#222;background:#fff}button{padding:10px 18px;border-radius:8px;border:1px solid #222;background:#222;color:#fff;font-size:15px;cursor:pointer}</style></head><body>${body}</body></html>`;

  const findProspect = (token) => db.prepare(
    'SELECT p.id, p.email, c.user_id FROM prospects p JOIN campaigns c ON c.id = p.campaign_id WHERE p.unsubscribe_token = ?',
  ).get(token);

  function unsubscribe(prospect) {
    db.transaction(() => {
      db.prepare("INSERT OR IGNORE INTO suppressions (user_id, email, reason) VALUES (?, ?, 'unsubscribed')").run(prospect.user_id, prospect.email);
      // Stop every sequence of this user that targets the same address.
      db.prepare(
        `UPDATE prospects SET status = 'unsubscribed', next_send_at = NULL, stop_reason = 'Se dio de baja'
         WHERE email = ? AND status IN ('active','finished','stopped') AND campaign_id IN (SELECT id FROM campaigns WHERE user_id = ?)`,
      ).run(prospect.email, prospect.user_id);
    })();
  }

  router.get('/u/:token', (req, res) => {
    const prospect = findProspect(req.params.token);
    if (!prospect) return res.status(404).send(page('Enlace inválido', '<p>Este enlace no es válido.</p>'));
    res.send(page('Darse de baja', `<h2>¿Dejar de recibir correos?</h2><p>No volveremos a escribir a <b>${escapeHtml(prospect.email)}</b>.</p>
<form method="post"><button type="submit">Confirmar baja</button></form>`));
  });

  // Also handles RFC 8058 one-click unsubscribe (List-Unsubscribe-Post) from mail clients.
  router.post('/u/:token', urlencoded({ extended: false }), (req, res) => {
    const prospect = findProspect(req.params.token);
    if (!prospect) return res.status(404).send(page('Enlace inválido', '<p>Este enlace no es válido.</p>'));
    unsubscribe(prospect);
    res.send(page('Listo', '<h2>Listo</h2><p>No recibirás más correos de nuestra parte.</p>'));
  });

  return router;
}
