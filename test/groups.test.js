// Simple flow: load a base → groups (industry × persona) → approve each group's messages once →
// sending per company under the rules → replies with a suggested answer in Tareas → jobs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { decodeBodies, insertSender, setup } from './helpers.js';

async function login(app) {
  const res = await request(app).post('/api/auth/register').send({ email: 'owner@acme.com', password: 'supersecreto' });
  return { auth: { Authorization: `Bearer ${res.body.token}` }, userId: res.body.user.id };
}

const PERSONAS = [
  { name: 'Demand Planner', match_titles: 'demand planner, planificador de demanda', motivation: 'Precisión del pronóstico', problem: 'El pronóstico se arma a mano en hojas de cálculo.', cta: '¿Te sirve ver una muestra?' },
  { name: 'Director Financiero', match_titles: 'director financiero, cfo', motivation: 'Capital de trabajo', problem: 'Hay capital inmovilizado en inventario que no rota.', cta: '¿Vale la pena revisarlo en 15 minutos?' },
];

const BODY = (topic) => `Hola {{first_name}},\n\nVi que en {{company}} trabajas como {{title}} y quería escribirte directamente.\n\n${topic}\n\nEn otras empresas parecidas esto se resolvió con un plan de demanda simple y compartido.\n\n{{cta}}`;

async function prepare({ generateFn, draftFn, classifyFn } = {}) {
  const ctx = setup({ generateFn, draftFn, classifyFn });
  const { app, db } = ctx;
  const { auth, userId } = await login(app);
  const brand = (await request(app).post('/api/brands').set(auth).send({
    name: 'QuantraIQ', industries: 'Retail, Farmacias', functions: 'Planificación, Finanzas', problems: 'Faltantes', personas: PERSONAS,
  })).body.brand;
  const senderId = insertSender(db, userId);
  const { body } = await request(app).post('/api/campaigns').set(auth).send({
    name: 'QuantraIQ · Q4',
    brand_id: brand.id,
    timezone: 'America/Panama',
    approval_mode: 'group',
    delay_minutes: 0,
    company_gap_days: 0,
    track_opens: false,
    sender_ids: [senderId],
    steps: [
      { channel: 'email', variants: [{ label: 'Base', subject: 'una pregunta sobre {{company}}', body: BODY('{{problema}}') }] },
      { channel: 'email', delay_days: 3, same_thread: true, variants: [{ label: 'Seguimiento', subject: '', body: 'Hola {{first_name}}, ¿pudiste ver mi correo anterior?\n\n{{cta}}' }] },
    ],
  });
  const id = body.campaign.id;
  await request(app).post(`/api/campaigns/${id}/prospects/import`).set(auth)
    .field('source', 'CRM propio').field('lawful_basis', 'interes_legitimo')
    .attach('file', Buffer.from('email,nombre,apellido,empresa,cargo,sector\n'
      + 'ana@tiendas.com,Ana,Ríos,Tiendas SA,Demand Planner,Retail\n'
      + 'eva@tiendas.com,Eva,Paz,Tiendas SA,CFO,Retail\n'
      + 'leo@farma.com,Leo,Gil,Farma SA,Planificador de Demanda,Farmacias\n'), 'base.csv');
  const act = await request(app).post(`/api/campaigns/${id}/status`).set(auth).send({ status: 'active' });
  assert.equal(act.status, 200, act.body.error);
  return { ...ctx, auth, userId, campaignId: id, brand };
}

test('groups: leads are clustered by industry × persona and nothing is sent until a group is approved', async () => {
  const calls = [];
  const generateFn = async (ctx) => {
    calls.push(ctx);
    return { model: 'fake', variants: [{ label: 'g', subject: ctx.stepNumber === 1 ? 'capital en {{company}} este trimestre' : '', body: BODY(ctx.stepNumber === 1 ? 'Hay capital de trabajo detenido en inventario que no se mueve.' : 'Te escribo de nuevo por si se perdió.'), rationale: 'simple' }] };
  };
  const { app, db, scheduler, clock, gmail, auth, campaignId } = await prepare({ generateFn });
  await scheduler.tick();

  let { body } = await request(app).get(`/api/campaigns/${campaignId}/groups`).set(auth);
  assert.equal(body.group_by, 'industry_persona');
  assert.deepEqual(body.groups.map((g) => g.label).sort(), ['Farmacias · Demand Planner', 'Retail · Demand Planner', 'Retail · Director Financiero']);
  assert.ok(body.groups.every((g) => g.status === 'new' && g.ready === 1));
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM drafts').get().n, 0);

  const inbox = await request(app).get('/api/inbox').set(auth);
  assert.equal(inbox.body.counts.groups, 3);

  // Generate the CFO group's messages (one per email step, written for its industry and persona).
  const cfo = body.groups.find((g) => g.label.includes('Financiero'));
  const gen = await request(app).post(`/api/groups/${cfo.id}/generate`).set(auth);
  assert.equal(gen.body.engine, 'ai');
  assert.equal(gen.body.variants.length, 2);
  assert.equal(calls[0].persona.name, 'Director Financiero');
  assert.equal(calls[0].industry, 'Retail');
  assert.equal(calls[0].focus, 'simple');
  ({ body } = await request(app).get(`/api/campaigns/${campaignId}/groups`).set(auth));
  const g = body.groups.find((x) => x.id === cfo.id);
  assert.equal(g.status, 'pending');
  assert.equal(g.messages[0].variants[0].status, 'proposed');

  // Edit, then approve once for the whole group.
  const first = g.messages[0].variants[0];
  await request(app).put(`/api/groups/${cfo.id}`).set(auth).send({ messages: [{ id: first.id, subject: 'capital de trabajo en {{company}}', body: first.body }] }).expect(200);
  await request(app).post(`/api/groups/${cfo.id}/approve`).set(auth).expect(200);
  await scheduler.tick();
  clock.now = new Date(clock.now.getTime() + 5 * 60000);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 1);
  assert.match(gmail.state.sent[0].mime, /eva@tiendas\.com/);
  assert.match(gmail.state.sent[0].mime, /Subject: capital de trabajo en Tiendas SA/);
  assert.ok(decodeBodies(gmail.state.sent[0].mime)[0].includes('capital de trabajo detenido'));
  // Opens are not tracked (2026 default): no pixel in the HTML.
  assert.ok(!decodeBodies(gmail.state.sent[0].mime)[1].includes('/t/'));

  // A group with missing messages can't be approved.
  const other = body.groups.find((x) => x.label === 'Retail · Demand Planner');
  assert.equal((await request(app).post(`/api/groups/${other.id}/approve`).set(auth)).status, 400);

  // Jobs ("crons") are visible with their last run.
  const jobs = (await request(app).get('/api/jobs').set(auth)).body.jobs;
  const send = jobs.find((j) => j.name === 'send');
  assert.ok(send.last_ok_at);
  assert.ok(send.runs >= 3);
  assert.ok(jobs.find((j) => j.name === 'analyze').last_run_at);
});

test('groups: cluster several groups into one, change the criterion, template messages without AI', async () => {
  const { app, auth, campaignId, scheduler } = await prepare();
  await scheduler.tick();
  let { body } = await request(app).get(`/api/campaigns/${campaignId}/groups`).set(auth);
  const planners = body.groups.filter((g) => g.label.endsWith('Demand Planner'));
  const merged = await request(app).post(`/api/campaigns/${campaignId}/groups/merge`).set(auth)
    .send({ target_id: planners[0].id, source_ids: [planners[1].id], label: 'Planners (retail y farma)' });
  assert.equal(merged.status, 200);
  assert.equal(merged.body.groups.length, 2);
  const target = merged.body.groups.find((g) => g.label === 'Planners (retail y farma)');
  assert.equal(target.prospects, 2);

  // Without OpenAI the group starts from the campaign's base templates.
  const gen = await request(app).post(`/api/groups/${target.id}/generate`).set(auth);
  assert.equal(gen.body.engine, 'template');
  assert.equal(gen.body.variants.length, 2);

  ({ body } = await request(app).post(`/api/campaigns/${campaignId}/groups/regroup`).set(auth).send({ group_by: 'persona' }));
  assert.deepEqual(body.groups.map((g) => g.label).sort(), ['Demand Planner', 'Director Financiero']);
});

test('replies: an interested answer becomes a task with a suggested reply, sent in the same thread', async () => {
  const generateFn = async (ctx) => ({ model: 'fake', variants: [{ label: 'g', subject: ctx.stepNumber === 1 ? 'capital en {{company}} este trimestre' : '', body: BODY('Hay capital de trabajo detenido en inventario.'), rationale: '' }] });
  const draftFn = async ({ prospect, category }) => ({ subject: '', body: `Hola ${prospect.first_name}, gracias (${category}). ¿Te queda bien el martes a las 10:00 o el jueves a las 16:00?` });
  const classifyFn = async () => ({ engine: 'rules', category: 'interested', confidence: 0.9 });
  const { app, db, scheduler, clock, gmail, auth, campaignId } = await prepare({ generateFn, draftFn, classifyFn });
  await scheduler.tick();
  const { body } = await request(app).get(`/api/campaigns/${campaignId}/groups`).set(auth);
  const cfo = body.groups.find((g) => g.label.includes('Financiero'));
  await request(app).post(`/api/groups/${cfo.id}/generate`).set(auth).expect(200);
  await request(app).post(`/api/groups/${cfo.id}/approve`).set(auth).expect(200);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 1);
  const thread = gmail.state.sent[0].threadId;

  // Eva answers.
  gmail.state.search = [{ id: 'in-1', threadId: thread, from: 'Eva Paz <eva@tiendas.com>', snippet: 'Me interesa, ¿cuándo podemos hablar?', labelIds: ['INBOX'] }];
  clock.now = new Date(clock.now.getTime() + 60 * 60000);
  await scheduler.tick();
  const inbox = (await request(app).get('/api/inbox').set(auth)).body;
  assert.equal(inbox.counts.replies, 1);
  const reply = inbox.replies[0];
  assert.equal(reply.category, 'interested');
  assert.equal(reply.snippet, 'Me interesa, ¿cuándo podemos hablar?');
  assert.equal(reply.draft_engine, 'ai');
  assert.match(reply.draft_body, /martes a las 10:00/);
  assert.equal(db.prepare("SELECT status FROM prospects WHERE email = 'eva@tiendas.com'").get().status, 'replied');

  // Placeholders must be completed before sending.
  assert.equal((await request(app).post(`/api/replies/${reply.id}/send`).set(auth).send({ body: 'Hola Eva, ¿el [día] a las [hora]?' })).status, 400);
  const sent = await request(app).post(`/api/replies/${reply.id}/send`).set(auth).send({ body: reply.draft_body });
  assert.equal(sent.status, 200, sent.body.error);
  const last = gmail.state.sent.at(-1);
  assert.equal(last.threadId, thread);
  assert.match(last.mime, /In-Reply-To: <in-1@mail\.gmail\.com>/);
  assert.match(last.mime, /Subject: Re: capital en Tiendas SA este trimestre/);
  assert.equal((await request(app).get('/api/inbox').set(auth)).body.counts.replies, 0);
  assert.equal((await request(app).post(`/api/replies/${reply.id}/send`).set(auth).send({ body: 'otra vez' })).status, 400);
});
