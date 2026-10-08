// Brands, lead states, the five questions, companies/account rules, sending rules, AI variants and A/B.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { abRecommendations, zScore } from '../src/lib/ab.js';
import { inSendWindow } from '../src/lib/time.js';
import { insertSender, setup } from './helpers.js';

async function login(app) {
  const res = await request(app).post('/api/auth/register').send({ email: 'owner@acme.com', password: 'supersecreto' });
  return { auth: { Authorization: `Bearer ${res.body.token}` }, userId: res.body.user.id };
}

const importCsv = (app, auth, id, csv) => request(app).post(`/api/campaigns/${id}/prospects/import`).set(auth)
  .field('source', 'CRM propio').field('lawful_basis', 'interes_legitimo').attach('file', Buffer.from(csv), 'base.csv');

const BRAND = {
  name: 'Previsio',
  value_proposition: 'Pronóstico de demanda con IA para reducir faltantes y exceso de inventario',
  industries: 'Retail, distribución, farmacias, importadoras',
  functions: 'Demand Planning, Supply Chain, Compras, Dirección',
  problems: 'Errores de pronóstico, faltantes, exceso de inventario, reposición',
  ref_subject: 'faltantes en {{company}}',
  ref_email: 'Hola {{first_name}}, …',
  ref_call: 'Validar cómo planifican la reposición hoy',
};

const campaignBody = (brandId, senderIds, extra = {}) => ({
  name: 'Previsio · Retail',
  brand_id: brandId,
  timezone: 'America/Panama',
  approval_mode: 'none',
  delay_minutes: 0,
  sender_ids: senderIds,
  schedule: {
    1: { on: true, start: '08:00', end: '17:00' }, 2: { on: true, start: '08:00', end: '17:00' },
    3: { on: true, start: '08:00', end: '17:00' }, 4: { on: true, start: '08:00', end: '17:00' },
    5: { on: true, start: '08:00', end: '17:00' }, 6: { on: true, start: '09:00', end: '13:00' },
    7: { on: false, start: '09:00', end: '17:00' },
  },
  steps: [{ channel: 'email', variants: [
    { label: 'A', subject: 'faltantes en {{company}} este mes', body: 'Hola {{first_name}},\n\n{{gancho}}\n\nEn equipos parecidos vemos errores de pronóstico que generan faltantes.\n\n¿Te interesa ver cómo lo resolvieron?' },
    { label: 'B', subject: 'pregunta sobre reposición en {{company}}', body: 'Hola {{first_name}},\n\n{{gancho}}\n\nEn equipos parecidos vemos exceso de inventario por reposición manual.\n\n¿Te interesa ver cómo lo resolvieron?' },
  ] }],
  hooks: [{ label: 'Cargo', description: 'Responsabilidad', text: 'Como {{title}} en {{company}}, imagino que la reposición ocupa buena parte de tu semana.' }],
  ...extra,
});

test('brands: several brands per user, context saved and isolated per user', async () => {
  const { app } = setup();
  const { auth } = await login(app);
  const a = await request(app).post('/api/brands').set(auth).send(BRAND);
  assert.equal(a.status, 201);
  await request(app).post('/api/brands').set(auth).send({ name: 'Otra marca', industries: 'Banca' });
  const list = await request(app).get('/api/brands').set(auth);
  assert.deepEqual(list.body.brands.map((b) => b.name), ['Otra marca', 'Previsio']);
  assert.equal(list.body.brands.find((b) => b.name === 'Previsio').functions, BRAND.functions);
  const other = await request(app).post('/api/auth/register').send({ email: 'x@y.com', password: 'supersecreto' });
  assert.equal((await request(app).put(`/api/brands/${a.body.brand.id}`).set('Authorization', `Bearer ${other.body.token}`).send(BRAND)).status, 404);
});

test('lead states + five questions: ready, research and excluded; fixing data re-analyzes', async () => {
  const { app, db, scheduler } = setup();
  const { auth, userId } = await login(app);
  const brand = (await request(app).post('/api/brands').set(auth).send(BRAND)).body.brand;
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaignBody(brand.id, [insertSender(db, userId)]));
  await importCsv(app, auth, body.campaign.id,
    'email,nombre,empresa,cargo,sector\n' +
    'ana@tiendas.com,Ana,Tiendas SA,Gerente de Supply Chain,Retail\n' +
    'luis@cargas.com,Luis,Cargas SA,,Distribución\n' +
    'eva@banco.com,Eva,Banco SA,Gerente de Compras,Banca\n');
  await scheduler.tick();
  const row = (email) => db.prepare('SELECT * FROM prospects WHERE email = ?').get(email);
  assert.equal(row('ana@tiendas.com').lead_status, 'ready');
  assert.equal(row('luis@cargas.com').lead_status, 'research');
  assert.match(row('luis@cargas.com').lead_status_reasons, /falta el cargo/);
  // Rules can't be sure a bank is a bad fit → research (not excluded on a guess).
  assert.equal(row('eva@banco.com').lead_status, 'research');

  const detail = await request(app).get(`/api/prospects/${row('ana@tiendas.com').id}`).set(auth);
  assert.equal(detail.body.questions.length, 5);
  assert.deepEqual(detail.body.questions.map((q) => q.ok), [true, true, true, true, true]);
  assert.match(detail.body.questions[0].question, /encaja con Previsio/);
  assert.match(detail.body.questions[4].answer, /Paso 1: primer correo/);

  // Research → the person completes the title → immediate re-analysis → ready.
  const fixed = await request(app).patch(`/api/prospects/${row('luis@cargas.com').id}`).set(auth).send({ data: { title: 'Director de Demand Planning' } });
  assert.equal(fixed.body.lead_status, 'ready');

  // Jev saying the company clearly does not fit → excluded.
  const { app: app2, db: db2, scheduler: s2 } = setup({
    analyzeFn: async () => ({ engine: 'jev', segmentId: null, fitScore: 0.1, exclude: false, companyFit: 'no', roleFit: 'yes', problem: 'faltantes', detail: {} }),
  });
  const l2 = await login(app2);
  const b2 = (await request(app2).post('/api/brands').set(l2.auth).send(BRAND)).body.brand;
  const c2 = (await request(app2).post('/api/campaigns').set(l2.auth).send(campaignBody(b2.id, [insertSender(db2, l2.userId)]))).body;
  await importCsv(app2, l2.auth, c2.campaign.id, 'email,nombre,empresa,cargo,sector\neva@banco.com,Eva,Banco SA,Compras,Banca\n');
  await s2.tick();
  const eva = db2.prepare('SELECT * FROM prospects').get();
  assert.deepEqual([eva.lead_status, eva.status], ['excluded', 'stopped']);
  assert.match(eva.stop_reason, /no encaja con la marca/);
});

test('companies: grouped contacts, max contacts per company, gap between colleagues, stop when the company replies', async () => {
  const { app, db, gmail, clock, scheduler } = setup();
  const { auth, userId } = await login(app);
  const brand = (await request(app).post('/api/brands').set(auth).send(BRAND)).body.brand;
  const { body } = await request(app).post('/api/campaigns').set(auth)
    .send(campaignBody(brand.id, [insertSender(db, userId, { min_delay_seconds: 30 })], {
      max_contacts_per_company: 2,
      company_gap_days: 1,
      steps: [...campaignBody(0, []).steps, { channel: 'email', delay_days: 3, variants: [{ label: 'FU', body: '{{first_name}}, ¿pudiste verlo?' }] }],
    }));
  await importCsv(app, auth, body.campaign.id,
    'email,nombre,empresa,cargo,sector\n' +
    'ana@tiendas.com,Ana,Tiendas SA,Gerente de Supply Chain,Retail\n' +
    'beto@tiendas.com,Beto,Tiendas SA,Jefe de Compras,Retail\n' +
    'caro@tiendas.com,Caro,Tiendas SA,Directora de Demand Planning,Retail\n' +
    'dani@otra.com,Dani,Otra SA,Gerente de Compras,Farmacias\n');
  await request(app).post(`/api/campaigns/${body.campaign.id}/status`).set(auth).send({ status: 'active' });

  const companies = await request(app).get('/api/companies').set(auth);
  const tiendas = companies.body.companies.find((c) => c.name === 'Tiendas SA');
  assert.equal(tiendas.contacts, 3);
  assert.equal(tiendas.domain, 'tiendas.com');

  for (let i = 0; i < 4; i += 1) {
    await scheduler.tick();
    clock.now = new Date(clock.now.getTime() + 60000);
  }
  // One first email per company per day: Ana (Tiendas) and Dani (Otra SA).
  const sentTo = () => gmail.state.sent.map((m) => m.mime.match(/^To: .*<(.+)>/m)[1]);
  assert.deepEqual(sentTo().sort(), ['ana@tiendas.com', 'dani@otra.com']);
  const beto = db.prepare("SELECT * FROM prospects WHERE email = 'beto@tiendas.com'").get();
  assert.ok(new Date(beto.next_send_at) > clock.now, 'colleague waits for the company gap');

  clock.now = new Date('2026-10-08T16:00:00Z'); // next day
  for (let i = 0; i < 3; i += 1) {
    await scheduler.tick();
    clock.now = new Date(clock.now.getTime() + 60000);
  }
  assert.ok(sentTo().includes('beto@tiendas.com'));
  const caro = db.prepare("SELECT * FROM prospects WHERE email = 'caro@tiendas.com'").get();
  assert.equal(caro.status, 'stopped');
  assert.match(caro.stop_reason, /Reserva: ya hay 2 contactos/);

  // Ana replies → Beto's follow-ups stop (account in conversation).
  const ana = db.prepare("SELECT * FROM prospects WHERE email = 'ana@tiendas.com'").get();
  db.prepare("UPDATE prospects SET status = 'replied', reply_category = 'interested' WHERE id = ?").run(ana.id);
  clock.now = new Date('2026-10-12T15:00:00Z');
  await scheduler.tick();
  const betoAfter = db.prepare("SELECT * FROM prospects WHERE email = 'beto@tiendas.com'").get();
  assert.equal(betoAfter.status, 'stopped');
  assert.match(betoAfter.stop_reason, /La empresa ya respondió/);
  const detail = await request(app).get(`/api/companies/${tiendas.id}`).set(auth);
  assert.equal(detail.body.contacts.length, 3);
});

test('sending rules: per-day windows, campaign daily cap and delay between emails', async () => {
  const camp = { timezone: 'America/Panama', schedule_json: JSON.stringify(campaignBody(1, []).schedule) };
  assert.equal(inSendWindow(camp, new Date('2026-10-10T15:00:00Z')), true); // Saturday 10:00
  assert.equal(inSendWindow(camp, new Date('2026-10-10T19:00:00Z')), false); // Saturday 14:00 (closes 13:00)
  assert.equal(inSendWindow(camp, new Date('2026-10-11T15:00:00Z')), false); // Sunday off

  const { app, db, gmail, clock, scheduler } = setup();
  const { auth, userId } = await login(app);
  const brand = (await request(app).post('/api/brands').set(auth).send(BRAND)).body.brand;
  const senders = [insertSender(db, userId), insertSender(db, userId, { email: 'otra@acme.com' })];
  const { body } = await request(app).post('/api/campaigns').set(auth)
    .send(campaignBody(brand.id, senders, { max_per_day: 2, delay_minutes: 5, company_gap_days: 0 }));
  assert.equal(body.campaign.schedule['6'].end, '13:00');
  await importCsv(app, auth, body.campaign.id,
    'email,nombre,empresa,cargo,sector\na@uno.com,A,Uno,Compras,Retail\nb@dos.com,B,Dos,Compras,Retail\nc@tres.com,C,Tres,Compras,Retail\n');
  await request(app).post(`/api/campaigns/${body.campaign.id}/status`).set(auth).send({ status: 'active' });
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 1); // two senders, but 5 minutes between campaign emails
  clock.now = new Date(clock.now.getTime() + 2 * 60000);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 1);
  clock.now = new Date(clock.now.getTime() + 4 * 60000);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 2);
  clock.now = new Date(clock.now.getTime() + 60 * 60000);
  await scheduler.tick();
  assert.equal(gmail.state.sent.length, 2); // daily cap of 2 reached
});

test('AI variants are proposals until approved; A/B recommendations are supervised', async () => {
  let received;
  const generateFn = async (ctx) => {
    received = ctx;
    return { model: 'test-model', variants: [{ label: 'Faltantes', angle: 'dolor', subject: 'faltantes en {{company}}', body: 'Hola {{first_name}},\n\n{{gancho}}\n\nTexto.\n\n{{cta}}', rationale: 'prueba asunto de dolor', quality: [] }] };
  };
  const { app, db } = setup();
  const { createApp } = await import('../src/app.js');
  const appAI = createApp({ db, generateFn });
  const { auth, userId } = await login(app);
  const brand = (await request(app).post('/api/brands').set(auth).send(BRAND)).body.brand;
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaignBody(brand.id, [insertSender(db, userId)]));

  const gen = await request(appAI).post(`/api/campaigns/${body.campaign.id}/ai/variants`).set(auth).send({ step_number: 1, count: 1 });
  assert.equal(gen.status, 201, gen.body.error);
  assert.equal(received.brand.name, 'Previsio');
  assert.equal(received.performance.length, 2);
  const variant = db.prepare('SELECT * FROM variants WHERE id = ?').get(gen.body.variants[0].id);
  assert.deepEqual([variant.status, variant.origin], ['proposed', 'ai']);
  assert.match(variant.label, /^IA · /);

  // Proposed variants are not used for sending until approved.
  const ab = await request(app).get(`/api/campaigns/${body.campaign.id}/ab`).set(auth);
  assert.equal(ab.body.groups[0].variants.find((v) => v.id === variant.id).status, 'proposed');
  await request(app).post(`/api/variants/${variant.id}/approve`).set(auth);
  assert.equal(db.prepare('SELECT status FROM variants WHERE id = ?').get(variant.id).status, 'active');

  // Statistics: a clear loser gets a pause recommendation; the person decides.
  assert.ok(zScore(20, 100, 5, 100) > 1.645);
  const recs = abRecommendations([{ step_number: 1, segment: '', variants: [
    { id: 1, label: 'A', status: 'active', sent: 100, opened: 60, replied: 20, positive: 8 },
    { id: 2, label: 'B', status: 'active', sent: 100, opened: 40, replied: 5, positive: 1 },
  ] }]);
  assert.deepEqual(recs.map((r) => r.type), ['pause', 'challenge']);
  assert.equal(recs[0].variant_id, 2);
  const early = abRecommendations([{ step_number: 1, segment: '', variants: [
    { id: 1, label: 'A', status: 'active', sent: 10, opened: 6, replied: 2, positive: 1 },
    { id: 2, label: 'B', status: 'active', sent: 12, opened: 4, replied: 0, positive: 0 },
  ] }]);
  assert.equal(early[0].type, 'collect');

  // The only active variant of a step cannot be paused.
  const ids = db.prepare("SELECT id FROM variants WHERE status = 'active'").all().map((r) => r.id);
  await request(app).post(`/api/variants/${ids[0]}/pause`).set(auth);
  await request(app).post(`/api/variants/${ids[1]}/pause`).set(auth);
  assert.equal((await request(app).post(`/api/variants/${ids[2]}/pause`).set(auth)).status, 400);
});

test('OpenAI client: prompt carries brand context, rules and winners; output is linted', async () => {
  const { app } = setup();
  const { auth } = await login(app);
  await request(app).put('/api/admin/integrations').set(auth).send({ openai_api_key: 'sk-test-1234567890abcdef' });
  const { generateVariants } = await import('../src/services/openai.js');
  let sentBody;
  const fetchFn = async (url, init) => {
    sentBody = JSON.parse(init.body);
    assert.match(url, /\/chat\/completions$/);
    assert.equal(init.headers.Authorization, 'Bearer sk-test-1234567890abcdef');
    const content = JSON.stringify({ variants: [{ label: 'Dolor', angle: 'faltantes', subject: 'OFERTA increíble!!', body: 'Hola {{first_name}},\n\n{{gancho}}\n\nTexto corto.\n\n{{cta}}', rationale: 'r' }] });
    return { ok: true, status: 200, json: async () => ({ model: 'gpt-test', choices: [{ message: { content } }] }) };
  };
  const out = await generateVariants({
    brand: BRAND,
    campaign: { name: 'C', offer: '', icp: '' },
    stepNumber: 1,
    count: 1,
    performance: [{ subject: 'faltantes en {{company}}', body: 'x', sent: 120, open_rate: 55, reply_rate: 9 }],
  }, { fetchFn });
  const prompt = sentBody.messages[1].content;
  assert.match(prompt, /Industria y operación de los clientes: Retail, distribución, farmacias, importadoras/);
  assert.match(prompt, /Función de los contactos: Demand Planning/);
  assert.match(prompt, /respuesta 9%/);
  assert.match(prompt, /3–7 palabras/);
  assert.equal(sentBody.response_format.type, 'json_object');
  assert.equal(out.model, 'gpt-test');
  assert.ok(out.variants[0].quality.some((i) => i.code === 'subject_caps' || i.code === 'subject_exclamation'));
});
