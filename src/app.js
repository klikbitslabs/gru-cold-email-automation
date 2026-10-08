import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { config, googleConfigured, jevConfigured } from './config.js';
import { lintEmail } from './lib/lint.js';
import { requireAuth } from './middleware/auth.js';
import { authRoutes } from './routes/auth.js';
import { campaignRoutes, prospectRoutes } from './routes/campaigns.js';
import { senderRoutes } from './routes/senders.js';
import { trackingRoutes } from './routes/tracking.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * @param deps { db, scheduler?, gmailFor?, decideFn?, now? } — injectable for tests.
 */
export function createApp({ db, scheduler, gmailFor, decideFn, now } = {}) {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          imgSrc: ["'self'", 'data:', 'https:'],
          styleSrc: ["'self'", "'unsafe-inline'"],
          scriptSrc: ["'self'"],
          formAction: ["'self'"],
        },
      },
      crossOriginResourcePolicy: { policy: 'cross-origin' },
    }),
  );

  app.get('/healthz', (req, res) => {
    db.prepare('SELECT 1').get();
    res.json({ ok: true });
  });

  // Public endpoints: tracking pixel and unsubscribe.
  app.use(trackingRoutes(db, { now }));

  app.use('/api', express.json({ limit: '1mb' }));
  app.use('/api/auth', authRoutes(db));
  app.use('/api/senders', senderRoutes(db, gmailFor ? { gmailFor } : {}));
  app.use('/api/campaigns', campaignRoutes(db, { ...(decideFn ? { decideFn } : {}), ...(now ? { now } : {}) }));
  app.use('/api/prospects', prospectRoutes(db));

  app.get('/api/meta', (req, res) => {
    res.json({
      google_configured: googleConfigured(),
      jev_configured: jevConfigured(),
      jev_model: config.typesafe.model,
      max_steps: config.sequence.maxSteps,
      base_url: config.baseUrl,
      allow_registration: config.allowRegistration,
    });
  });

  app.post('/api/lint', requireAuth(db), (req, res) => {
    const input = z.object({ subject: z.string().default(''), body: z.string().default(''), step_number: z.number().int().min(1).default(1) }).parse(req.body);
    res.json(lintEmail({ subject: input.subject, body: input.body, stepNumber: input.step_number }));
  });

  // Run the scheduler immediately (useful to test a campaign without waiting for the next tick).
  app.post('/api/scheduler/run', requireAuth(db), async (req, res) => {
    if (!scheduler) return res.status(503).json({ error: 'Scheduler no disponible' });
    res.json(await scheduler.tick());
  });

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));
  app.use(express.static(publicDir, { index: 'index.html' }));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err instanceof z.ZodError) {
      return res.status(400).json({ error: err.issues.map((i) => `${i.path.join('.') || 'datos'}: ${i.message}`).join('; ') });
    }
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'JSON inválido' });
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo demasiado grande (máx. 10 MB)' });
    const status = err.response?.status && err.response.status < 500 ? 502 : err.status || 500;
    if (status >= 500 && !config.isTest) console.error(err);
    return res.status(status).json({ error: status === 500 ? 'Error interno' : err.message });
  });

  return app;
}
