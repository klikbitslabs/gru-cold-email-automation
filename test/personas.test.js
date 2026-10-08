// Buyer personas: same company, different motivations → different argument per role.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { SUGGESTED_PERSONAS, matchPersona, similarity } from '../src/lib/personas.js';
import { decodeBodies, insertSender, setup } from './helpers.js';

async function login(app) {
  const res = await request(app).post('/api/auth/register').send({ email: 'owner@acme.com', password: 'supersecreto' });
  return { auth: { Authorization: `Bearer ${res.body.token}` }, userId: res.body.user.id };
}

const BRAND = {
  name: 'QuantraIQ',
  value_proposition: 'Planificación de demanda con IA',
  industries: 'Retail, distribución, farmacias',
  functions: 'Demand Planning, Supply Chain, Finanzas',
  problems: 'Errores de pronóstico, faltantes, exceso de inventario',
};

const importCsv = (app, auth, id, csv) => request(app).post(`/api/campaigns/${id}/prospects/import`).set(auth)
  .field('source', 'CRM propio').field('lawful_basis', 'interes_legitimo').attach('file', Buffer.from(csv), 'base.csv');

const ACCOUNT_CSV = 'email,nombre,apellido,empresa,cargo,sector\n'
  + 'ana@tiendas.com,Ana,Ríos,Tiendas SA,Demand Planner,Retail\n'
  + 'luis@tiendas.com,Luis,Mora,Tiendas SA,Gerente de Supply Chain,Retail\n'
  + 'eva@tiendas.com,Eva,Paz,Tiendas SA,Director Financiero,Retail\n'
  + 'rita@tiendas.com,Rita,Sol,Tiendas SA,Recepcionista,Retail\n';

function campaignBody(brandId, senderId, variants, extra = {}) {
  return {
    name: 'QuantraIQ · Retail',
    brand_id: brandId,
    timezone: 'America/Panama',
    approval_mode: 'none',
    delay_minutes: 0,
    max_contacts_per_company: 3,
    company_gap_days: 0,
    sender_ids: [senderId],
    steps: [{ channel: 'email', variants }],
    hooks: [{ label: 'Cargo', description: 'Responsabilidad', text: 'Como {{title}} en {{company}}, seguro la planificación ocupa buena parte de tu semana.' }],
    ctas: [{ label: 'Genérico', description: '', text: '¿Te interesa conversar?' }],
    ...extra,
  };
}

async function runUntilSent(scheduler, clock, gmail, n) {
  for (let i = 0; i < 12 && gmail.state.sent.length < n; i += 1) {
    await scheduler.tick();
    clock.now = new Date(clock.now.getTime() + 5 * 60000);
  }
}

test('personas: title matching prefers the most specific keyword; similarity compares arguments', () => {
  const personas = SUGGESTED_PERSONAS.map((p, i) => ({ ...p, id: i + 1 }));
  const name = (title) => matchPersona(title, personas)?.name || null;
  assert.equal(name('Demand Planner Sr.'), 'Demand Planner');
  assert.equal(name('Analista de Planificación de la Demanda'), 'Demand Planner');
  assert.equal(name('Gerente de Supply Chain'), 'Gerente de Supply Chain');
  assert.equal(name('Director de Operaciones'), 'Gerente de Supply Chain');
  assert.equal(name('CFO'), 'Director Financiero');
  assert.equal(name('Gerente Financiero y Administrativo'), 'Director Financiero');
  assert.equal(name('Gerente General'), 'Dirección General');
  assert.equal(name('Recepcionista'), null);
  assert.equal(name(''), null);
  assert.ok(similarity('Reducimos faltantes de inventario en retail', 'Reducimos faltantes de inventario en retail') > 0.99);
  assert.ok(similarity('Liberar capital de trabajo inmovilizado', 'Pronósticos por SKU sin hojas de cálculo') < 0.2);
});

test('personas: three roles at one company each get the argument and ask of their role', async () => {
  const { app, db, scheduler, clock, gmail } = setup();
  const { auth, userId } = await login(app);
  const sug = (await request(app).get('/api/brands/personas/suggested').set(auth)).body.personas;
  const brand = (await request(app).post('/api/brands').set(auth).send({ ...BRAND, personas: sug.slice(0, 3) })).body.brand;
  assert.deepEqual(brand.personas.map((p) => p.name), ['Demand Planner', 'Gerente de Supply Chain', 'Director Financiero']);
  const senderId = insertSender(db, userId);
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaignBody(brand.id, senderId, [
    { label: 'Base', subject: 'planificación en {{company}} este trimestre', body: 'Hola {{first_name}},\n\n{{gancho}}\n\n{{problema}}\n\n{{cta}}' },
  ]));
  const id = body.campaign.id;
  await importCsv(app, auth, id, ACCOUNT_CSV);
  const act = await request(app).post(`/api/campaigns/${id}/status`).set(auth).send({ status: 'active' });
  assert.equal(act.status, 200, act.body.error);
  await runUntilSent(scheduler, clock, gmail, 3);

  const row = (email) => db.prepare('SELECT p.*, pe.name AS persona FROM prospects p LEFT JOIN personas pe ON pe.id = p.persona_id WHERE email = ?').get(email);
  assert.equal(row('ana@tiendas.com').persona, 'Demand Planner');
  assert.equal(row('luis@tiendas.com').persona, 'Gerente de Supply Chain');
  assert.equal(row('eva@tiendas.com').persona, 'Director Financiero');
  // No buyer persona for the role → research, never the generic message.
  assert.equal(row('rita@tiendas.com').lead_status, 'research');
  assert.match(row('rita@tiendas.com').lead_status_reasons, /perfil de comprador/);

  assert.equal(gmail.state.sent.length, 3);
  const bodyFor = (email) => decodeBodies(gmail.state.sent.find((m) => m.mime.includes(`To: ${email}`) || m.mime.includes(`<${email}>`)).mime)[0];
  const byName = Object.fromEntries(brand.personas.map((p) => [p.name, p]));
  const ana = bodyFor('ana@tiendas.com');
  const luis = bodyFor('luis@tiendas.com');
  const eva = bodyFor('eva@tiendas.com');
  assert.ok(ana.includes(byName['Demand Planner'].problem));
  assert.ok(ana.includes(byName['Demand Planner'].cta));
  assert.ok(luis.includes(byName['Gerente de Supply Chain'].problem));
  assert.ok(eva.includes(byName['Director Financiero'].problem));
  assert.ok(eva.includes(byName['Director Financiero'].cta));
  assert.ok(!eva.includes('¿Te interesa conversar?'));
  assert.equal(db.prepare('SELECT COUNT(DISTINCT persona_id) AS n FROM messages').get().n, 3);

  // The question "¿Esta persona tiene responsabilidades…?" names the persona and what matters to them.
  const detail = await request(app).get(`/api/prospects/${row('eva@tiendas.com').id}`).set(auth);
  assert.equal(detail.body.prospect.persona.name, 'Director Financiero');
  assert.match(detail.body.questions.find((q) => q.id === 'role_fit').detail, /Perfil: Director Financiero/);
  const company = await request(app).get(`/api/companies/${row('eva@tiendas.com').company_id}`).set(auth);
  assert.deepEqual(company.body.contacts.map((c) => c.persona).filter(Boolean).sort(), ['Demand Planner', 'Director Financiero', 'Gerente de Supply Chain']);
  const analytics = await request(app).get('/api/analytics?days=7').set(auth);
  assert.equal(analytics.body.by_persona.length, 3);
});

test('personas: variants per persona, and the same argument is never sent twice in one account', async () => {
  const { app, db, scheduler, clock, gmail } = setup();
  const { auth, userId } = await login(app);
  // Personas without their own problem text: the copy comes from the variants.
  const personas = [
    { name: 'Demand Planner', match_titles: 'demand planner, planificador de demanda', motivation: 'Precisión del pronóstico' },
    { name: 'Director Financiero', match_titles: 'director financiero, cfo', motivation: 'Capital de trabajo' },
  ];
  const brand = (await request(app).post('/api/brands').set(auth).send({ ...BRAND, personas })).body.brand;
  const cfo = brand.personas.find((p) => p.name === 'Director Financiero');
  const senderId = insertSender(db, userId);
  const generic = 'Hola {{first_name}},\n\n{{gancho}}\n\nEn equipos parecidos el pronóstico se arma a mano en hojas de cálculo y cada promoción obliga a rehacerlo.\n\n{{cta}}';
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaignBody(brand.id, senderId, [
    { label: 'Planner', subject: 'pronóstico en {{company}} esta semana', body: generic },
    { label: 'CFO', persona_id: cfo.id, subject: 'capital de trabajo en {{company}}', body: 'Hola {{first_name}},\n\n{{gancho}}\n\nUna parte del capital de trabajo suele quedar inmovilizada en inventario que no rota.\n\n{{cta}}' },
  ]));
  const id = body.campaign.id;
  const saved = (await request(app).get(`/api/campaigns/${id}`).set(auth)).body.campaign;
  assert.equal(saved.steps[0].variants.find((v) => v.label === 'CFO').persona_id, cfo.id);
  assert.equal(saved.personas.length, 2);

  await importCsv(app, auth, id, 'email,nombre,apellido,empresa,cargo,sector\n'
    + 'ana@tiendas.com,Ana,Ríos,Tiendas SA,Demand Planner,Retail\n'
    + 'eva@tiendas.com,Eva,Paz,Tiendas SA,CFO,Retail\n'
    + 'mario@tiendas.com,Mario,Gil,Tiendas SA,Planificador de Demanda,Retail\n');
  await request(app).post(`/api/campaigns/${id}/status`).set(auth).send({ status: 'active' }).expect(200);
  await runUntilSent(scheduler, clock, gmail, 3);

  const sent = db.prepare('SELECT m.*, p.email, v.label FROM messages m JOIN prospects p ON p.id = m.prospect_id JOIN variants v ON v.id = m.variant_id ORDER BY m.id').all();
  const byEmail = Object.fromEntries(sent.map((m) => [m.email, m]));
  assert.equal(byEmail['eva@tiendas.com'].label, 'CFO');
  // One of the two planners got the generic argument; the second one — same company, same text —
  // is held for a person to adapt instead of being sent.
  assert.equal(sent.filter((m) => m.label === 'Planner').length, 1);
  const held = db.prepare("SELECT d.*, p.email FROM drafts d JOIN prospects p ON p.id = d.prospect_id WHERE d.status = 'pending'").get();
  assert.ok(held, 'second planner draft should wait for review');
  const quality = JSON.parse(held.quality_json);
  assert.ok(quality.issues.some((i) => i.code === 'same_argument' && i.severity === 'error'));
  assert.ok(quality.issues.some((i) => i.code === 'generic_argument'));
  assert.equal(quality.passed, false);
});

test('personas: AI writes for one persona (prompt carries its motivation and the golden rules)', async () => {
  const { generateVariants } = await import('../src/services/openai.js');
  const { updateSettings } = await import('../src/services/settings.js');
  const calls = [];
  const generateFn = async (ctx) => {
    calls.push(ctx);
    return { model: 'fake', variants: [{ label: 'Capital', angle: '', subject: 'capital de trabajo en {{company}}', body: 'Hola {{first_name}},\n\n{{gancho}}\n\nInventario inmovilizado.\n\n{{cta}}', rationale: '' }] };
  };
  const { app, db } = setup({ generateFn });
  const { auth, userId } = await login(app);
  const brand = (await request(app).post('/api/brands').set(auth).send({ ...BRAND, personas: SUGGESTED_PERSONAS.slice(0, 3) })).body.brand;
  const cfo = brand.personas[2];
  const { body } = await request(app).post('/api/campaigns').set(auth).send(campaignBody(brand.id, insertSender(db, userId), [
    { label: 'Base', subject: 'planificación en {{company}} este trimestre', body: 'Hola {{first_name}},\n\n{{gancho}}\n\n{{problema}}\n\n{{cta}}' },
  ]));
  const res = await request(app).post(`/api/campaigns/${body.campaign.id}/ai/variants`).set(auth).send({ step_number: 1, persona_id: cfo.id, count: 1 });
  assert.equal(res.status, 201);
  assert.equal(calls[0].persona.name, 'Director Financiero');
  assert.equal(db.prepare('SELECT persona_id FROM variants WHERE id = ?').get(res.body.variants[0].id).persona_id, cfo.id);
  assert.match(res.body.variants[0].label, /Director Financiero/);
  // A persona of another brand is rejected.
  const other = (await request(app).post('/api/brands').set(auth).send({ name: 'Otra', personas: [{ name: 'X' }] })).body.brand;
  assert.equal((await request(app).post(`/api/campaigns/${body.campaign.id}/ai/variants`).set(auth).send({ step_number: 1, persona_id: other.personas[0].id })).status, 400);

  // Real prompt builder: the persona block and the golden rules reach OpenAI.
  updateSettings({ openai_api_key: 'sk-test' }, userId);
  let sent;
  const fetchFn = async (url, init) => {
    sent = JSON.parse(init.body);
    return { ok: true, json: async () => ({ model: 'gpt', choices: [{ message: { content: JSON.stringify({ variants: [{ label: 'A', body: 'Hola' }] }) } }] }) };
  };
  await generateVariants({ brand, campaign: { name: 'C' }, persona: cfo, stepNumber: 1, count: 1 }, { fetchFn });
  const prompt = sent.messages[1].content;
  assert.match(prompt, /perfil "Director Financiero"/);
  assert.ok(prompt.includes(cfo.motivation));
  assert.match(prompt, /Reglas de oro/);
});
