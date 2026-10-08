import { test } from 'node:test';
import assert from 'node:assert/strict';
import './helpers.js';
import ExcelJS from 'exceljs';
import { parseProspectsCsv, parseProspectsFile } from '../src/lib/csv.js';
import { checkBody, checkDraft, checkSubject, lintTemplate } from '../src/lib/quality.js';
import { validateLead } from '../src/lib/validate.js';
import { buildMime, encodeHeader } from '../src/lib/mime.js';
import { buildEmailBody, renderTemplate, sanitizeSignature } from '../src/lib/template.js';
import { inSendWindow, localParts, nextLocalSlot } from '../src/lib/time.js';
import { analyzeProspect, decide, ruleAnalysis, ruleClassifyReply, slotRanges } from '../src/services/jev.js';

test('CSV import maps Spanish headers, semicolons and keeps custom fields', () => {
  const csv = 'Nombre;Apellido;Correo;Empresa;Cargo;Ciudad\nAna;Pérez;ANA@EJEMPLO.COM;Ejemplo SA;CEO;Panamá\nMal;Dato;no-es-email;X;Y;Z\n';
  const out = parseProspectsCsv(Buffer.from(csv));
  assert.equal(out.prospects.length, 1);
  assert.deepEqual(out.prospects[0], {
    email: 'ana@ejemplo.com', first_name: 'Ana', last_name: 'Pérez', company: 'Ejemplo SA', title: 'CEO', fields: { ciudad: 'Panamá' },
    industry: '', country: '', phone: '', linkedin_url: '', source: '', lawful_basis: '',
  });
  assert.equal(out.invalid.length, 1);
  assert.equal(out.invalid[0].row, 3);
});

test('Excel (.xlsx) import maps the first sheet, including industry, phone and LinkedIn', async () => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Contactos');
  ws.addRow(['Nombre', 'Correo electrónico', 'Empresa', 'Sector', 'Teléfono', 'LinkedIn', 'Noticia reciente']);
  ws.addRow(['Ana', 'ana@ejemplo.com', 'Ejemplo SA', 'Retail', '+507 6000-0000', 'https://linkedin.com/in/ana', 'abrió 3 tiendas']);
  ws.addRow([]);
  const out = await parseProspectsFile(Buffer.from(await wb.xlsx.writeBuffer()), { filename: 'base.xlsx' });
  assert.equal(out.prospects.length, 1);
  assert.equal(out.mapping.email, 'correo_electronico');
  assert.deepEqual(
    [out.prospects[0].industry, out.prospects[0].phone, out.prospects[0].linkedin_url, out.prospects[0].fields.noticia_reciente],
    ['Retail', '+507 6000-0000', 'https://linkedin.com/in/ana', 'abrió 3 tiendas'],
  );
  await assert.rejects(parseProspectsFile(Buffer.from('x'), { filename: 'viejo.xls' }), /\.xls antiguo/);
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

const codes = (issues) => issues.map((i) => i.code);

test('subject rules: 3–7 words, no caps blocks, no exclamations, no emojis, no fake Re:', () => {
  assert.deepEqual(checkSubject('idea para el equipo comercial'), []);
  assert.deepEqual(codes(checkSubject('hola')), ['subject_length']);
  assert.ok(codes(checkSubject('OFERTA para tu empresa hoy')).includes('subject_caps'));
  assert.deepEqual(codes(checkSubject('reunión con el CEO de ventas')), []); // acronyms are fine
  assert.ok(codes(checkSubject('pregunta rápida sobre ventas!!')).includes('subject_exclamation'));
  assert.ok(codes(checkSubject('pregunta rápida sobre ventas??')).includes('subject_punctuation'));
  assert.deepEqual(checkSubject('pregunta sobre su equipo 🚀').find((i) => i.code === 'subject_emoji').severity, 'error');
  assert.equal(checkSubject('Re: propuesta para su equipo').find((i) => i.code === 'fake_reply').severity, 'error');
  assert.deepEqual(checkSubject('Re: propuesta para su equipo', { threadReply: true }), []);
  assert.ok(codes(checkSubject('oferta exclusiva para tu equipo')).includes('subject_hype'));
});

test('body rules: 45–85 words, warning from 110, 3 paragraphs, one CTA, no links in first email', () => {
  const para = (n) => Array.from({ length: n }, (_, i) => `palabra${i}`).join(' ');
  const good = `Hola Ana,\n\n${para(20)}.\n\n${para(20)}.\n\n¿Tiene sentido conversarlo?`;
  assert.deepEqual(codes(checkBody(good, { personalized: true })), []);
  assert.ok(codes(checkBody(`${para(60)}\n\n${para(50)}\n\n¿Te interesa?`, { personalized: true })).includes('too_long'));
  assert.deepEqual(codes(checkBody(`${para(50)}\n\n${para(40)}\n\n¿Te interesa?`, { personalized: true })), ['above_target']);
  assert.ok(codes(checkBody(`${para(30)} ${para(20)} ¿Te interesa?`, { personalized: true })).includes('structure'));
  assert.ok(codes(checkBody(`${para(20)}\n\n${para(20)}\n\n¿Te interesa? ¿Hablamos el jueves?`, { personalized: true })).includes('many_ctas'));
  const link = checkBody(`${para(20)}\n\nmira https://x.com\n\n¿Te interesa?`, { personalized: true }).find((i) => i.code === 'links_first_email');
  assert.equal(link.severity, 'error');
  assert.equal(checkBody(`${para(20)}\n\nmira https://x.com\n\n¿Te interesa?`, { stepNumber: 2, personalized: true }).some((i) => i.code === 'links_first_email'), false);
  assert.ok(codes(checkBody(good, { personalized: false })).includes('personalization'));
});

test('template lint recognises {{gancho}} as personalization and {{cta}} as the call to action', () => {
  const { issues } = lintTemplate({ subject: 'idea para {{company}}', body: 'Hola {{first_name}},\n\n{{gancho}}\n\n{{problema}}\n\n{{cta}}' });
  assert.deepEqual(codes(issues), []);
  assert.ok(codes(lintTemplate({ subject: 'idea para {{company}}', body: 'Hola {{first_name}}, trabajamos con {{company}}. {{cta}}' }).issues).includes('personalization'));
});

test('draft check blocks missing data, missing signature and invalid leads; warns on risky leads', () => {
  const base = { subject: 'idea para su equipo comercial', body: 'x', stepNumber: 2, personalized: true, sender: { display_name: 'Laura', signature_html: '<p>Laura</p>' } };
  assert.equal(checkDraft({ ...base, missing: ['ciudad'] }).passed, false);
  assert.equal(checkDraft({ ...base, sender: { display_name: '', signature_html: '' } }).passed, false);
  assert.equal(checkDraft({ ...base, prospect: { validation_status: 'invalid', validation_notes: 'sin MX' } }).passed, false);
  const risky = checkDraft({ ...base, prospect: { validation_status: 'risky', validation_notes: 'cuenta genérica' } });
  assert.equal(risky.passed, true);
  assert.ok(risky.issues.some((i) => i.code === 'risky_lead'));
});

test('lead validation: MX, disposable, role and personal addresses', async () => {
  const mx = async (domain) => (domain === 'muerto.com' ? 'none' : 'ok');
  assert.deepEqual(await validateLead({ email: 'ana@empresa.com', first_name: 'Ana', company: 'Empresa' }, { mx }), { status: 'valid', notes: [] });
  assert.equal((await validateLead({ email: 'ana@muerto.com', first_name: 'Ana', company: 'X' }, { mx })).status, 'invalid');
  assert.equal((await validateLead({ email: 'a@mailinator.com', first_name: 'A', company: 'X' }, { mx })).status, 'invalid');
  assert.equal((await validateLead({ email: 'info@empresa.com', first_name: 'A', company: 'X' }, { mx })).status, 'risky');
  assert.equal((await validateLead({ email: 'ana.perez@gmail.com', first_name: 'Ana' }, { mx })).status, 'risky');
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
          send_slot: { type: 'choice', choice: 'late', confidence: 0.8, probabilities: {} },
          variant: { type: 'choice', choice: 'v12', confidence: 0.7, probabilities: { v11: 0.3, v12: 0.7 } },
          cta: { type: 'choice', choice: 'c22', confidence: 0.9, probabilities: {} },
        },
      };
    },
  };
  const d = await decide(ctx, { client });
  assert.equal(d.engine, 'jev');
  assert.deepEqual([d.action, d.variantId, d.ctaId, d.slot], ['send', 12, 22, 'late']);
  assert.deepEqual(Object.keys(sent.questions).sort(), ['cta', 'send_slot', 'variant']);
  assert.equal(sent.questions.variant.type, 'choice');
  assert.ok(sent.state.candidate_messages.v11);


  const failed = await decide(ctx, { client: { systemOne: async () => { throw new Error('boom'); } } });
  assert.equal(failed.engine, 'rules');
  assert.equal(failed.ctaId, 22); // engaged prospect (3 opens) → more direct CTA
  assert.equal(failed.detail.jev_error, 'boom');
});
