// Commercial orchestrator. Every tick:
//   1. checkReplies   — replies, bounces and auto-replies on active threads (Gmail).
//   2. analyzeLeads   — commercial intelligence for new leads (segment, ICP fit, exclusion).
//   3. per active campaign, for each due prospect:
//        email step  → draft (decision + generation + quality control) → approval queue or
//                      auto-approve → send inside the window with per-sender limits/pacing.
//        call/LinkedIn step → task for a person; the sequence continues when it is completed.

import { config } from '../config.js';
import { nowIso } from '../db.js';
import { decrypt, randomToken } from '../lib/crypto.js';
import { buildMime, formatAddress, toBase64Url } from '../lib/mime.js';
import { checkDraft } from '../lib/quality.js';
import { allFieldsPresent, buildEmailBody, prospectVariables, renderTemplate, templateFields } from '../lib/template.js';
import { addDays, inSendWindow, localParts, nextLocalSlot } from '../lib/time.js';
import { extractEmail, gmailForRefreshToken } from './google.js';
import { analyzeProspect, classifyReply, decide, slotForMinute, slotRanges } from './jev.js';

const DAY_MS = 86400000;
// Only credential problems disable a sender; 403/429 rate limits are retried on the next tick.
const AUTH_ERROR_RE = /invalid_grant|invalid credentials|insufficient (permission|authentication scopes)|unauthorized_client|\b401\b/i;
const OUTCOME_RANK = { interested: 1, meeting: 2, opportunity: 3, won: 4, lost: 0 };
const TRIVIAL_FIELDS = new Set(['first_name', 'last_name', 'full_name', 'email', 'company', 'sender_name', 'sender_first_name', 'sender_email', 'cta', 'problema', 'gancho']);

export function trackingPixelUrl(token) {
  return `${config.baseUrl}/t/o/${token}.gif`;
}
export function unsubscribeUrl(token) {
  return `${config.baseUrl}/u/${token}`;
}

/** Loads a campaign's steps (ordered) with their variants. */
export function loadSequence(db, campaignId) {
  const steps = db.prepare('SELECT * FROM steps WHERE campaign_id = ? ORDER BY step_number').all(campaignId);
  const variantsStmt = db.prepare('SELECT * FROM variants WHERE step_id = ? ORDER BY id');
  return steps.map((s) => ({ ...s, channel: s.channel || 'email', variants: variantsStmt.all(s.id) }));
}

/** Items meant for this prospect's segment: segment-specific ones when they exist, else generic ones. */
export function forSegment(items, segmentId) {
  const specific = items.filter((i) => segmentId && i.segment_id === segmentId);
  if (specific.length) return specific;
  const generic = items.filter((i) => !i.segment_id);
  return generic.length ? generic : items;
}

/** Engagement facts for a prospect, consumed by the decision engine. */
export function engagementFor(db, prospect, campaign, now) {
  const messages = db.prepare('SELECT * FROM messages WHERE prospect_id = ? ORDER BY step_number').all(prospect.id);
  const opens = db
    .prepare(
      `SELECT oe.opened_at FROM open_events oe JOIN messages m ON m.id = oe.message_id
       WHERE m.prospect_id = ? AND oe.suspected_bot = 0 ORDER BY oe.opened_at`,
    )
    .all(prospect.id);
  const tasks = db.prepare("SELECT channel, outcome FROM tasks WHERE prospect_id = ? AND status != 'open'").all(prospect.id);
  const ranges = slotRanges(campaign.window_start, campaign.window_end);
  const daysAgo = (iso) => (iso ? Number(((now - new Date(iso)) / DAY_MS).toFixed(1)) : null);
  const last = messages[messages.length - 1];
  return {
    emails_sent: messages.length,
    days_since_last_email: last ? daysAgo(last.sent_at) : null,
    opened_last_email: last ? last.open_count > 0 : false,
    human_opens_total: opens.length,
    last_open_days_ago: opens.length ? daysAgo(opens[opens.length - 1].opened_at) : null,
    previous_emails: messages.map((m) => ({ step: m.step_number, opens: m.open_count, last_opened_days_ago: daysAgo(m.last_opened_at) })),
    previous_open_slots: opens
      .map((o) => slotForMinute(ranges, localParts(new Date(o.opened_at), campaign.timezone).minuteOfDay))
      .filter(Boolean),
    other_touches: tasks.map((t) => ({ channel: t.channel, outcome: t.outcome })),
  };
}

/** Results per variant and per CTA in a campaign — the learning signal fed back to Jev. */
export function performanceStats(db, campaignId) {
  const rows = (column) =>
    db.prepare(
      `SELECT m.${column} AS id, COUNT(*) AS sent,
         SUM(CASE WHEN p.status = 'replied' AND p.reply_category != 'bounce'
                   AND m.step_number = (SELECT MAX(step_number) FROM messages m2 WHERE m2.prospect_id = p.id) THEN 1 ELSE 0 END) AS replied,
         SUM(CASE WHEN (p.reply_category IN ('interested','referral') OR p.outcome IN ('interested','meeting','opportunity','won'))
                   AND m.step_number = (SELECT MAX(step_number) FROM messages m2 WHERE m2.prospect_id = p.id) THEN 1 ELSE 0 END) AS positive
       FROM messages m JOIN prospects p ON p.id = m.prospect_id
       WHERE m.campaign_id = ? AND m.${column} IS NOT NULL GROUP BY m.${column}`,
    ).all(campaignId);
  const toMap = (list) => new Map(list.map((r) => [r.id, r]));
  return { variants: toMap(rows('variant_id')), ctas: toMap(rows('cta_id')) };
}

function senderVars(sender) {
  const name = sender?.display_name || '';
  return { sender_name: name, sender_first_name: name.split(' ')[0] || '', sender_email: sender?.email || '' };
}

/** Renders the hook/problem/CTA snippets and the variant for a prospect. */
export function renderDraft({ prospect, sender, variant, cta, hook, problem, step, threadSubject, fallbackSubject }) {
  const baseVars = prospectVariables(prospect, senderVars(sender));
  const parts = {};
  const missing = [];
  for (const [key, snippet] of [['gancho', hook], ['problema', problem], ['cta', cta]]) {
    const r = snippet ? renderTemplate(snippet.text, baseVars) : { text: '', missing: [] };
    parts[key] = r.text;
    missing.push(...r.missing);
  }
  const vars = { ...baseVars, ...parts };
  const body = renderTemplate(variant.body, vars);
  const usedFields = templateFields(variant.body);
  const reasons = { gancho: 'gancho (ningún gancho tiene todos sus datos para este prospecto)', problema: 'problema (no hay hipótesis para su segmento)', cta: 'cta (no hay CTAs)' };
  for (const key of ['gancho', 'problema', 'cta']) {
    if (usedFields.includes(key) && !parts[key]) missing.push(reasons[key]);
  }
  const sameThread = step.step_number > 1 && Boolean(step.same_thread) && Boolean(threadSubject);
  let subject;
  if (sameThread) subject = { text: /^re:/i.test(threadSubject) ? threadSubject : `Re: ${threadSubject}`, missing: [] };
  else if (variant.subject?.trim()) subject = renderTemplate(variant.subject, vars);
  // Follow-up without its own subject that cannot be threaded: reuse the original subject.
  else subject = { text: fallbackSubject || '', missing: [] };

  const personalFields = usedFields.filter((f) => !TRIVIAL_FIELDS.has(f) && vars[f]);
  return {
    subject: subject.text,
    body: body.text,
    missing: [...new Set([...body.missing, ...subject.missing, ...missing])],
    sameThread,
    personalized: Boolean((hook && usedFields.includes('gancho')) || personalFields.length),
  };
}

/** Candidate copy for a prospect at a step: variants, hooks (only verifiable ones), problems, CTAs. */
export function candidatesFor(db, { campaign, prospect, step, sender }) {
  const vars = prospectVariables(prospect, senderVars(sender));
  const snippets = db.prepare('SELECT * FROM snippets WHERE campaign_id = ? ORDER BY id').all(campaign.id);
  const segmentItems = (list) => list.filter((i) => !i.segment_id || i.segment_id === prospect.segment_id);
  const hooks = segmentItems(snippets.filter((s) => s.kind === 'hook')).filter((h) => allFieldsPresent(h.text, vars));
  const problems = segmentItems(snippets.filter((s) => s.kind === 'problem'));
  const preview = (s) => ({ ...s, preview: renderTemplate(s.text, vars).text });
  return {
    variants: forSegment(step.variants, prospect.segment_id),
    hooks: hooks.map(preview),
    problems: problems.map(preview),
    ctas: db.prepare('SELECT * FROM ctas WHERE campaign_id = ? ORDER BY id').all(campaign.id),
  };
}

export function needsApproval(mode, stepNumber, quality) {
  if (!quality.passed) return true; // errors always need a person
  if (mode === 'all') return true;
  if (mode === 'first' && stepNumber === 1) return true;
  return mode !== 'none' && quality.warnings > 0;
}

/** Schedules the step after `stepNumber` (any channel) or finishes the sequence. */
export function advanceProspect(db, prospect, sequence, stepNumber, at) {
  const next = sequence.find((s) => s.step_number === stepNumber + 1);
  const fields = next
    ? { current_step: stepNumber, status: 'active', next_send_at: nowIso(addDays(at, Math.max(1, next.delay_days))), postponed_step: null }
    : { current_step: stepNumber, status: 'finished', next_send_at: null, postponed_step: null };
  db.prepare(
    'UPDATE prospects SET current_step = @current_step, status = @status, next_send_at = @next_send_at, postponed_step = @postponed_step WHERE id = @id',
  ).run({ ...fields, id: prospect.id });
}

/** Records a commercial outcome; positive outcomes stop the sequence. Never downgrades. */
export function setOutcome(db, prospect, outcome, at = new Date()) {
  const current = OUTCOME_RANK[prospect.outcome] ?? -1;
  if (outcome !== 'lost' && prospect.outcome && current >= OUTCOME_RANK[outcome]) return;
  db.prepare(
    `UPDATE prospects SET outcome = ?, outcome_at = ?,
       status = CASE WHEN status IN ('active','finished','stopped') THEN 'replied' ELSE status END,
       next_send_at = NULL,
       stop_reason = COALESCE(stop_reason, ?)
     WHERE id = ?`,
  ).run(outcome, nowIso(at), `Resultado: ${outcome}`, prospect.id);
}

export function createScheduler({
  db,
  gmailFor = (sender) => gmailForRefreshToken(decrypt(sender.refresh_token_enc)),
  decideFn = decide,
  analyzeFn = analyzeProspect,
  classifyFn = classifyReply,
  now = () => new Date(),
  log = console,
  random = Math.random,
}) {
  const stmts = {
    activeCampaigns: db.prepare("SELECT * FROM campaigns WHERE status = 'active'"),
    campaignSenders: db.prepare(
      `SELECT s.* FROM senders s JOIN campaign_senders cs ON cs.sender_id = s.id
       WHERE cs.campaign_id = ? AND s.status = 'active' ORDER BY s.id`,
    ),
    due: db.prepare(
      `SELECT * FROM prospects WHERE campaign_id = ? AND status = 'active' AND intel_at IS NOT NULL
         AND next_send_at IS NOT NULL AND next_send_at <= ?
       ORDER BY current_step DESC, fit_score IS NULL, fit_score DESC, next_send_at ASC LIMIT 200`,
    ),
    sentLast24h: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND sent_at > ?'),
    suppressed: db.prepare('SELECT 1 FROM suppressions WHERE user_id = ? AND email = ?'),
    sender: db.prepare('SELECT * FROM senders WHERE id = ?'),
    lastMessage: db.prepare('SELECT * FROM messages WHERE prospect_id = ? ORDER BY step_number DESC LIMIT 1'),
    openDraft: db.prepare("SELECT * FROM drafts WHERE prospect_id = ? AND step_number = ? AND status IN ('pending','approved') ORDER BY id DESC LIMIT 1"),
    logDecision: db.prepare(
      'INSERT INTO decisions (prospect_id, step_number, engine, action, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)',
    ),
  };

  const setProspect = (id, fields) => {
    const keys = Object.keys(fields);
    db.prepare(`UPDATE prospects SET ${keys.map((k) => `${k} = @${k}`).join(', ')} WHERE id = @id`).run({ ...fields, id });
  };

  function senderCapacity(sender, at) {
    const since = new Date(at.getTime() - DAY_MS).toISOString();
    return sender.daily_limit - stmts.sentLast24h.get(sender.id, since).n;
  }

  function senderReady(sender, at) {
    if (!sender.last_sent_at) return true;
    // Randomised gap (1x–1.5x) between sends so traffic looks human.
    const gap = sender.min_delay_seconds * 1000 * (1 + 0.5 * random());
    return at - new Date(sender.last_sent_at) >= gap;
  }

  function markSenderError(sender, err) {
    const message = String(err?.message || err).slice(0, 500);
    if (AUTH_ERROR_RE.test(message)) {
      db.prepare("UPDATE senders SET status = 'error', last_error = ? WHERE id = ?").run(message, sender.id);
    } else {
      db.prepare('UPDATE senders SET last_error = ? WHERE id = ?').run(message, sender.id);
    }
  }

  // -------------------------------------------------------------------------
  // 1. Replies / bounces
  // -------------------------------------------------------------------------
  async function scanReplies(prospect, campaign, sender) {
    const gmail = gmailFor(sender);
    const seen = new Set(JSON.parse(prospect.seen_message_ids_json || '[]'));
    const ours = new Set(db.prepare('SELECT gmail_message_id FROM messages WHERE prospect_id = ?').all(prospect.id).map((m) => m.gmail_message_id));
    const inbound = [];
    if (prospect.thread_id) inbound.push(...(await gmail.getThread(prospect.thread_id)));
    const firstSent = db.prepare('SELECT MIN(sent_at) AS t FROM messages WHERE prospect_id = ?').get(prospect.id).t;
    if (firstSent && gmail.searchMessages) {
      const after = Math.floor(new Date(firstSent).getTime() / 1000);
      inbound.push(...(await gmail.searchMessages(`from:${prospect.email} after:${after}`)));
    }
    let outcome = null;
    for (const msg of inbound) {
      if (seen.has(msg.id) || ours.has(msg.id)) continue;
      seen.add(msg.id);
      const fromEmail = extractEmail(msg.from);
      if (fromEmail === sender.email.toLowerCase() || (msg.labelIds || []).includes('SENT')) continue;
      const result = await classifyFn({ from: msg.from, snippet: msg.snippet, campaign });
      stmts.logDecision.run(prospect.id, prospect.current_step, result.engine, `reply:${result.category}`, JSON.stringify({ from: msg.from, snippet: msg.snippet.slice(0, 300), confidence: result.confidence }), nowIso(now()));
      if (result.category === 'auto_reply') continue;
      outcome = result.category;
      if (outcome !== 'bounce') break;
    }
    const update = { seen_message_ids_json: JSON.stringify([...seen].slice(-200)), last_reply_check_at: nowIso(now()) };
    if (outcome === 'bounce') {
      Object.assign(update, { status: 'bounced', stop_reason: 'Rebote (bounce)', next_send_at: null, reply_category: 'bounce' });
    } else if (outcome) {
      Object.assign(update, { status: 'replied', stop_reason: 'Respondió', next_send_at: null, reply_category: outcome, replied_at: nowIso(now()) });
      if (outcome === 'not_interested') {
        db.prepare('INSERT OR IGNORE INTO suppressions (user_id, email, reason) VALUES (?, ?, ?)').run(campaign.user_id, prospect.email, 'not_interested');
      }
    }
    setProspect(prospect.id, update);
    if (outcome === 'interested') setOutcome(db, { ...prospect, ...update }, 'interested', now());
    if (outcome && outcome !== 'bounce') {
      // A reply makes any pending draft or task for this prospect obsolete.
      db.prepare("UPDATE drafts SET status = 'rejected', reviewed_at = ? WHERE prospect_id = ? AND status IN ('pending','approved')").run(nowIso(now()), prospect.id);
      db.prepare("UPDATE tasks SET status = 'skipped', note = 'El prospecto respondió', completed_at = ? WHERE prospect_id = ? AND status = 'open'").run(nowIso(now()), prospect.id);
    }
    return outcome;
  }

  async function checkReplies() {
    const at = now();
    const cutoff = new Date(at.getTime() - config.scheduler.replyCheckMinutes * 60000).toISOString();
    const recent = new Date(at.getTime() - 30 * DAY_MS).toISOString();
    const rows = db
      .prepare(
        `SELECT p.* FROM prospects p
         WHERE p.status IN ('active','finished') AND p.thread_id IS NOT NULL AND p.sender_id IS NOT NULL
           AND (p.last_reply_check_at IS NULL OR p.last_reply_check_at < ?)
           AND EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.sent_at > ?)
         ORDER BY p.last_reply_check_at IS NOT NULL, p.last_reply_check_at LIMIT 25`,
      )
      .all(cutoff, recent);
    for (const prospect of rows) {
      const campaign = db.prepare('SELECT * FROM campaigns WHERE id = ?').get(prospect.campaign_id);
      const sender = stmts.sender.get(prospect.sender_id);
      if (!sender || sender.status === 'error') continue;
      try {
        await scanReplies(prospect, campaign, sender);
      } catch (err) {
        markSenderError(sender, err);
        log.warn?.(`[scheduler] reply check failed for prospect ${prospect.id}: ${err.message}`);
      }
    }
  }

  // -------------------------------------------------------------------------
  // 2. Commercial intelligence
  // -------------------------------------------------------------------------
  async function analyzeOne(prospect, campaign) {
    const segments = db.prepare('SELECT * FROM segments WHERE campaign_id = ? ORDER BY id').all(campaign.id);
    const result = await analyzeFn({ campaign, prospect, segments });
    const at = nowIso(now());
    stmts.logDecision.run(prospect.id, 0, result.engine, result.exclude ? 'exclude' : 'analyze', JSON.stringify(result), at);
    const update = {
      segment_id: result.segmentId ?? null,
      fit_score: result.fitScore ?? prospect.fit_score,
      intel_json: JSON.stringify(result),
      intel_at: at,
    };
    if (result.exclude) Object.assign(update, { status: 'stopped', next_send_at: null, stop_reason: 'Excluido por inteligencia comercial (no encaja con la oferta)' });
    setProspect(prospect.id, update);
    return { ...prospect, ...update };
  }

  async function analyzeLeads(limit = 25) {
    const rows = db.prepare(
      `SELECT p.* FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
       WHERE p.intel_at IS NULL AND p.status = 'active' AND c.status != 'completed' ORDER BY p.id LIMIT ?`,
    ).all(limit);
    const campaigns = new Map();
    for (const prospect of rows) {
      if (!campaigns.has(prospect.campaign_id)) campaigns.set(prospect.campaign_id, db.prepare('SELECT * FROM campaigns WHERE id = ?').get(prospect.campaign_id));
      await analyzeOne(prospect, campaigns.get(prospect.campaign_id));
    }
    return rows.length;
  }

  // -------------------------------------------------------------------------
  // 3a. Drafting (generation + quality control + approval routing)
  // -------------------------------------------------------------------------
  async function createDraft({ campaign, prospect, step, sender, totalSteps, stats }) {
    const at = now();
    const candidates = candidatesFor(db, { campaign, prospect, step, sender });
    const withStats = (list, map) => list.map((x) => ({ ...x, stats: map.get(x.id) || { sent: 0, replied: 0, positive: 0 } }));
    const canThread = Boolean(prospect.thread_id && prospect.sender_id === sender.id);
    const threadSubject = canThread ? prospect.first_subject : null;
    const segment = prospect.segment_id ? db.prepare('SELECT * FROM segments WHERE id = ?').get(prospect.segment_id) : null;

    const decision = await decideFn({
      campaign,
      prospect,
      segment,
      stepNumber: step.step_number,
      totalSteps,
      engagement: engagementFor(db, prospect, campaign, at),
      variants: withStats(candidates.variants, stats.variants).map((v) => ({
        ...v,
        preview: renderDraft({ prospect, sender, variant: v, step, threadSubject, fallbackSubject: prospect.first_subject }).body,
      })),
      ctas: withStats(candidates.ctas, stats.ctas),
      hooks: candidates.hooks,
      problems: candidates.problems,
    });
    stmts.logDecision.run(prospect.id, step.step_number, decision.engine, 'draft', JSON.stringify(decision), nowIso(at));

    const pick = (list, id) => list.find((x) => x.id === id) || null;
    const variant = pick(candidates.variants, decision.variantId) || candidates.variants[0];
    const hook = pick(candidates.hooks, decision.hookId) || candidates.hooks[0] || null;
    const problem = pick(candidates.problems, decision.problemId) || candidates.problems[0] || null;
    const cta = pick(candidates.ctas, decision.ctaId) || null;
    const rendered = renderDraft({ prospect, sender, variant, cta, hook, problem, step, threadSubject, fallbackSubject: prospect.first_subject });
    const quality = checkDraft({
      subject: rendered.subject,
      body: rendered.body,
      stepNumber: step.step_number,
      threadReply: rendered.sameThread,
      personalized: rendered.personalized,
      missing: rendered.missing,
      sender,
      prospect,
    });
    quality.personalized = rendered.personalized;
    const status = needsApproval(campaign.approval_mode || 'first', step.step_number, quality) ? 'pending' : 'approved';
    const id = Number(db.prepare(
      `INSERT INTO drafts (prospect_id, campaign_id, step_number, sender_id, variant_id, cta_id, hook_id, problem_id, subject, body,
         same_thread, quality_json, decision_json, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(prospect.id, campaign.id, step.step_number, sender.id, variant.id, cta?.id ?? null, hook?.id ?? null, problem?.id ?? null,
      rendered.subject, rendered.body, rendered.sameThread ? 1 : 0, JSON.stringify(quality), JSON.stringify(decision), status, nowIso(at)).lastInsertRowid);
    if (status === 'pending') setProspect(prospect.id, { next_send_at: null }); // waits for approval
    return db.prepare('SELECT * FROM drafts WHERE id = ?').get(id);
  }

  // -------------------------------------------------------------------------
  // 3b. Sending an approved draft
  // -------------------------------------------------------------------------
  async function sendDraft({ campaign, prospect, step, sender, draft, sequence }) {
    const at = now();
    const token = randomToken();
    const threadReply = Boolean(draft.same_thread && prospect.thread_id && prospect.sender_id === sender.id);
    const previous = threadReply ? stmts.lastMessage.get(prospect.id) : null;
    const quoted = previous
      ? {
          header: `El ${new Date(previous.sent_at).toLocaleString('es', { timeZone: campaign.timezone, dateStyle: 'medium', timeStyle: 'short' })}, ${sender.display_name || sender.email} <${sender.email}> escribió:`,
          text: previous.body_text,
        }
      : null;
    const unsub = campaign.include_unsubscribe ? unsubscribeUrl(prospect.unsubscribe_token) : null;
    const subject = threadReply || !/^re:\s*/i.test(draft.subject) ? draft.subject : draft.subject.replace(/^re:\s*/i, '');
    const { text, html } = buildEmailBody({
      body: draft.body,
      signatureHtml: sender.signature_html,
      trackingPixelUrl: campaign.track_opens ? trackingPixelUrl(token) : null,
      unsubscribeUrl: unsub,
      quoted,
    });
    const mime = buildMime({
      from: formatAddress(sender.display_name, sender.email),
      to: formatAddress([prospect.first_name, prospect.last_name].filter(Boolean).join(' '), prospect.email),
      subject,
      text,
      html,
      inReplyTo: threadReply ? prospect.last_message_id_header : null,
      references: threadReply ? prospect.last_message_id_header : null,
      headers: unsub ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
    });

    const gmail = gmailFor(sender);
    const sent = await gmail.send({ raw: toBase64Url(mime), threadId: threadReply ? prospect.thread_id : null });
    let messageIdHeader = null;
    try {
      messageIdHeader = await gmail.getMessageIdHeader(sent.id);
    } catch {
      messageIdHeader = null;
    }

    db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (prospect_id, campaign_id, sender_id, step_number, variant_id, cta_id, subject, body_text,
           gmail_message_id, gmail_thread_id, message_id_header, tracking_token, decision_json, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(prospect.id, campaign.id, sender.id, step.step_number, draft.variant_id, draft.cta_id, subject, draft.body,
        sent.id, sent.threadId, messageIdHeader, token, draft.decision_json, nowIso(at));
      db.prepare("UPDATE drafts SET status = 'sent' WHERE id = ?").run(draft.id);
      setProspect(prospect.id, {
        sender_id: sender.id,
        thread_id: threadReply ? prospect.thread_id : sent.threadId,
        first_subject: threadReply ? prospect.first_subject : subject,
        last_message_id_header: messageIdHeader || prospect.last_message_id_header,
        last_error: null,
      });
      advanceProspect(db, prospect, sequence, step.step_number, at);
      db.prepare('UPDATE senders SET last_sent_at = ?, last_error = NULL WHERE id = ?').run(nowIso(at), sender.id);
    })();
    sender.last_sent_at = nowIso(at);
  }

  // -------------------------------------------------------------------------
  // 3c. Tasks for call / LinkedIn steps
  // -------------------------------------------------------------------------
  function createTask({ campaign, prospect, step, senders }) {
    const exists = db.prepare("SELECT 1 FROM tasks WHERE prospect_id = ? AND step_number = ? AND status = 'open'").get(prospect.id, step.step_number);
    if (!exists) {
      const variant = forSegment(step.variants, prospect.segment_id)[0];
      const sender = (prospect.sender_id && stmts.sender.get(prospect.sender_id)) || senders[0] || null;
      const vars = prospectVariables(prospect, senderVars(sender));
      const instructions = variant ? renderTemplate(variant.body, vars).text : '';
      db.prepare('INSERT INTO tasks (prospect_id, campaign_id, step_number, channel, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(prospect.id, campaign.id, step.step_number, step.channel, instructions, nowIso(now()));
    }
    setProspect(prospect.id, { next_send_at: null });
  }

  // -------------------------------------------------------------------------
  // 3. Per-campaign orchestration
  // -------------------------------------------------------------------------
  async function processCampaign(campaign, usedSenders) {
    const at = now();
    const senders = stmts.campaignSenders.all(campaign.id);
    const sequence = loadSequence(db, campaign.id).filter((s) => s.variants.length);
    if (!sequence.length) return 0;
    const sendingOpen = inSendWindow(campaign, at);
    const ranges = slotRanges(campaign.window_start, campaign.window_end);
    const currentSlot = slotForMinute(ranges, localParts(at, campaign.timezone).minuteOfDay);
    const stats = performanceStats(db, campaign.id);

    let sentCount = 0;
    for (const prospect of stmts.due.all(campaign.id, nowIso(at))) {
      const stepNumber = prospect.current_step + 1;
      const step = sequence.find((s) => s.step_number === stepNumber);
      if (!step) {
        setProspect(prospect.id, { status: 'finished', next_send_at: null });
        continue;
      }
      if (stmts.suppressed.get(campaign.user_id, prospect.email)) {
        setProspect(prospect.id, { status: 'unsubscribed', next_send_at: null, stop_reason: 'En lista de supresión' });
        continue;
      }
      if (step.channel !== 'email') {
        createTask({ campaign, prospect, step, senders });
        continue;
      }

      // Never follow up on someone who already replied.
      const threadOwner = prospect.sender_id ? stmts.sender.get(prospect.sender_id) : null;
      if (stepNumber > 1 && campaign.stop_on_reply && threadOwner && threadOwner.status !== 'error' && prospect.thread_id) {
        try {
          if (await scanReplies(prospect, campaign, threadOwner)) continue;
        } catch (err) {
          markSenderError(threadOwner, err);
          continue;
        }
      }

      let draft = stmts.openDraft.get(prospect.id, stepNumber);
      if (!draft) {
        // Sticky sender: follow-ups come from the mailbox that sent the first email.
        const sender = senders.find((s) => s.id === prospect.sender_id) ||
          [...senders].sort((a, b) => senderCapacity(b, at) - senderCapacity(a, at))[0];
        if (!sender) continue;
        draft = await createDraft({ campaign, prospect, step, sender, totalSteps: sequence.length, stats });
      }
      if (draft.status !== 'approved' || !sendingOpen) continue;

      const sender = senders.find((s) => s.id === draft.sender_id);
      if (!sender) {
        // Mailbox paused/removed after drafting: discard the draft; a new one is generated next tick.
        db.prepare("UPDATE drafts SET status = 'rejected', reviewed_at = ? WHERE id = ?").run(nowIso(at), draft.id);
        continue;
      }
      if (usedSenders.has(sender.id) || !senderReady(sender, at) || senderCapacity(sender, at) <= 0) continue;

      // Timing: if Jev prefers another part of the window, reschedule once for this step.
      const decision = JSON.parse(draft.decision_json || '{}');
      if (decision.slot && currentSlot && decision.slot !== currentSlot && prospect.postponed_step !== stepNumber) {
        const target = ranges.find((r) => r.name === decision.slot);
        const when = nextLocalSlot(campaign, at, target.from, target.to);
        if (when > at) {
          setProspect(prospect.id, { next_send_at: nowIso(when), postponed_step: stepNumber });
          continue;
        }
      }

      try {
        await sendDraft({ campaign, prospect, step, sender, draft, sequence });
        usedSenders.add(sender.id);
        sentCount += 1;
      } catch (err) {
        markSenderError(sender, err);
        setProspect(prospect.id, { last_error: String(err.message || err).slice(0, 500) });
        log.warn?.(`[scheduler] send failed for prospect ${prospect.id}: ${err.message}`);
        usedSenders.add(sender.id);
      }
    }
    return sentCount;
  }

  let running = false;
  async function tick() {
    if (running) return { skipped: true };
    running = true;
    try {
      await checkReplies();
      const analyzed = await analyzeLeads();
      const usedSenders = new Set();
      let sent = 0;
      for (const campaign of stmts.activeCampaigns.all()) {
        sent += await processCampaign(campaign, usedSenders);
        const open = db.prepare(
          `SELECT COUNT(*) AS n FROM prospects p WHERE p.campaign_id = ? AND p.status = 'active'`,
        ).get(campaign.id).n;
        const total = db.prepare('SELECT COUNT(*) AS n FROM prospects WHERE campaign_id = ?').get(campaign.id).n;
        if (total > 0 && open === 0) {
          db.prepare("UPDATE campaigns SET status = 'completed' WHERE id = ? AND status = 'active'").run(campaign.id);
        }
      }
      return { sent, analyzed };
    } finally {
      running = false;
    }
  }

  let timer = null;
  return {
    tick,
    checkReplies,
    analyzeLeads,
    start() {
      if (timer) return;
      timer = setInterval(() => {
        tick().catch((err) => log.error?.('[scheduler] tick failed', err));
      }, config.scheduler.intervalSeconds * 1000);
      timer.unref?.();
    },
    stop() {
      clearInterval(timer);
      timer = null;
    },
  };
}
