import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { setup } from './helpers.js';
import { testGoogleCredentials } from '../src/routes/admin.js';
import { getSetting, jevConfigured } from '../src/services/settings.js';

const SECRET = 'GOCSPX-super-secreto-1234567890';
const JEV_KEY = 'ts_live_abcdefghijklmnopqrstuvwxyz';

async function users(app) {
  const admin = await request(app).post('/api/auth/register').send({ email: 'admin@acme.com', password: 'supersecreto' });
  const member = await request(app).post('/api/auth/register').send({ email: 'equipo@acme.com', password: 'supersecreto' });
  return {
    admin: { Authorization: `Bearer ${admin.body.token}` },
    member: { Authorization: `Bearer ${member.body.token}` },
    adminUser: admin.body.user,
    memberUser: member.body.user,
  };
}

test('only the first account (admin) can manage integrations', async () => {
  const { app } = setup();
  const { admin, member, adminUser, memberUser } = await users(app);
  assert.equal(adminUser.is_admin, 1);
  assert.equal(memberUser.is_admin, 0);
  assert.equal((await request(app).get('/api/admin/integrations').set(member)).status, 403);
  assert.equal((await request(app).get('/api/admin/integrations')).status, 401);
  assert.equal((await request(app).get('/api/admin/integrations').set(admin)).status, 200);
});

test('API keys are stored encrypted, masked in responses and used by the app', async () => {
  const { app, db } = setup();
  const { admin } = await users(app);

  let res = await request(app).get('/api/admin/integrations').set(admin);
  assert.equal(res.body.settings.google_client_id.configured, false);
  assert.match(res.body.google.redirect_uri, /\/api\/senders\/google\/callback$/);
  assert.equal((await request(app).get('/api/meta')).body.google_configured, false);

  assert.equal((await request(app).put('/api/admin/integrations').set(admin).send({ google_client_id: 'no-es-un-id' })).status, 400);

  res = await request(app).put('/api/admin/integrations').set(admin).send({
    google_client_id: '123-abc.apps.googleusercontent.com',
    google_client_secret: SECRET,
    typesafe_api_key: JEV_KEY,
    allowed_google_domains: 'acme.com, filial.com',
  });
  assert.equal(res.status, 200, res.body.error);
  const body = JSON.stringify(res.body);
  assert.ok(!body.includes(SECRET) && !body.includes(JEV_KEY), 'secrets must never be returned');
  assert.equal(res.body.settings.google_client_secret.value, 'GOCS••••7890');
  assert.equal(res.body.settings.google_client_id.value, '123-abc.apps.googleusercontent.com');
  assert.equal(res.body.settings.typesafe_api_key.source, 'panel');

  const raw = db.prepare('SELECT value_enc FROM app_settings').all().map((r) => r.value_enc).join(' ');
  assert.ok(!raw.includes(SECRET) && !raw.includes(JEV_KEY), 'stored values must be encrypted');

  assert.equal(getSetting('google_client_secret'), SECRET);
  assert.equal(jevConfigured(), true);
  const meta = (await request(app).get('/api/meta')).body;
  assert.deepEqual([meta.google_configured, meta.jev_configured], [true, true]);

  // Google connect now works with the panel credentials.
  const connect = await request(app).get('/api/senders/google/connect').set(admin);
  assert.match(connect.body.url, /client_id=123-abc\.apps\.googleusercontent\.com/);

  // Leaving a field out keeps it; null removes it (env fallback).
  await request(app).put('/api/admin/integrations').set(admin).send({ typesafe_model: 'jev-1.13.0' });
  assert.equal(getSetting('typesafe_api_key'), JEV_KEY);
  await request(app).put('/api/admin/integrations').set(admin).send({ typesafe_api_key: null });
  assert.equal(jevConfigured(), false);
});

test('connection tests', async () => {
  const { app } = setup();
  const { admin } = await users(app);
  await request(app).put('/api/admin/integrations').set(admin).send({ google_client_id: '1-x.apps.googleusercontent.com', google_client_secret: SECRET });
  const fakeGoogle = (error) => async () => ({ status: 400, json: async () => ({ error }) });
  assert.equal((await testGoogleCredentials({ fetchFn: fakeGoogle('invalid_grant') })).ok, true);
  assert.match((await testGoogleCredentials({ fetchFn: fakeGoogle('redirect_uri_mismatch') })).error, /URL de retorno/);
  assert.match((await testGoogleCredentials({ fetchFn: fakeGoogle('invalid_client') })).error, /rechazó/);

  const res = await request(app).post('/api/admin/integrations/test-jev').set(admin);
  assert.equal(res.body.ok, false);
  assert.match(res.body.error, /Falta la API key/);
});
