import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { decodeBodies, insertSender, setup } from './helpers.js';

async function register(app, email = 'owner@acme.com') {
  const res = await request(app).post('/api/auth/register').send({ email, password: 'supersecreto', name: 'Owner' });
  assert.equal(res.status, 201);
  return { token: res.body.token, userId: res.body.user.id };
}

const campaignBody = (senderIds) => ({
  name: 'Q4 SaaS',
  offer: 'Automatizamos la prospección para equipos de ventas B2B',
  icp: 'Gerentes de ventas en empresas SaaS de 20-200 empleados',
  timezone: 'America/Panama',
  send_days: [1, 2, 3, 4, 5],
  window_start: '08:00',
  window_end: '17:00',
  approval_mode: 'none',
  sender_ids: senderIds,
  steps: [
    { delay_days: 0, same_thread: true, variants: [{ label: 'Dolor', angle: 'pain point', subject: 'idea para {{company}}', body: 'Hola {{first_name}},\n\nvi que {{company}} está en {{ciudad|tu ciudad}}. {{cta}}' }] },
    { delay_days: 3, same_thread: true, variants: [{ label: 'Bump', angle: 'short bump', body: '{{first_name}}, ¿pudiste verlo? {{cta}}' }] },
    { delay_days: 4, same_thread: true, variants: [{ label: 'Cierre', angle: 'breakup', body: 'Último correo, {{first_name}}. ¿Lo dejo aquí?' }] },
  ],
  ctas: [
    { label: 'Interés', description: 'low friction', text: '¿Te interesa que te envíe más info?' },
    { label: 'Llamada', description: 'direct', text: '¿Tienes 15 minutos el jueves?' },
  ],
});

test('auth: register, login, me and protected routes', async () => {
  const { app } = setup();
  const { token } = await register(app);
  assert.equal((await request(app).post('/api/auth/register').send({ email: 'OWNER@acme.com', password: 'otraclave123' })).status, 409);
  assert.equal((await request(app).post('/api/auth/login').send({ email: 'owner@acme.com', password: 'mala-clave' })).status, 401);
  const login = await request(app).post('/api/auth/login').send({ email: 'owner@acme.com', password: 'supersecreto' });
  assert.equal(login.status, 200);
  assert.ok(login.body.token);
  assert.equal((await request(app).get('/api/auth/me').set('Authorization', `Bearer ${token}`)).body.user.email, 'owner@acme.com');
  assert.equal((await request(app).get('/api/campaigns')).status, 401);
  assert.equal((await request(app).get('/api/campaigns').set('Authorization', 'Bearer nope')).status, 401);
  assert.equal((await request(app).post('/api/auth/register').send({ email: 'x@y.com', password: 'short' })).status, 400);
});

test('users cannot see each other\'s campaigns', async () => {
  const { app } = setup();
  const a = await register(app, 'a@acme.com');
  const b = await register(app, 'b@acme.com');
  const created = await request(app).post('/api/campaigns').set('Authorization', `Bearer ${a.token}`).send(campaignBody([]));
  assert.equal(created.status, 201);
  assert.equal((await request(app).get(`/api/campaigns/${created.body.campaign.id}`).set('Authorization', `Bearer ${b.token}`)).status, 404);
});

test('full sequence: import, send, open, threaded follow-up, reply stops it', async () => {
  const ctx = setup();
  const { app, db, gmail, clock, scheduler } = ctx;
  const { token, userId } = await register(app);
  const auth = { Authorization: `Bearer ${token}` };
  const senderId = insertSender(db, userId);

  // Sequences are capped at 4 sends.
  const tooMany = campaignBody([senderId]);
  tooMany.steps = Array.from({ length: 5 }, () => tooMany.steps[1]);
  assert.equal((await request(app).post('/api/campaigns').set(auth).send(tooMany)).status, 400);

  const created = await request(app).post('/api/campaigns').set(auth).send(campaignBody([senderId]));
  assert.equal(created.status, 201);
  const campaignId = created.body.campaign.id;
  assert.equal(created.body.campaign.steps.length, 3);

  const csv = 'first_name,last_name,email,company,ciudad\nAna,Pérez,ana@cliente.com,Cliente SA,Panamá\nLuis,Gómez,luis@otro.com,Otro SA,\nAna,Pérez,ana@cliente.com,Dup,\n';
  const imported = await request(app).post(`/api/campaigns/${campaignId}/prospects/import`).set(auth).field('source', 'CRM propio').field('lawful_basis', 'interes_legitimo').attach('file', Buffer.from(csv), 'p.csv');
  assert.equal(imported.status, 200);
  assert.equal(imported.body.imported, 2);
  assert.equal(imported.body.duplicates, 1);

  const preview = await request(app).post(`/api/campaigns/${campaignId}/preview`).set(auth).send({ step_number: 1 });
  assert.equal(preview.body.subject, 'idea para Cliente SA');
  assert.match(preview.body.body, /Hola Ana,\n\nvi que Cliente SA está en Panamá\. ¿Te interesa que te envíe más info\?/);

  const activated = await request(app).post(`/api/campaigns/${campaignId}/status`).set(auth).send({ status: 'active' });
  assert.equal(activated.status, 200, activated.body.error);

  // Tick 1 (Wed 10:00 Panama): one email per sender per tick (pacing).
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 1);
  const first = gmail.state.sent[0];
  assert.match(first.mime, /^From: "Laura Ventas" <ventas@acme.com>/);
  assert.match(first.mime, /Subject: idea para Cliente SA/);
  assert.match(first.mime, /List-Unsubscribe: <http:\/\/localhost:3000\/u\//);
  const [text, html] = decodeBodies(first.mime);
  assert.match(text, /Hola Ana/);
  assert.match(html, /gmail_signature/);
  const pixel = html.match(/\/t\/o\/([\w-]+)\.gif/)[1];

  // Too soon for the second prospect (min delay 60s).
  clock.now = new Date(clock.now.getTime() + 30000);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 1);
  // Luis has no "ciudad" but the template has a fallback.
  clock.now = new Date(clock.now.getTime() + 60000);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 2);
  assert.match(decodeBodies(gmail.state.sent[1].mime)[0], /Otro SA está en tu ciudad/);

  // A scanner hitting the pixel right after sending is ignored; a later human open counts.
  await request(app).get(`/t/o/${pixel}.gif`).set('User-Agent', 'Mozilla/5.0 (compatible; Barracuda scanner)');
  clock.now = new Date(clock.now.getTime() + 3600000);
  const open = await request(app).get(`/t/o/${pixel}.gif`).set('User-Agent', 'Mozilla/5.0 (via ggpht.com GoogleImageProxy)');
  assert.equal(open.headers['content-type'], 'image/gif');
  const ana = db.prepare("SELECT * FROM prospects WHERE email = 'ana@cliente.com'").get();
  const anaMsg = db.prepare('SELECT * FROM messages WHERE prospect_id = ?').get(ana.id);
  assert.equal(anaMsg.open_count, 1);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM open_events').get().n, 2);

  // Nothing due before the 3-day delay.
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 2);

  // Luis replies in his thread; Ana does not.
  const luis = db.prepare("SELECT * FROM prospects WHERE email = 'luis@otro.com'").get();
  gmail.state.threads.get(luis.thread_id).push({ id: 'r1', from: 'Luis <luis@otro.com>', labelIds: ['INBOX'], snippet: 'Sí, cuéntame más' });

  clock.now = new Date('2026-10-12T14:00:00Z'); // Monday 09:00 Panama, > 3 days later
  await scheduler.tick();
  const luisAfter = db.prepare('SELECT * FROM prospects WHERE id = ?').get(luis.id);
  assert.equal(luisAfter.status, 'replied');
  assert.equal(luisAfter.reply_category, 'question');

  // Ana opened around 11:00 local, so the follow-up is moved to the 11:00–14:00 slot.
  assert.equal(gmail.state.sent.length, 2);
  assert.equal(db.prepare('SELECT next_send_at FROM prospects WHERE id = ?').get(ana.id).next_send_at, '2026-10-12T16:00:00.000Z');
  clock.now = new Date('2026-10-12T16:01:00Z');
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 3);
  const followUp = gmail.state.sent[2];
  assert.equal(followUp.threadId, ana.thread_id);
  assert.match(followUp.mime, /Subject: Re: idea para Cliente SA/);
  assert.match(followUp.mime, /In-Reply-To: <msg1@mail.gmail.com>/);
  const [fuText] = decodeBodies(followUp.mime);
  assert.match(fuText, /Ana, ¿pudiste verlo\?/);
  assert.match(fuText, /> Hola Ana/); // previous email quoted like a real reply

  const decisions = db.prepare('SELECT * FROM decisions WHERE prospect_id = ?').all(ana.id);
  // analysis + step-1 draft + step-2 draft (the rescheduled draft is reused, not recomputed)
  assert.deepEqual(decisions.map((d) => d.action), ['analyze', 'draft', 'draft']);
  assert.equal(decisions[2].engine, 'rules');
  assert.match(JSON.parse(decisions[2].detail_json).detail.slot, /aperturas previas/);

  const stats = await request(app).get(`/api/campaigns/${campaignId}/stats`).set(auth);
  assert.equal(stats.body.totals.sent, 3);
  assert.equal(stats.body.totals.replied, 1);
  assert.equal(stats.body.totals.opened, 1);
  assert.equal(stats.body.totals.reply_rate, 50);

  const detail = await request(app).get(`/api/prospects/${ana.id}`).set(auth);
  assert.equal(detail.body.messages.length, 2);
  assert.equal(detail.body.prospect.unsubscribe_token, undefined);
});

test('auto-replies keep the sequence running; unsubscribe stops it and suppresses', async () => {
  const { app, db, gmail, clock, scheduler } = setup();
  const { token, userId } = await register(app);
  const auth = { Authorization: `Bearer ${token}` };
  const senderId = insertSender(db, userId);
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaignBody([senderId]));
  await request(app).post(`/api/campaigns/${body.campaign.id}/prospects/import`).set(auth)
    .field('source', 'CRM propio').field('lawful_basis', 'interes_legitimo').attach('file', Buffer.from('email,first_name,company\nana@cliente.com,Ana,Cliente SA\n'), 'p.csv');
  await request(app).post(`/api/campaigns/${body.campaign.id}/status`).set(auth).send({ status: 'active' });
  await scheduler.tick();
  const ana = db.prepare('SELECT * FROM prospects').get();
  gmail.state.threads.get(ana.thread_id).push({ id: 'ooo', from: 'Ana <ana@cliente.com>', labelIds: ['INBOX'], snippet: 'Respuesta automática: estoy fuera de la oficina' });

  clock.now = new Date('2026-10-12T14:00:00Z');
  await scheduler.tick();
  assert.equal(db.prepare('SELECT status FROM prospects').get().status, 'active');
  assert.equal(gmail.state.sent.length, 2);

  const page = await request(app).get(`/u/${ana.unsubscribe_token}`);
  assert.match(page.text, /ana@cliente.com/);
  await request(app).post(`/u/${ana.unsubscribe_token}`).type('form').send('List-Unsubscribe=One-Click');
  assert.equal(db.prepare('SELECT status FROM prospects').get().status, 'unsubscribed');

  // Re-importing a suppressed address is skipped.
  const again = await request(app).post(`/api/campaigns/${body.campaign.id}/prospects/import`).set(auth)
    .field('source', 'CRM propio').field('lawful_basis', 'interes_legitimo').attach('file', Buffer.from('email\nana@cliente.com\n'), 'p.csv');
  assert.equal(again.body.suppressed, 1);
});

test('Jev decisions pick variants/CTAs, stop non-fits and move sends to the preferred slot', async () => {
  const calls = [];
  const analyzeFn = async ({ prospect }) => ({
    engine: 'jev', segmentId: null, fitScore: 0.75, exclude: prospect.email.startsWith('competidor'), detail: {},
  });
  const decideFn = async (ctx) => {
    calls.push(ctx);
    return { engine: 'jev', action: 'send', variantId: ctx.variants[1].id, ctaId: ctx.ctas[1].id, slot: 'late', detail: {} };
  };
  const { app, db, gmail, clock, scheduler } = setup({ decideFn, analyzeFn });
  const { token, userId } = await register(app);
  const auth = { Authorization: `Bearer ${token}` };
  const senderId = insertSender(db, userId);
  const data = campaignBody([senderId]);
  data.steps[0].variants.push({ label: 'Prueba social', angle: 'case study', subject: 'cómo {{company}} podría', body: 'Hola {{first_name}}, ayudamos a una empresa como {{company}}. {{cta}}' });
  const { body } = await request(app).post('/api/campaigns').set(auth).send(data);
  await request(app).post(`/api/campaigns/${body.campaign.id}/prospects/import`).set(auth)
    .field('source', 'CRM propio').field('lawful_basis', 'interes_legitimo').attach('file', Buffer.from('email,first_name,company\ncompetidor@rival.com,Rival,Rival\nana@cliente.com,Ana,Cliente SA\n'), 'p.csv');
  await request(app).post(`/api/campaigns/${body.campaign.id}/status`).set(auth).send({ status: 'active' });

  await scheduler.tick(); // 10:00 local = "early" slot → both decided, Ana rescheduled to 14:00
  assert.equal(gmail.state.sent.length, 0);
  const rival = db.prepare("SELECT * FROM prospects WHERE email LIKE 'competidor%'").get();
  assert.equal(rival.status, 'stopped');
  const ana = db.prepare("SELECT * FROM prospects WHERE email = 'ana@cliente.com'").get();
  assert.equal(ana.next_send_at, '2026-10-07T19:00:00.000Z');
  assert.equal(ana.postponed_step, 1);
  assert.equal(ana.fit_score, 0.75);

  clock.now = new Date('2026-10-07T19:05:00Z');
  await scheduler.tick();
  assert.equal(calls.length, 1); // the drafted decision is reused, Jev is not asked again
  assert.equal(gmail.state.sent.length, 1);
  assert.match(gmail.state.sent[0].mime, /Subject: =\?UTF-8\?B\?/); // "cómo …" variant chosen
  assert.match(decodeBodies(gmail.state.sent[0].mime)[0], /ayudamos a una empresa como Cliente SA\. ¿Tienes 15 minutos el jueves\?/);
});
