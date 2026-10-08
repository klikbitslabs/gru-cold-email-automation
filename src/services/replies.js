// Replies that deserve an answer. When a prospect answers (interested, question, referral) the
// platform prepares a suggested reply; the user edits and sends it from Tareas, in the same thread.

import { nowIso } from '../db.js';
import { buildMime, formatAddress, toBase64Url } from '../lib/mime.js';
import { buildEmailBody } from '../lib/template.js';
import { draftReply } from './openai.js';
import { openaiConfigured } from './settings.js';

export const ACTIONABLE = ['interested', 'question', 'referral'];

/** Simple suggested reply used when OpenAI is not configured (or as a first draft). */
export function templateReply({ prospect, category, meetingLink }) {
  const name = prospect.first_name || '';
  const ask = meetingLink
    ? `¿Te queda bien agendar 20 minutos aquí? ${meetingLink}`
    : '¿Te queda bien una llamada de 20 minutos el [día] a las [hora], o el [día] a las [hora]?';
  if (category === 'referral') {
    return `Hola ${name},\n\nGracias por la referencia, te lo agradezco mucho.\n\n¿Me podrías compartir su correo o ponernos en copia? Le escribo mencionando que viene de tu parte.`;
  }
  if (category === 'question') {
    return `Hola ${name},\n\nGracias por la pregunta. [Responde aquí en 1–2 líneas.]\n\nSi te sirve, lo vemos con tus datos en una llamada corta. ${ask}`;
  }
  return `Hola ${name},\n\nGracias por responder, me alegra que te interese.\n\n${ask}`;
}

/** Stores an actionable reply with a template draft. Returns the row (or null if not actionable / already stored). */
export function recordReply(db, { prospect, campaign, sender, msg, category, at = new Date() }) {
  if (!ACTIONABLE.includes(category)) return null;
  if (msg.id && db.prepare('SELECT 1 FROM replies WHERE gmail_message_id = ?').get(msg.id)) return null;
  const brand = campaign.brand_id ? db.prepare('SELECT meeting_link FROM brands WHERE id = ?').get(campaign.brand_id) : null;
  const id = Number(db.prepare(
    `INSERT INTO replies (prospect_id, campaign_id, sender_id, gmail_message_id, gmail_thread_id, from_header, snippet, category, draft_subject, draft_body, received_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '', ?, ?)`,
  ).run(prospect.id, campaign.id, sender?.id ?? null, msg.id || null, msg.threadId || prospect.thread_id || null, msg.from || '', String(msg.snippet || '').slice(0, 2000), category,
    templateReply({ prospect, category, meetingLink: brand?.meeting_link }), nowIso(at)).lastInsertRowid);
  return db.prepare('SELECT * FROM replies WHERE id = ?').get(id);
}

function replyContext(db, reply) {
  const prospect = db.prepare('SELECT * FROM prospects WHERE id = ?').get(reply.prospect_id);
  const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(reply.campaign_id);
  const brand = campaign.brand_id ? db.prepare('SELECT * FROM brands WHERE id = ?').get(campaign.brand_id) : null;
  const persona = prospect.persona_id ? db.prepare('SELECT * FROM personas WHERE id = ?').get(prospect.persona_id) : null;
  const sender = reply.sender_id ? db.prepare('SELECT * FROM senders WHERE id = ?').get(reply.sender_id) : null;
  const last = db.prepare('SELECT body_text FROM messages WHERE prospect_id = ? ORDER BY step_number DESC LIMIT 1').get(prospect.id);
  return { prospect, campaign, brand, persona, sender, lastEmail: last?.body_text || '' };
}

/** Rewrites the template drafts with AI (job "reply_drafts"); returns how many were improved. */
export async function improveReplyDrafts(db, { draftFn = draftReply, limit = 5, log = console } = {}) {
  if (draftFn === draftReply && !openaiConfigured()) return 0;
  const pending = db.prepare("SELECT * FROM replies WHERE status = 'open' AND draft_engine = 'template' ORDER BY id LIMIT ?").all(limit);
  let n = 0;
  for (const r of pending) {
    try {
      const ctx = replyContext(db, r);
      const out = await draftFn({ ...ctx, category: r.category, replyText: r.snippet, meetingLink: ctx.brand?.meeting_link || '' });
      db.prepare("UPDATE replies SET draft_subject = ?, draft_body = ?, draft_engine = 'ai' WHERE id = ? AND status = 'open'").run(out.subject || '', out.body, r.id);
      n += 1;
    } catch (err) {
      // Keep the template draft; mark it so the job doesn't retry forever.
      db.prepare("UPDATE replies SET draft_engine = 'template_only' WHERE id = ?").run(r.id);
      log.warn?.(`[replies] draft failed for reply ${r.id}: ${err.message}`);
    }
  }
  return n;
}

/** Sends the (edited) answer in the prospect's thread from the mailbox that received the reply. */
export async function sendReply(db, reply, { body, gmailFor, now = () => new Date() }) {
  if (reply.status !== 'open') throw Object.assign(new Error('Esta respuesta ya fue atendida.'), { status: 400 });
  const { prospect, sender } = replyContext(db, reply);
  if (!sender || sender.status === 'error') throw Object.assign(new Error('El sender de este hilo no está disponible: reconéctalo en Senders.'), { status: 400 });
  const gmail = gmailFor(sender);
  let inReplyTo = prospect.last_message_id_header;
  if (reply.gmail_message_id) {
    try {
      inReplyTo = (await gmail.getMessageIdHeader(reply.gmail_message_id)) || inReplyTo;
    } catch { /* keep the last known header */ }
  }
  const base = prospect.first_subject || '';
  const subject = reply.draft_subject?.trim() || (/^re:/i.test(base) ? base : `Re: ${base}`);
  const { text, html } = buildEmailBody({ body, signatureHtml: sender.signature_html });
  const mime = buildMime({
    from: formatAddress(sender.display_name, sender.email),
    to: formatAddress([prospect.first_name, prospect.last_name].filter(Boolean).join(' '), prospect.email),
    subject,
    text,
    html,
    inReplyTo,
    references: inReplyTo,
  });
  const sent = await gmail.send({ raw: toBase64Url(mime), threadId: reply.gmail_thread_id || prospect.thread_id || null });
  const at = nowIso(now());
  db.transaction(() => {
    db.prepare("UPDATE replies SET status = 'sent', draft_body = ?, handled_at = ? WHERE id = ?").run(body, at, reply.id);
    db.prepare('INSERT INTO decisions (prospect_id, step_number, engine, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(prospect.id, prospect.current_step, 'user', 'reply_sent', JSON.stringify({ gmail_message_id: sent.id, body: body.slice(0, 500) }), at);
  })();
  return { ok: true, gmail_message_id: sent.id };
}
