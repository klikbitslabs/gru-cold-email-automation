// Integration settings (API keys) editable from the admin panel.
// Precedence: value saved in the panel → environment variable → default.
// Values are stored encrypted with ENCRYPTION_KEY and secrets are never sent back to the
// browser in full. JWT_SECRET and ENCRYPTION_KEY stay in the environment: they protect
// the sessions and these stored values, so they cannot live inside the database.

import { decrypt, encrypt } from '../lib/crypto.js';

export const SETTINGS = {
  google_client_id: { env: 'GOOGLE_CLIENT_ID', secret: false, label: 'Google OAuth Client ID' },
  google_client_secret: { env: 'GOOGLE_CLIENT_SECRET', secret: true, label: 'Google OAuth Client Secret' },
  allowed_google_domains: { env: 'ALLOWED_GOOGLE_DOMAINS', secret: false, label: 'Dominios de Workspace permitidos' },
  allow_consumer_gmail: { env: 'ALLOW_CONSUMER_GMAIL', secret: false, label: 'Permitir cuentas @gmail.com', bool: true, default: 'false' },
  typesafe_api_key: { env: 'TYPESAFE_API_KEY', secret: true, label: 'TypeSafe API key (Jev)' },
  typesafe_model: { env: 'TYPESAFE_MODEL', secret: false, label: 'Modelo de Jev', default: 'jev-latest' },
};

let db = null;
let cache = null;
const listeners = new Set();

/** Binds the settings store to the app database (called once by createApp). */
export function bindSettings(database) {
  db = database;
  cache = null;
}

/** Called whenever settings change (e.g. to rebuild the Jev client). */
export function onSettingsChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function stored() {
  if (cache) return cache;
  cache = {};
  if (!db) return cache;
  for (const row of db.prepare('SELECT key, value_enc FROM app_settings').all()) {
    try {
      cache[row.key] = decrypt(row.value_enc);
    } catch {
      // Encrypted with a different ENCRYPTION_KEY: ignore so the env fallback applies.
    }
  }
  return cache;
}

export function getSetting(key) {
  const def = SETTINGS[key];
  const saved = stored()[key];
  if (saved !== undefined && saved !== '') return saved;
  const fromEnv = process.env[def.env];
  if (fromEnv !== undefined && fromEnv !== '') return fromEnv;
  return def.default ?? '';
}

export function settingSource(key) {
  if (stored()[key]) return 'panel';
  if (process.env[SETTINGS[key].env]) return 'env';
  return null;
}

const truthy = (v) => ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());

/** Typed accessors used by the rest of the app. */
export const integrations = {
  google: () => ({
    clientId: getSetting('google_client_id'),
    clientSecret: getSetting('google_client_secret'),
    allowConsumerGmail: truthy(getSetting('allow_consumer_gmail')),
    allowedDomains: getSetting('allowed_google_domains').split(',').map((d) => d.trim().toLowerCase()).filter(Boolean),
  }),
  typesafe: () => ({
    apiKey: getSetting('typesafe_api_key'),
    model: getSetting('typesafe_model') || 'jev-latest',
    baseURL: process.env.TYPESAFE_BASE_URL || undefined,
  }),
};

export const googleConfigured = () => Boolean(getSetting('google_client_id') && getSetting('google_client_secret'));
export const jevConfigured = () => Boolean(getSetting('typesafe_api_key'));

const mask = (value) => (value.length <= 8 ? '••••' : `${value.slice(0, 4)}••••${value.slice(-4)}`);

/** Safe view for the admin panel: secrets are masked, never returned in full. */
export function publicSettings() {
  return Object.fromEntries(
    Object.entries(SETTINGS).map(([key, def]) => {
      const value = getSetting(key);
      const source = settingSource(key);
      return [key, {
        label: def.label,
        secret: def.secret,
        configured: Boolean(source),
        source,
        value: def.secret ? (value ? mask(value) : '') : value,
      }];
    }),
  );
}

/**
 * Saves panel values. `undefined` leaves a key untouched, `null`/'' removes the panel value
 * (falling back to the environment variable).
 */
export function updateSettings(patch, userId) {
  const upsert = db.prepare(
    `INSERT INTO app_settings (key, value_enc, updated_at, updated_by) VALUES (?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?)
     ON CONFLICT(key) DO UPDATE SET value_enc = excluded.value_enc, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
  );
  const remove = db.prepare('DELETE FROM app_settings WHERE key = ?');
  db.transaction(() => {
    for (const [key, value] of Object.entries(patch)) {
      if (!SETTINGS[key] || value === undefined) continue;
      if (value === null || String(value).trim() === '') remove.run(key);
      else upsert.run(key, encrypt(String(value).trim()), userId ?? null);
    }
  })();
  cache = null;
  for (const fn of listeners) fn();
}
