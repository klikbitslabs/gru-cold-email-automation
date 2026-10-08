import 'dotenv/config';
import crypto from 'node:crypto';

const env = process.env;
const isTest = env.NODE_ENV === 'test';

function required(name, testDefault) {
  const value = env[name];
  if (value) return value;
  if (isTest) return testDefault;
  throw new Error(`Missing required environment variable ${name}. See .env.example`);
}

function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export const config = {
  isTest,
  port: Number(env.PORT || 3000),
  // Public URL used in tracking pixels, unsubscribe links and the Google OAuth redirect.
  // Render and Railway expose the public URL; BASE_URL always wins when set.
  baseUrl: (
    env.BASE_URL ||
    env.RENDER_EXTERNAL_URL ||
    (env.RAILWAY_PUBLIC_DOMAIN ? `https://${env.RAILWAY_PUBLIC_DOMAIN}` : '') ||
    'http://localhost:3000'
  ).replace(/\/+$/, ''),
  databasePath: env.DATABASE_PATH || (isTest ? ':memory:' : 'data/outreach.db'),

  jwtSecret: required('JWT_SECRET', 'test-jwt-secret'),
  jwtExpiresIn: env.JWT_EXPIRES_IN || '7d',
  allowRegistration: bool(env.ALLOW_REGISTRATION, true),

  // 32-byte key (hex or base64) used to encrypt Google refresh tokens at rest.
  encryptionKey: required('ENCRYPTION_KEY', crypto.createHash('sha256').update('test').digest('hex')),

  google: {
    clientId: env.GOOGLE_CLIENT_ID || '',
    clientSecret: env.GOOGLE_CLIENT_SECRET || '',
    // Only Google Workspace accounts (with a hosted domain) are accepted unless this is true.
    allowConsumerGmail: bool(env.ALLOW_CONSUMER_GMAIL, false),
    // Optional comma separated list of Workspace domains allowed as senders.
    allowedDomains: (env.ALLOWED_GOOGLE_DOMAINS || '')
      .split(',')
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean),
  },

  typesafe: {
    apiKey: env.TYPESAFE_API_KEY || '',
    model: env.TYPESAFE_MODEL || 'jev-latest',
    baseURL: env.TYPESAFE_BASE_URL || undefined,
  },

  sequence: {
    // Initial email + follow-ups. Best practice (Clay, Instantly): ~4 touches max.
    maxSteps: Number(env.MAX_SEQUENCE_STEPS || 4),
  },

  scheduler: {
    enabled: bool(env.SCHEDULER_ENABLED, !isTest),
    intervalSeconds: Number(env.SCHEDULER_INTERVAL_SECONDS || 30),
    // How often an active thread is checked for replies/bounces.
    replyCheckMinutes: Number(env.REPLY_CHECK_MINUTES || 30),
  },

  tracking: {
    // Opens registered this soon after sending are flagged as likely bot/scanner prefetch.
    botWindowSeconds: Number(env.OPEN_BOT_WINDOW_SECONDS || 60),
  },
};

export const googleConfigured = () => Boolean(config.google.clientId && config.google.clientSecret);
export const jevConfigured = () => Boolean(config.typesafe.apiKey);
