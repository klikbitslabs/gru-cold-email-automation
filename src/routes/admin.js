// Admin panel: integrations (API keys) for Google Workspace and Jev.
import { Router } from 'express';
import { z } from 'zod';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { GOOGLE_SCOPES, redirectUri } from '../services/google.js';
import { testJevConnection } from '../services/jev.js';
import { testOpenAIConnection } from '../services/openai.js';
import { integrations, publicSettings, updateSettings } from '../services/settings.js';

const optionalText = (max) => z.union([z.string().trim().max(max), z.null()]).optional();

const patchSchema = z.object({
  google_client_id: z
    .union([z.string().trim().regex(/^[\w-]+\.apps\.googleusercontent\.com$/, 'El Client ID de Google termina en .apps.googleusercontent.com'), z.literal(''), z.null()])
    .optional(),
  google_client_secret: optionalText(200),
  allowed_google_domains: z
    .union([z.string().trim().regex(/^$|^[a-z0-9.-]+\.[a-z]{2,}(\s*,\s*[a-z0-9.-]+\.[a-z]{2,})*$/i, 'Dominios separados por coma, p. ej. empresa.com, otra.com'), z.null()])
    .optional(),
  allow_consumer_gmail: z.union([z.enum(['true', 'false']), z.null()]).optional(),
  typesafe_api_key: optionalText(300),
  typesafe_model: z.union([z.string().trim().regex(/^$|^[\w.:/-]{2,80}$/, 'Nombre de modelo inválido'), z.null()]).optional(),
  openai_api_key: optionalText(300),
  openai_model: z.union([z.string().trim().regex(/^$|^[\w.:/-]{2,80}$/, 'Nombre de modelo inválido'), z.null()]).optional(),
});

/**
 * Checks Google OAuth credentials without a user: exchanging a fake code returns
 * invalid_client (bad id/secret), redirect_uri_mismatch (URI not registered) or
 * invalid_grant (credentials and redirect URI are fine; only the code is fake).
 */
export async function testGoogleCredentials({ fetchFn = fetch } = {}) {
  const { clientId, clientSecret } = integrations.google();
  if (!clientId || !clientSecret) return { ok: false, error: 'Faltan el Client ID o el Client Secret.' };
  try {
    const res = await fetchFn('https://oauth2.googleapis.com/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: 'prueba-de-conexion', client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri(), grant_type: 'authorization_code' }),
    });
    const data = await res.json().catch(() => ({}));
    if (data.error === 'invalid_grant') return { ok: true, message: 'Credenciales válidas y URL de retorno registrada.' };
    if (data.error === 'redirect_uri_mismatch') return { ok: false, error: `Credenciales válidas, pero falta registrar la URL de retorno en Google Cloud: ${redirectUri()}` };
    if (data.error === 'invalid_client' || data.error === 'unauthorized_client') return { ok: false, error: 'Google rechazó el Client ID o el Client Secret.' };
    return { ok: false, error: `Respuesta inesperada de Google: ${data.error || res.status} ${data.error_description || ''}`.trim() };
  } catch (err) {
    return { ok: false, error: `No se pudo contactar a Google: ${err.message}` };
  }
}

export function adminRoutes(db, { testJev = testJevConnection, testGoogle = testGoogleCredentials, testOpenAI = testOpenAIConnection } = {}) {
  const router = Router();
  router.use(requireAuth(db));
  router.use((req, res, next) => {
    if (!req.user.is_admin) return res.status(403).json({ error: 'Solo el administrador puede gestionar las integraciones.' });
    return next();
  });

  const view = () => ({
    settings: publicSettings(),
    google: { redirect_uri: redirectUri(), javascript_origin: config.baseUrl, scopes: GOOGLE_SCOPES },
    environment: {
      base_url: config.baseUrl,
      https: config.baseUrl.startsWith('https://'),
      jwt_secret: Boolean(process.env.JWT_SECRET),
      encryption_key: Boolean(process.env.ENCRYPTION_KEY),
      database_path: config.databasePath,
      persistent_volume: config.databasePath.startsWith('/data/'),
      scheduler: config.scheduler.enabled,
    },
  });

  router.get('/integrations', (req, res) => res.json(view()));

  router.put('/integrations', (req, res) => {
    updateSettings(patchSchema.parse(req.body), req.user.id);
    res.json(view());
  });

  router.post('/integrations/test-jev', async (req, res) => res.json(await testJev()));
  router.post('/integrations/test-google', async (req, res) => res.json(await testGoogle()));
  router.post('/integrations/test-openai', async (req, res) => res.json(await testOpenAI()));

  return router;
}
