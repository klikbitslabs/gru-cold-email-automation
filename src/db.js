import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  name TEXT,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS senders (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  display_name TEXT,
  google_domain TEXT,
  refresh_token_enc TEXT NOT NULL,
  signature_html TEXT NOT NULL DEFAULT '',
  daily_limit INTEGER NOT NULL DEFAULT 30,
  min_delay_seconds INTEGER NOT NULL DEFAULT 180,
  status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','paused','error')),
  last_error TEXT,
  last_sent_at TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (user_id, email)
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','completed')),
  offer TEXT NOT NULL DEFAULT '',
  icp TEXT NOT NULL DEFAULT '',
  timezone TEXT NOT NULL DEFAULT 'America/Panama',
  send_days TEXT NOT NULL DEFAULT '1,2,3,4,5',
  window_start TEXT NOT NULL DEFAULT '08:00',
  window_end TEXT NOT NULL DEFAULT '17:00',
  track_opens INTEGER NOT NULL DEFAULT 1,
  include_unsubscribe INTEGER NOT NULL DEFAULT 1,
  jev_enabled INTEGER NOT NULL DEFAULT 1,
  stop_on_reply INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

CREATE TABLE IF NOT EXISTS campaign_senders (
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sender_id INTEGER NOT NULL REFERENCES senders(id) ON DELETE CASCADE,
  PRIMARY KEY (campaign_id, sender_id)
);

CREATE TABLE IF NOT EXISTS steps (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  delay_days INTEGER NOT NULL DEFAULT 0,
  same_thread INTEGER NOT NULL DEFAULT 1,
  UNIQUE (campaign_id, step_number)
);

-- Each step can hold several message variants ("angles"); Jev picks the best one per prospect.
CREATE TABLE IF NOT EXISTS variants (
  id INTEGER PRIMARY KEY,
  step_id INTEGER NOT NULL REFERENCES steps(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  angle TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL
);

-- Call-to-action library rendered through {{cta}}; Jev picks one based on engagement.
CREATE TABLE IF NOT EXISTS ctas (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prospects (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  first_name TEXT NOT NULL DEFAULT '',
  last_name TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  fields_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','replied','bounced','unsubscribed','finished','stopped')),
  current_step INTEGER NOT NULL DEFAULT 0,
  next_send_at TEXT,
  postponed_step INTEGER,
  sender_id INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  thread_id TEXT,
  first_subject TEXT,
  last_message_id_header TEXT,
  fit_score REAL,
  last_reply_check_at TEXT,
  stop_reason TEXT,
  reply_category TEXT,
  replied_at TEXT,
  pending_decision_json TEXT,
  seen_message_ids_json TEXT NOT NULL DEFAULT '[]',
  last_error TEXT,
  unsubscribe_token TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (campaign_id, email)
);
CREATE INDEX IF NOT EXISTS idx_prospects_due ON prospects (status, next_send_at);

CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  sender_id INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  step_number INTEGER NOT NULL,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  cta_id INTEGER REFERENCES ctas(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body_text TEXT NOT NULL,
  gmail_message_id TEXT,
  gmail_thread_id TEXT,
  message_id_header TEXT,
  tracking_token TEXT NOT NULL UNIQUE,
  decision_json TEXT,
  sent_at TEXT NOT NULL,
  open_count INTEGER NOT NULL DEFAULT 0,
  first_opened_at TEXT,
  last_opened_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_sender_sent ON messages (sender_id, sent_at);

CREATE TABLE IF NOT EXISTS open_events (
  id INTEGER PRIMARY KEY,
  message_id INTEGER NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  opened_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT,
  suspected_bot INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS suppressions (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  email TEXT NOT NULL COLLATE NOCASE,
  reason TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY (user_id, email)
);

-- Every decision (Jev or fallback) is logged so it can be audited from the UI.
CREATE TABLE IF NOT EXISTS decisions (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  engine TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Integration settings editable from the admin panel (API keys). Values are AES-256-GCM
-- encrypted with ENCRYPTION_KEY; environment variables are the fallback.
CREATE TABLE IF NOT EXISTS app_settings (
  key TEXT PRIMARY KEY,
  value_enc TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL
);

-- Commercial segments (e.g. "Retail - Gerente comercial"). Jev assigns each prospect to one.
CREATE TABLE IF NOT EXISTS segments (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT ''
);

-- Reusable copy blocks chosen per prospect: personalization hooks ({{gancho}}) and
-- problem hypotheses ({{problema}}). segment_id NULL = available to every segment.
CREATE TABLE IF NOT EXISTS snippets (
  id INTEGER PRIMARY KEY,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK (kind IN ('hook','problem')),
  segment_id INTEGER REFERENCES segments(id) ON DELETE SET NULL,
  label TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  text TEXT NOT NULL
);

-- Every email is drafted first (generation + quality control), then approved, then sent.
CREATE TABLE IF NOT EXISTS drafts (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  sender_id INTEGER REFERENCES senders(id) ON DELETE SET NULL,
  variant_id INTEGER REFERENCES variants(id) ON DELETE SET NULL,
  cta_id INTEGER REFERENCES ctas(id) ON DELETE SET NULL,
  hook_id INTEGER REFERENCES snippets(id) ON DELETE SET NULL,
  problem_id INTEGER REFERENCES snippets(id) ON DELETE SET NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  same_thread INTEGER NOT NULL DEFAULT 0,
  quality_json TEXT NOT NULL DEFAULT '{}',
  decision_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','approved','rejected','sent')),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reviewed_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_drafts_prospect ON drafts (prospect_id, step_number, status);

-- Non-email steps (cold call, LinkedIn) become tasks for a person to complete.
CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY,
  prospect_id INTEGER NOT NULL REFERENCES prospects(id) ON DELETE CASCADE,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  step_number INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('call','linkedin')),
  instructions TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done','skipped')),
  outcome TEXT,
  note TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  completed_at TEXT
);
`;

// Columns added after the first release. ALTER TABLE keeps existing databases (e.g. on a
// Railway volume) working without manual migrations.
const ADDED_COLUMNS = {
  users: {
    is_admin: 'INTEGER NOT NULL DEFAULT 0',
  },
  campaigns: {
    approval_mode: "TEXT NOT NULL DEFAULT 'first'",
  },
  steps: {
    channel: "TEXT NOT NULL DEFAULT 'email'",
  },
  variants: {
    segment_id: 'INTEGER REFERENCES segments(id) ON DELETE SET NULL',
  },
  prospects: {
    industry: "TEXT NOT NULL DEFAULT ''",
    country: "TEXT NOT NULL DEFAULT ''",
    phone: "TEXT NOT NULL DEFAULT ''",
    linkedin_url: "TEXT NOT NULL DEFAULT ''",
    source: "TEXT NOT NULL DEFAULT ''",
    lawful_basis: "TEXT NOT NULL DEFAULT ''",
    validation_status: "TEXT NOT NULL DEFAULT 'valid'",
    validation_notes: "TEXT NOT NULL DEFAULT ''",
    segment_id: 'INTEGER REFERENCES segments(id) ON DELETE SET NULL',
    intel_json: 'TEXT',
    intel_at: 'TEXT',
    outcome: 'TEXT',
    outcome_at: 'TEXT',
  },
};

function migrate(db) {
  for (const [table, columns] of Object.entries(ADDED_COLUMNS)) {
    const existing = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
    for (const [name, definition] of Object.entries(columns)) {
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`);
    }
  }
  // The first account is the administrator (manages integrations / API keys).
  if (!db.prepare('SELECT 1 FROM users WHERE is_admin = 1').get()) {
    db.exec('UPDATE users SET is_admin = 1 WHERE id = (SELECT MIN(id) FROM users)');
  }
}

export function openDatabase(file = config.databasePath) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

export const nowIso = (date = new Date()) => date.toISOString();
