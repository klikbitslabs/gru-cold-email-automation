// End-to-end coverage of the decision architecture:
// import → validation → commercial intelligence → generation + quality + approval → orchestration → results.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { decodeBodies, insertSender, setup } from './helpers.js';

async function login(app) {
  const res = await request(app).post('/api/auth/register').send({ email: 'owner@acme.com', password: 'supersecreto' });
  return { auth: { Authorization: `Bearer ${res.body.token}` }, userId: res.body.user.id };
}

const importFile = (app, auth, id, csv, fields = { source: 'CRM propio', lawful_basis: 'interes_legitimo' }) => {
  let req = request(app).post(`/api/campaigns/${id}/prospects/import`).set(auth);
  for (const [k, v] of Object.entries(fields)) req = req.field(k, v);
  return req.attach('file', Buffer.from(csv), 'base.csv');
};

const body3 = 'Hola {{first_name}},\n\n{{gancho}}\n\n{{problema}}\n\n{{cta}}';

const campaign = (senderIds, overrides = {}) => ({
  name: 'Retail + Logística',
  offer: 'Automatizamos la prospección B2B para equipos comerciales',
  icp: 'Gerentes comerciales en retail y logística',
  timezone: 'America/Panama',
  send_days: [1, 2, 3, 4, 5],
  window_start: '08:00',
  window_end: '17:00',
  approval_mode: 'first',
  sender_ids: senderIds,
  segments: [
    { name: 'Retail', description: 'Cadenas de tiendas y comercio minorista' },
    { name: 'Logística', description: 'Empresas de transporte, distribución y almacenes' },
  ],
  steps: [
    {
      channel: 'email',
      variants: [
        { label: 'Retail A', segment: 'Retail', subject: 'tiendas de {{company}} y ventas', body: body3 },
        { label: 'Retail B', segment: 'Retail', subject: 'pregunta sobre su equipo comercial', body: body3 },
        { label: 'Logística A', segment: 'Logística', subject: 'rutas comerciales en {{company}}', body: body3 },
      ],
    },
    { channel: 'call', delay_days: 2, variants: [{ label: 'Guion', body: 'Llamar a {{first_name}} ({{title}}). Mencionar el correo sobre {{company}}.' }] },
    { channel: 'email', delay_days: 3, variants: [{ label: 'Seguimiento', body: '{{first_name}}, retomo mi correo anterior con un dato concreto de otro cliente del sector.\n\n{{cta}}' }] },
  ],
  hooks: [
    { label: 'Expansión', description: 'Apertura de tiendas reciente', segment: 'Retail', text: 'Vi que {{company}} {{noticia}}, y con ese crecimiento el equipo comercial suele quedarse corto para atender nuevas zonas.' },
    { label: 'Responsabilidad', description: 'Su cargo y responsabilidad', text: 'Como {{title}} en {{company}}, imagino que buena parte de tu semana se va en coordinar al equipo comercial y sus metas.' },
  ],
  problems: [
    { label: 'Prospección manual', description: 'El equipo investiga leads a mano', text: 'En equipos parecidos vemos que se pierden varias horas por semana investigando prospectos a mano antes de cada contacto.' },
  ],
  ctas: [{ label: 'Interés', description: 'Baja fricción', text: '¿Tiene sentido que te comparta cómo lo resolvieron?' }],
  ...overrides,
});

test('import validates leads and requires an authorized source', async () => {
  const { app, db } = setup({ deadDomains: ['muerto.com'] });
  const { auth, userId } = await login(app);
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaign([insertSender(db, userId)]));
  const csv = 'email,nombre,empresa,cargo\nana@tiendas.com,Ana,Tiendas SA,Gerente Comercial\ninfo@tiendas.com,,Tiendas SA,\nluis@muerto.com,Luis,Muerto,CEO\nana@tiendas.com,Ana,Dup,\nmal-email,X,Y,Z\n';

  const missing = await importFile(app, auth, body.campaign.id, csv, {});
  assert.equal(missing.status, 400);
  assert.match(missing.body.error, /origen|base legal/i);

  const r = await importFile(app, auth, body.campaign.id, csv);
  assert.equal(r.status, 200, r.body.error);
  assert.deepEqual([r.body.imported, r.body.valid, r.body.risky, r.body.invalid, r.body.duplicates], [3, 1, 1, 2, 1]);
  const dead = db.prepare("SELECT * FROM prospects WHERE email = 'luis@muerto.com'").get();
  assert.equal(dead.status, 'stopped');
  assert.match(dead.stop_reason, /MX/);
  const info = db.prepare("SELECT * FROM prospects WHERE email = 'info@tiendas.com'").get();
  assert.equal(info.validation_status, 'risky');
  assert.equal(info.source, 'CRM propio');
  assert.equal(info.lawful_basis, 'interes_legitimo');
});

test('segmentation, verifiable hooks, approval queue, call task and outcome funnel', async () => {
  const { app, db, gmail, clock, scheduler } = setup();
  const { auth, userId } = await login(app);
  const senderId = insertSender(db, userId);
  const created = await request(app).post('/api/campaigns').set(auth).send(campaign([senderId]));
  assert.equal(created.status, 201, created.body.error);
  const id = created.body.campaign.id;
  assert.equal(created.body.campaign.steps[1].channel, 'call');

  await importFile(app, auth, id,
    'email,nombre,empresa,cargo,sector,noticia\n' +
    'ana@tiendas.com,Ana,Tiendas SA,Gerente Comercial,Retail de tiendas,abrió tres tiendas este mes\n' +
    'luis@cargas.com,Luis,Cargas SA,Director Comercial,Logística y distribución,\n');

  // Readiness: one segment has a single first-email variant → recommendation, not a blocker.
  const ready = await request(app).get(`/api/campaigns/${id}`).set(auth);
  assert.deepEqual(ready.body.readiness.problems, []);
  assert.ok(ready.body.readiness.recommendations.some((r) => /Logística/.test(r)));

  // Commercial intelligence runs right after import, before activation (rules: keyword overlap).
  await scheduler.tick();
  const segOf = (email) => db.prepare('SELECT sg.name FROM prospects p JOIN segments sg ON sg.id = p.segment_id WHERE p.email = ?').get(email)?.name;
  assert.equal(segOf('ana@tiendas.com'), 'Retail');
  assert.equal(segOf('luis@cargas.com'), 'Logística');

  assert.equal((await request(app).post(`/api/campaigns/${id}/status`).set(auth).send({ status: 'active' })).status, 200);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 0); // mode "first": step 1 waits for approval

  const { body: queue } = await request(app).get(`/api/campaigns/${id}/drafts`).set(auth);
  assert.equal(queue.drafts.length, 2);
  const ana = queue.drafts.find((d) => d.email === 'ana@tiendas.com');
  const luis = queue.drafts.find((d) => d.email === 'luis@cargas.com');
  // Segment-specific variants; Ana gets the news hook (she has "noticia"), Luis only the verifiable role hook.
  assert.match(ana.subject, /tiendas de Tiendas SA y ventas|pregunta sobre su equipo comercial/);
  assert.match(ana.body, /Vi que Tiendas SA abrió tres tiendas este mes/);
  assert.equal(luis.subject, 'rutas comerciales en Cargas SA');
  assert.match(luis.body, /Como Director Comercial en Cargas SA/);
  assert.doesNotMatch(luis.body, /Vi que/);
  assert.match(ana.body, /^Hola Ana,\n\nVi que .+\n\nEn equipos parecidos .+\n\n¿Tiene sentido/s);
  assert.equal(ana.quality.errors, 0);

  // Editing re-runs quality control; a link in the first email is an error that needs force.
  const edited = await request(app).patch(`/api/drafts/${luis.id}`).set(auth).send({ subject: luis.subject, body: `${luis.body}\n\nhttps://acme.com/demo` });
  assert.equal(edited.body.quality.errors, 1);
  assert.equal((await request(app).post(`/api/drafts/${luis.id}/approve`).set(auth).send({})).status, 400);
  await request(app).patch(`/api/drafts/${luis.id}`).set(auth).send({ subject: luis.subject, body: luis.body });

  const all = await request(app).post(`/api/campaigns/${id}/drafts/approve-all`).set(auth).send({});
  assert.equal(all.body.approved, 2);
  await scheduler.tick();
  clock.now = new Date(clock.now.getTime() + 10 * 60000);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 2);
  const [text] = decodeBodies(gmail.state.sent.find((m) => /ana@tiendas.com/.test(m.mime)).mime);
  assert.match(text, /Vi que Tiendas SA abrió tres tiendas/);

  // Step 2 is a cold call: after the delay it becomes a task, not an email.
  clock.now = new Date('2026-10-09T16:00:00Z');
  await scheduler.tick();
  const { body: tasks } = await request(app).get('/api/tasks').set(auth);
  assert.equal(tasks.tasks.length, 2);
  const anaTask = tasks.tasks.find((t) => t.email === 'ana@tiendas.com');
  assert.equal(anaTask.channel, 'call');
  assert.match(anaTask.instructions, /Llamar a Ana \(Gerente Comercial\)/);

  // Luis books a meeting on the call → sequence stops, outcome recorded. Ana: no answer → sequence continues.
  const luisTask = tasks.tasks.find((t) => t.email === 'luis@cargas.com');
  await request(app).post(`/api/tasks/${luisTask.id}/complete`).set(auth).send({ outcome: 'meeting', note: 'Jueves 10am' });
  await request(app).post(`/api/tasks/${anaTask.id}/complete`).set(auth).send({ outcome: 'no_answer' });
  const luisRow = db.prepare("SELECT * FROM prospects WHERE email = 'luis@cargas.com'").get();
  assert.deepEqual([luisRow.status, luisRow.outcome], ['replied', 'meeting']);
  const anaRow = db.prepare("SELECT * FROM prospects WHERE email = 'ana@tiendas.com'").get();
  assert.deepEqual([anaRow.status, anaRow.current_step], ['active', 2]);

  // Step 3 (email follow-up, mode "first") is auto-approved and threaded.
  clock.now = new Date('2026-10-12T17:00:00Z');
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 3);
  assert.match(gmail.state.sent[2].mime, /Subject: Re: /);

  // Results: opportunity → won, funnel counts never downgrade.
  await request(app).patch(`/api/prospects/${luisRow.id}`).set(auth).send({ outcome: 'won' });
  await request(app).patch(`/api/prospects/${luisRow.id}`).set(auth).send({ outcome: 'interested' });
  const { body: stats } = await request(app).get(`/api/campaigns/${id}/stats`).set(auth);
  assert.equal(stats.totals.contacted, 2);
  assert.deepEqual([stats.totals.meetings, stats.totals.opportunities, stats.totals.won], [1, 1, 1]);
  assert.equal(db.prepare('SELECT outcome FROM prospects WHERE id = ?').get(luisRow.id).outcome, 'won');
  assert.deepEqual(stats.by_segment.map((s) => s.segment).sort(), ['Logística', 'Retail']);
});

test('learning loop: variant results are passed to the decision engine', async () => {
  const seen = [];
  const decideFn = async (ctx) => {
    seen.push(ctx.variants.map((v) => ({ label: v.label, stats: v.stats })));
    return { engine: 'jev', action: 'send', variantId: ctx.variants[0].id, ctaId: ctx.ctas[0]?.id, hookId: ctx.hooks[0]?.id, problemId: ctx.problems[0]?.id, slot: null, detail: {} };
  };
  const { app, db, scheduler } = setup({ decideFn });
  const { auth, userId } = await login(app);
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaign([insertSender(db, userId)], { approval_mode: 'none' }));
  await importFile(app, auth, body.campaign.id, 'email,nombre,empresa,cargo,sector\nana@tiendas.com,Ana,Tiendas SA,Gerente,Retail de tiendas\n');
  await request(app).post(`/api/campaigns/${body.campaign.id}/status`).set(auth).send({ status: 'active' });
  await scheduler.tick();
  assert.equal(seen.length, 1);
  assert.deepEqual(seen[0].map((v) => v.label), ['Retail A', 'Retail B']);
  assert.deepEqual(seen[0][0].stats, { sent: 0, replied: 0, positive: 0 });
});
