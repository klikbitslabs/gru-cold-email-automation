import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import helmet from 'helmet';
import { z } from 'zod';
import { config } from './config.js';
import { lintTemplate } from './lib/quality.js';
import { GOLDEN_RULES } from './lib/personas.js';
import { LAWFUL_BASES } from './lib/validate.js';
import { requireAuth } from './middleware/auth.js';
import { adminRoutes } from './routes/admin.js';
import { analyticsRoutes } from './routes/analytics.js';
import { authRoutes } from './routes/auth.js';
import { brandRoutes } from './routes/brands.js';
import { campaignRoutes } from './routes/campaigns.js';
import { companyRoutes } from './routes/companies.js';
import { senderRoutes } from './routes/senders.js';
import { trackingRoutes } from './routes/tracking.js';
import { workRoutes } from './routes/work.js';
import { bindSettings, googleConfigured, integrations, jevConfigured, openaiConfigured } from './services/settings.js';

const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');

/**
 * @param deps { db, scheduler?, gmailFor?, decideFn?, analyzeFn?, generateFn?, mx?, now?, testJev?, testGoogle?, testOpenAI? } — injectable for tests.
 */
export function createApp({ db, scheduler, gmailFor, decideFn, analyzeFn, generateFn, mx, now, testJev, testGoogle, testOpenAI } = {}) {
  bindSettings(db);
  const inject = (deps) => Object.fromEntries(Object.entries(deps).filter(([, v]) => v !== undefined));
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
  app.use('/api/admin', adminRoutes(db, inject({ testJev, testGoogle, testOpenAI })));
  app.use('/api/senders', senderRoutes(db, gmailFor ? { gmailFor } : {}));
  app.use('/api/brands', brandRoutes(db));
  app.use('/api/companies', companyRoutes(db));
  app.use('/api/campaigns', campaignRoutes(db, inject({ decideFn, analyzeFn, now, mx })));
  app.use('/api', workRoutes(db, inject({ now, analyzeFn, generateFn })));

  app.get('/api/meta', (req, res) => {
    res.json({
      google_configured: googleConfigured(),
      jev_configured: jevConfigured(),
      jev_model: integrations.typesafe().model,
      openai_configured: openaiConfigured(),
      openai_model: integrations.openai().model,
      max_steps: config.sequence.maxSteps,
      max_total_steps: 7,
      base_url: config.baseUrl,
      allow_registration: config.allowRegistration,
      lawful_bases: LAWFUL_BASES,
      golden_rules: GOLDEN_RULES,
    });
  });

  app.use('/api', analyticsRoutes(db, inject({ now, generateFn })));

  app.post('/api/lint', requireAuth(db), (req, res) => {
    const input = z.object({
      subject: z.string().default(''),
      body: z.string().default(''),
      step_number: z.number().int().min(1).default(1),
      thread_reply: z.boolean().default(false),
    }).parse(req.body);
    res.json(lintTemplate({ subject: input.subject, body: input.body, stepNumber: input.step_number, threadReply: input.thread_reply }));
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
    if (err.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Archivo demasiado grande (máx. 15 MB)' });
    const status = err.response?.status && err.response.status < 500 ? 502 : err.status || 500;
    if (status >= 500 && !config.isTest) console.error(err);
    return res.status(status).json({ error: status === 500 ? 'Error interno' : err.message });
  });

  return app;
}
