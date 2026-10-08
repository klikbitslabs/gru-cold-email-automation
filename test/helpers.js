process.env.NODE_ENV = 'test';

const { openDatabase } = await import('../src/db.js');
const { createApp } = await import('../src/app.js');
const { encrypt } = await import('../src/lib/crypto.js');
const { createScheduler } = await import('../src/services/scheduler.js');

/** In-memory Gmail double recording sent MIME messages and serving threads. */
export function fakeGmail() {
  const state = { sent: [], threads: new Map(), search: [], counter: 0 };
  const api = {
    async send({ raw, threadId }) {
      state.counter += 1;
      const id = `msg${state.counter}`;
      const tid = threadId || `thread${state.counter}`;
      const mime = Buffer.from(raw, 'base64url').toString('utf8');
      state.sent.push({ id, threadId: tid, mime });
      if (!state.threads.has(tid)) state.threads.set(tid, []);
      state.threads.get(tid).push({ id, from: 'Ventas <ventas@acme.com>', labelIds: ['SENT'], snippet: '' });
      return { id, threadId: tid };
    },
    async getMessageIdHeader(id) {
      return `<${id}@mail.gmail.com>`;
    },
    async getThread(threadId) {
      return state.threads.get(threadId) || [];
    },
    async searchMessages() {
      return state.search;
    },
    async getSignature() {
      return '<b>Firma Gmail</b>';
    },
  };
  return { state, api };
}

export function decodeBodies(mime) {
  const parts = [...mime.matchAll(/Content-Transfer-Encoding: base64\r\n\r\n([\s\S]*?)\r\n--/g)];
  return parts.map((p) => Buffer.from(p[1].replace(/\r\n/g, ''), 'base64').toString('utf8'));
}

/** MX checker double: every domain receives mail except the ones listed. */
export const fakeMx = (deadDomains = []) => async (domain) => (deadDomains.includes(domain) ? 'none' : 'ok');

export function setup({ decideFn, analyzeFn, classifyFn, generateFn, deadDomains = [], start = '2026-10-07T15:00:00Z' } = {}) {
  const db = openDatabase(':memory:');
  const gmail = fakeGmail();
  const clock = { now: new Date(start) };
  const now = () => new Date(clock.now);
  const scheduler = createScheduler({
    db,
    gmailFor: () => gmail.api,
    now,
    log: { warn() {}, error() {} },
    random: () => 0,
    ...(decideFn ? { decideFn } : {}),
    ...(analyzeFn ? { analyzeFn } : {}),
    ...(classifyFn ? { classifyFn } : {}),
    ...(generateFn ? { generateFn } : {}),
  });
  const app = createApp({ db, scheduler, gmailFor: () => gmail.api, now, decideFn, analyzeFn, generateFn, mx: fakeMx(deadDomains) });
  return { db, app, gmail, clock, scheduler };
}

export function insertSender(db, userId, overrides = {}) {
  const row = {
    user_id: userId,
    email: 'ventas@acme.com',
    display_name: 'Laura Ventas',
    google_domain: 'acme.com',
    refresh_token_enc: encrypt('fake-refresh'),
    signature_html: '<p>Laura · <a href="https://acme.com">acme.com</a></p>',
    daily_limit: 30,
    min_delay_seconds: 60,
    ...overrides,
  };
  const cols = Object.keys(row);
  return Number(db.prepare(`INSERT INTO senders (${cols.join(',')}) VALUES (${cols.map((c) => `@${c}`).join(',')})`).run(row).lastInsertRowid);
}
