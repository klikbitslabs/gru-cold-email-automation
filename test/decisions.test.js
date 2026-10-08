// Advanced analytics and the decision center (recommendations, approvals, automation permissions).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import request from 'supertest';
import { insertSender, setup } from './helpers.js';

async function login(app) {
  const res = await request(app).post('/api/auth/register').send({ email: 'owner@acme.com', password: 'supersecreto' });
  return { auth: { Authorization: `Bearer ${res.body.token}` }, userId: res.body.user.id };
}

const BRAND = { name: 'Previsio', industries: 'Retail', functions: 'Supply Chain', problems: 'Faltantes de inventario' };

async function makeCampaign(app, db, auth, userId, extra = {}) {
  const brand = (await request(app).post('/api/brands').set(auth).send(BRAND)).body.brand;
  const senderId = insertSender(db, userId);
  const { body } = await request(app).post('/api/campaigns').set(auth).send({
    name: 'Retail Q4',
    brand_id: brand.id,
    timezone: 'America/Panama',
    sender_ids: [senderId],
    steps: [{ channel: 'email', variants: [
      { label: 'A', subject: 'faltantes en {{company}} este mes', body: 'Hola {{first_name}},\n\nVi que lideras compras.\n\nEn equipos parecidos vemos faltantes.\n\n¿Lo conversamos?' },
      { label: 'B', subject: 'pregunta sobre reposición en {{company}}', body: 'Hola {{first_name}},\n\nVi que lideras compras.\n\nEn equipos parecidos vemos exceso de inventario.\n\n¿Lo conversamos?' },
    ] }],
    ...extra,
  });
  const campaignId = body.campaign.id;
  db.prepare("UPDATE campaigns SET status = 'active' WHERE id = ?").run(campaignId);
  const variants = db.prepare('SELECT v.* FROM variants v JOIN steps s ON s.id = v.step_id WHERE s.campaign_id = ? ORDER BY v.id').all(campaignId);
  return { campaignId, senderId, variants, brandId: brand.id };
}

let seq = 0;
/** Inserts `n` contacted prospects with one sent message each and the given outcomes. */
function seed(db, { campaignId, senderId, variantId, n, opened = 0, replied = 0, bounced = 0, unsub = 0, sentAt, openAt = sentAt, industry = 'Retail' }) {
  for (let i = 0; i < n; i += 1) {
    seq += 1;
    const status = i < replied ? 'replied' : i < replied + bounced ? 'bounced' : i < replied + bounced + unsub ? 'unsubscribed' : 'active';
    const pid = Number(db.prepare(
      `INSERT INTO prospects (campaign_id, email, first_name, company, title, industry, status, current_step, unsubscribe_token, lead_status, reply_category, replied_at)
       VALUES (?, ?, 'Ana', 'Tiendas', 'Gerente de Compras', ?, ?, 1, ?, 'ready', ?, ?)`,
    ).run(campaignId, `p${seq}@tienda${seq}.com`, industry, status, `u${seq}`, status === 'replied' ? 'interested' : null,
      status === 'replied' ? new Date(sentAt.getTime() + 5 * 3600000).toISOString() : null).lastInsertRowid);
    const isOpen = i < opened;
    const mid = Number(db.prepare(
      `INSERT INTO messages (prospect_id, campaign_id, sender_id, step_number, variant_id, subject, body_text, tracking_token, sent_at, open_count, first_opened_at)
       VALUES (?, ?, ?, 1, ?, 'asunto', 'cuerpo', ?, ?, ?, ?)`,
    ).run(pid, campaignId, senderId, variantId, `t${seq}`, sentAt.toISOString(), isOpen ? 1 : 0, isOpen ? openAt.toISOString() : null).lastInsertRowid);
    if (isOpen) db.prepare('INSERT INTO open_events (message_id, opened_at, suspected_bot) VALUES (?, ?, 0)').run(mid, openAt.toISOString());
  }
}

test('analytics: KPIs with previous period, daily series, open heatmap and breakdowns', async () => {
  const { app, db } = setup();
  const { auth, userId } = await login(app);
  const { campaignId, senderId, variants } = await makeCampaign(app, db, auth, userId);
  // Now: Wed 2026-10-07 15:00Z. This period: 20 sends on Monday 14:00Z (09:00 Panama), 10 opens at 15:00Z.
  seed(db, { campaignId, senderId, variantId: variants[0].id, n: 20, opened: 10, replied: 4, bounced: 1, sentAt: new Date('2026-10-05T14:00:00Z'), openAt: new Date('2026-10-05T15:00:00Z') });
  // Previous period (8–14 days ago): 10 sends, 2 opens.
  seed(db, { campaignId, senderId, variantId: variants[1].id, n: 10, opened: 2, sentAt: new Date('2026-09-28T14:00:00Z') });

  const res = await request(app).get('/api/analytics?days=7&tz=America/Panama').set(auth);
  assert.equal(res.status, 200);
  const { kpis, previous, daily, heatmap, by_subject: bySubject, by_industry: byIndustry, timing } = res.body;
  assert.equal(kpis.sent, 20);
  assert.equal(kpis.opened, 10);
  assert.equal(kpis.replied, 4);
  assert.equal(kpis.positive, 4);
  assert.equal(kpis.bounced, 1);
  assert.equal(kpis.open_rate, Math.round((10 / 19) * 1000) / 10);
  assert.equal(kpis.reply_rate, 20);
  assert.equal(previous.sent, 10);
  assert.equal(previous.opened, 2);
  assert.equal(daily.length, 7);
  assert.equal(daily.find((d) => d.date === '2026-10-05').sent, 20);
  // Monday (index 0), 10:00 Panama time.
  assert.equal(heatmap[0][10], 10);
  assert.equal(bySubject.length, 1);
  assert.equal(bySubject[0].label, 'A');
  assert.equal(bySubject[0].open_rate, 50);
  assert.equal(byIndustry[0].industry, 'Retail');
  assert.equal(timing.median_hours_to_open, 1);
  assert.equal(timing.median_hours_to_reply, 5);

  // Filters: another brand's campaign has nothing.
  const other = await request(app).post('/api/brands').set(auth).send({ name: 'Otra' });
  const empty = await request(app).get(`/api/analytics?days=7&brand_id=${other.body.brand.id}`).set(auth);
  assert.equal(empty.body.kpis.sent, 0);
  assert.equal(empty.body.kpis.open_rate, null);
  assert.equal((await request(app).get('/api/analytics?from=2026-10-07&to=2026-10-01').set(auth)).status, 400);
});

test('decisions: A/B loser → recommendation; approving pauses the variant; dismiss silences', async () => {
  const { app, db } = setup();
  const { auth, userId } = await login(app);
  const { campaignId, senderId, variants } = await makeCampaign(app, db, auth, userId);
  const sentAt = new Date('2026-10-05T14:00:00Z');
  seed(db, { campaignId, senderId, variantId: variants[0].id, n: 60, opened: 36, replied: 12, sentAt });
  seed(db, { campaignId, senderId, variantId: variants[1].id, n: 60, opened: 30, replied: 1, sentAt });

  await request(app).post('/api/decisions/refresh').set(auth).expect(200);
  const { body } = await request(app).get('/api/decisions').set(auth);
  const pause = body.open.find((r) => r.type === 'pause_variant');
  assert.ok(pause, 'expected a pause recommendation');
  assert.equal(pause.action.variant_id, variants[1].id);
  assert.equal(pause.severity, 'high');
  assert.match(pause.reason, /respuesta 20%/);
  // Without OpenAI the challenger recommendation is informative only.
  const challenger = body.open.find((r) => r.type === 'generate_variants');
  assert.ok(challenger);
  assert.equal(challenger.action, null);
  assert.equal(body.permissions.pause_variant, false);
  assert.equal((await request(app).get('/api/decisions/count').set(auth)).body.open, body.open.length);

  const approved = await request(app).post(`/api/decisions/${pause.id}/approve`).set(auth);
  assert.equal(approved.status, 200);
  assert.match(approved.body.result, /pausada/);
  assert.equal(db.prepare('SELECT status FROM variants WHERE id = ?').get(variants[1].id).status, 'paused');
  assert.equal((await request(app).post(`/api/decisions/${pause.id}/approve`).set(auth)).status, 400);

  // Informative recommendation can't be "approved", only dismissed; dismissing keeps it away.
  assert.equal((await request(app).post(`/api/decisions/${challenger.id}/approve`).set(auth)).status, 400);
  await request(app).post(`/api/decisions/${challenger.id}/dismiss`).set(auth).expect(200);
  await request(app).post('/api/decisions/refresh').set(auth).expect(200);
  const after = (await request(app).get('/api/decisions').set(auth)).body;
  assert.equal(after.open.filter((r) => r.type === 'generate_variants').length, 0);
  assert.deepEqual(after.history.map((r) => r.status).sort(), ['approved', 'dismissed']);

  // Another user can't see or act on these recommendations.
  const other = await request(app).post('/api/auth/register').send({ email: 'x@y.com', password: 'supersecreto' });
  const otherAuth = { Authorization: `Bearer ${other.body.token}` };
  assert.equal((await request(app).get('/api/decisions').set(otherAuth)).body.history.length, 0);
  assert.equal((await request(app).post(`/api/decisions/${challenger.id}/dismiss`).set(otherAuth)).status, 404);
});

test('decisions: automatic permission pauses a sender with high bounce rate on the hourly tick', async () => {
  const { app, db, scheduler } = setup();
  const { auth, userId } = await login(app);
  const { campaignId, senderId, variants } = await makeCampaign(app, db, auth, userId);
  seed(db, { campaignId, senderId, variantId: variants[0].id, n: 40, bounced: 4, sentAt: new Date('2026-10-05T14:00:00Z') });

  const perms = await request(app).put('/api/decisions/permissions').set(auth).send({ pause_sender: true, nope: true });
  assert.equal(perms.body.permissions.pause_sender, true);
  assert.equal(perms.body.permissions.nope, undefined);
  await scheduler.tick();
  assert.equal(db.prepare('SELECT status FROM senders WHERE id = ?').get(senderId).status, 'paused');
  const rec = db.prepare("SELECT * FROM recommendations WHERE type = 'pause_sender'").get();
  assert.equal(rec.status, 'auto_applied');
  assert.match(rec.result, /pausado/);
});

test('decisions: sending window follows when prospects open; approval backlog; AI copy loop', async () => {
  const proposals = [];
  const generateFn = async (ctx) => {
    proposals.push(ctx);
    return { model: 'fake', variants: [{ label: 'Asunto nuevo', angle: '', subject: 'reposición en {{company}} esta semana', body: 'Hola {{first_name}},\n\nVi que lideras compras.\n\nEn equipos parecidos vemos faltantes.\n\n¿Lo conversamos?', rationale: 'Asunto más específico' }] };
  };
  const { app, db, clock } = setup({ generateFn });
  const { auth, userId } = await login(app);
  const { campaignId, senderId, variants } = await makeCampaign(app, db, auth, userId);
  // 50 sends, opens at 20:00 Panama (01:00Z next day), outside the 08–17 window; open rate 10% for A.
  seed(db, { campaignId, senderId, variantId: variants[0].id, n: 50, opened: 5, sentAt: new Date('2026-10-05T14:00:00Z'), openAt: new Date('2026-10-06T01:00:00Z') });
  seed(db, { campaignId, senderId, variantId: variants[1].id, n: 45, opened: 40, sentAt: new Date('2026-10-05T14:00:00Z'), openAt: new Date('2026-10-06T00:00:00Z') });
  // A pending draft that passed quality control, waiting 3 hours.
  const prospect = db.prepare('SELECT id FROM prospects WHERE campaign_id = ? LIMIT 1').get(campaignId);
  db.prepare("INSERT INTO drafts (prospect_id, campaign_id, step_number, sender_id, subject, body, quality_json, created_at) VALUES (?, ?, 2, ?, 's', 'b', '{\"errors\":0}', ?)")
    .run(prospect.id, campaignId, senderId, new Date(clock.now - 3 * 3600000).toISOString());

  await request(app).post('/api/decisions/refresh').set(auth).expect(200);
  let open = (await request(app).get('/api/decisions').set(auth)).body.open;
  const schedule = open.find((r) => r.type === 'adjust_schedule');
  assert.ok(schedule, 'expected a schedule recommendation');
  assert.match(schedule.title, /enviar de 1\d:00 a 2\d:00/);
  const drafts = open.find((r) => r.type === 'approve_drafts');
  assert.ok(drafts);
  const subject = open.find((r) => r.type === 'generate_variants');
  assert.equal(subject.evidence.focus, 'subject');
  assert.equal(subject.action.base_variant_id, variants[0].id);

  await request(app).post(`/api/decisions/${schedule.id}/approve`).set(auth).expect(200);
  const updated = JSON.parse(db.prepare('SELECT schedule_json FROM campaigns WHERE id = ?').get(campaignId).schedule_json);
  assert.equal(updated[1].on, true);
  assert.equal(updated[7].on, false);
  assert.ok(Number(updated[1].end.slice(0, 2)) >= 20);

  await request(app).post(`/api/decisions/${drafts.id}/approve`).set(auth).expect(200);
  assert.equal(db.prepare('SELECT status FROM drafts').get().status, 'approved');

  // Autopilot for copy: generation and activation of proposals that pass quality control.
  await request(app).put('/api/decisions/permissions').set(auth).send({ generate_variants: true, activate_variants: true }).expect(200);
  await request(app).post('/api/decisions/refresh').set(auth).expect(200);
  assert.equal(proposals.length, 1);
  assert.equal(proposals[0].focus, 'subject');
  const proposed = db.prepare("SELECT * FROM variants WHERE origin = 'ai'").get();
  assert.equal(proposed.status, 'proposed');
  await request(app).post('/api/decisions/refresh').set(auth).expect(200);
  assert.equal(db.prepare('SELECT status FROM variants WHERE id = ?').get(proposed.id).status, 'active');
  const history = (await request(app).get('/api/decisions').set(auth)).body.history;
  assert.ok(history.some((r) => r.type === 'activate_variants' && r.status === 'auto_applied'));
});
