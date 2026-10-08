import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import { parseProspectsCsv } from '../src/lib/csv.js';
import { lintEmail } from '../src/lib/lint.js';
import { buildMime, encodeHeader } from '../src/lib/mime.js';
import { buildEmailBody, renderTemplate, sanitizeSignature } from '../src/lib/template.js';
import { inSendWindow, localParts, nextLocalSlot } from '../src/lib/time.js';
import { decide, ruleClassifyReply, slotRanges } from '../src/services/jev.js';

test('CSV import maps Spanish headers, semicolons and keeps custom fields', () => {
  const csv = 'Nombre;Apellido;Correo;Empresa;Cargo;Ciudad\nAna;Pérez;ANA@EJEMPLO.COM;Ejemplo SA;CEO;Panamá\nMal;Dato;no-es-email;X;Y;Z\n';
  const out = parseProspectsCsv(Buffer.from(csv));
  assert.equal(out.prospects.length, 1);
  assert.deepEqual(out.prospects[0], {
    email: 'ana@ejemplo.com', first_name: 'Ana', last_name: 'Pérez', company: 'Ejemplo SA', title: 'CEO', fields: { ciudad: 'Panamá' },
  });
  assert.equal(out.invalid.length, 1);
  assert.equal(out.invalid[0].row, 3);
});

test('CSV without an email column is rejected', () => {
  assert.throws(() => parseProspectsCsv(Buffer.from('a,b\n1,2\n')), /email/);
});

test('templates render fields, fallbacks and report missing ones', () => {
  const vars = { first_name: 'Ana', company: '' };
  assert.deepEqual(renderTemplate('Hola {{first_name}}, vi {{ Company | tu empresa }}.', vars), { text: 'Hola Ana, vi tu empresa.', missing: [] });
  assert.deepEqual(renderTemplate('Hola {{last_name}}, ¿qué tal?', vars).missing, ['last_name']);
});

test('signature sanitizer strips scripts and handlers', () => {
  const s = sanitizeSignature('<p onclick="x()">Hi</p><script>alert(1)</script><a href="javascript:evil()">a</a>');
  assert.equal(s, '<p>Hi</p><a href="#">a</a>');
});

test('email body includes signature, pixel, unsubscribe and escapes HTML', () => {
  const { text, html } = buildEmailBody({ body: 'Hola <Ana>\nvisita https://x.com', signatureHtml: '<b>Laura</b>', trackingPixelUrl: 'https://t/p.gif', unsubscribeUrl: 'https://u/1' });
  assert.match(html, /Hola &lt;Ana&gt;<br>visita <a href="https:\/\/x.com">/);
  assert.match(html, /gmail_signature.*<b>Laura<\/b>/);
  assert.match(html, /<img src="https:\/\/t\/p.gif"/);
  assert.match(text, /Laura\n\n--\nSi no quieres recibir más correos: https:\/\/u\/1/);
});

test('MIME encodes UTF-8 subjects and threads replies', () => {
  assert.equal(encodeHeader('hola'), 'hola');
  assert.match(encodeHeader('reunión'), /^=\?UTF-8\?B\?/);
  const mime = buildMime({ from: 'a@b.com', to: 'c@d.com', subject: 'Re: hola', text: 't', html: 'h', inReplyTo: '<x@y>', references: '<x@y>' });
  assert.match(mime, /In-Reply-To: <x@y>\r\nReferences: <x@y>/);
  assert.match(mime, /multipart\/alternative/);
});

test('linter flags long, salesy, link-heavy first emails', () => {
  const body = `${'palabra '.repeat(140)} gratis https://a.com https://b.com ¿agendamos una llamada de 30 min?`;
  const codes = lintEmail({ subject: 'OFERTA INCREÍBLE PARA TU EMPRESA HOY MISMO!!!', body, stepNumber: 1 }).warnings.map((w) => w.code);
  for (const code of ['too_long', 'long_subject', 'shouty_subject', 'spam_words', 'links', 'no_personalization', 'big_ask']) {
    assert.ok(codes.includes(code), code);
  }
  assert.deepEqual(lintEmail({ subject: 'idea para {{company}}', body: 'Hola {{first_name}}, vi que {{company}} está contratando vendedores. ¿Te interesa?', stepNumber: 1 }).warnings, []);
});

test('send window and slots respect the campaign time zone', () => {
  const campaign = { timezone: 'America/Panama', send_days: '1,2,3,4,5', window_start: '08:00', window_end: '17:00' };
  // 2026-10-07 is a Wednesday; 15:00Z = 10:00 in Panama (UTC-5).
  assert.equal(localParts(new Date('2026-10-07T15:00:00Z'), 'America/Panama').hour, 10);
  assert.equal(inSendWindow(campaign, new Date('2026-10-07T15:00:00Z')), true);
  assert.equal(inSendWindow(campaign, new Date('2026-10-07T23:00:00Z')), false);
  assert.equal(inSendWindow(campaign, new Date('2026-10-10T15:00:00Z')), false); // Saturday
  const slots = slotRanges('08:00', '17:00');
  assert.deepEqual(slots.map((s) => s.label), ['08:00–11:00', '11:00–14:00', '14:00–17:00']);
  // Friday 16:00 local, asking for the early slot → Monday 08:00 local (13:00Z).
  assert.equal(nextLocalSlot(campaign, new Date('2026-10-09T21:00:00Z'), 480, 660).toISOString(), '2026-10-12T13:00:00.000Z');
});

test('reply rules separate auto-replies, bounces and refusals', () => {
  assert.equal(ruleClassifyReply({ from: 'Mail Delivery Subsystem <mailer-daemon@googlemail.com>', snippet: 'Address not found' }), 'bounce');
  assert.equal(ruleClassifyReply({ from: 'ana@x.com', snippet: 'Estoy fuera de la oficina hasta el lunes' }), 'auto_reply');
  assert.equal(ruleClassifyReply({ from: 'ana@x.com', snippet: 'No me interesa, gracias' }), 'not_interested');
});

test('decide() maps Jev answers to an action and falls back to rules on error', async () => {
  const ctx = {
    campaign: { jev_enabled: 1, icp: 'Gerentes de ventas en SaaS', offer: 'x', window_start: '08:00', window_end: '17:00' },
    prospect: { id: 7, email: 'a@b.com', first_name: 'A', last_name: '', company: 'B', title: 'CEO', fields_json: '{}' },
    stepNumber: 2,
    totalSteps: 4,
    engagement: { human_opens_total: 3, previous_open_slots: ['late'] },
    variants: [{ id: 11, label: 'A', angle: 'case study', preview: '' }, { id: 12, label: 'B', angle: 'pain', preview: '' }],
    ctas: [{ id: 21, label: 'soft', text: '¿Te interesa?' }, { id: 22, label: 'call', text: '¿15 min?' }],
  };
  let sent;
  const client = {
    async systemOne(req) {
      sent = req;
      return {
        model: 'jev-test',
        usage: { input_tokens: 10, output_tokens: 0 },
        answers: {
          stop: { type: 'noul', noul: 0.1 },
          send_slot: { type: 'choice', choice: 'late', confidence: 0.8, probabilities: {} },
          variant: { type: 'choice', choice: 'v12', confidence: 0.7, probabilities: { v11: 0.3, v12: 0.7 } },
          cta: { type: 'choice', choice: 'c22', confidence: 0.9, probabilities: {} },
          fit: { type: 'score', score: 3, confidence: 0.8, probabilities: {} },
        },
      };
    },
  };
  const d = await decide(ctx, { client });
  assert.equal(d.engine, 'jev');
  assert.deepEqual([d.action, d.variantId, d.ctaId, d.slot, d.fitScore], ['send', 12, 22, 'late', 0.75]);
  assert.deepEqual(Object.keys(sent.questions).sort(), ['cta', 'fit', 'send_slot', 'stop', 'variant']);
  assert.equal(sent.questions.variant.type, 'choice');
  assert.ok(sent.state.candidate_messages.v11);

  const stop = await decide(ctx, { client: { systemOne: async () => ({ model: 'm', usage: {}, answers: { stop: { noul: 0.95 } } }) } });
  assert.equal(stop.action, 'stop');

  const failed = await decide(ctx, { client: { systemOne: async () => { throw new Error('boom'); } } });
  assert.equal(failed.engine, 'rules');
  assert.equal(failed.ctaId, 22); // engaged prospect (3 opens) → more direct CTA
  assert.equal(failed.detail.jev_error, 'boom');
});
