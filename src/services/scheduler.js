import { config } from '../config.js';
import { nowIso } from '../db.js';
import { decrypt, randomToken } from '../lib/crypto.js';
import { buildMime, formatAddress, toBase64Url } from '../lib/mime.js';
import { buildEmailBody, prospectVariables, renderTemplate } from '../lib/template.js';
import { addDays, inSendWindow, localParts, nextLocalSlot } from '../lib/time.js';
import { extractEmail, gmailForRefreshToken } from './google.js';
import { classifyReply, decide, slotForMinute, slotRanges } from './jev.js';

const DAY_MS = 86400000;
// Only credential problems disable a sender; 403/429 rate limits are retried on the next tick.
const AUTH_ERROR_RE = /invalid_grant|invalid credentials|insufficient (permission|authentication scopes)|unauthorized_client|\b401\b/i;

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
  return steps.map((s) => ({ ...s, variants: variantsStmt.all(s.id) }));
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
  const ranges = slotRanges(campaign.window_start, campaign.window_end);
  const daysAgo = (iso) => (iso ? Number(((now - new Date(iso)) / DAY_MS).toFixed(1)) : null);
  const last = messages[messages.length - 1];
  return {
    emails_sent: messages.length,
    days_since_last_email: last ? daysAgo(last.sent_at) : null,
    opened_last_email: last ? last.open_count > 0 : false,
    human_opens_total: opens.length,
    last_open_days_ago: opens.length ? daysAgo(opens[opens.length - 1].opened_at) : null,
    previous_emails: messages.map((m) => ({
      step: m.step_number,
      opens: m.open_count,
      last_opened_days_ago: daysAgo(m.last_opened_at),
    })),
    previous_open_slots: opens
      .map((o) => slotForMinute(ranges, localParts(new Date(o.opened_at), campaign.timezone).minuteOfDay))
      .filter(Boolean),
  };
}

/**
 * Renders the email for a prospect/step/variant. Shared by the scheduler and the preview endpoint.
 * @returns {{ subject, body, missing: string[], cta }}
 */
export function renderStep({ prospect, sender, variant, cta, step, threadSubject, fallbackSubject }) {
  const senderName = sender?.display_name || '';
  const baseVars = prospectVariables(prospect, {
    sender_name: senderName,
    sender_first_name: senderName.split(' ')[0] || '',
    sender_email: sender?.email || '',
  });
  const ctaRendered = cta ? renderTemplate(cta.text, baseVars) : { text: '', missing: [] };
  const vars = { ...baseVars, cta: ctaRendered.text };
  const body = renderTemplate(variant.body, vars);
  const sameThread = step.step_number > 1 && step.same_thread && threadSubject;
  let subject;
  if (sameThread) subject = { text: /^re:/i.test(threadSubject) ? threadSubject : `Re: ${threadSubject}`, missing: [] };
  else if (variant.subject?.trim()) subject = renderTemplate(variant.subject, vars);
  // Follow-up without its own subject that cannot be threaded: reuse the original subject.
  else subject = { text: fallbackSubject || '', missing: [] };
  return {
    subject: subject.text,
    body: body.text,
    missing: [...new Set([...body.missing, ...subject.missing, ...ctaRendered.missing])],
    sameThread: Boolean(sameThread),
  };
}

export function createScheduler({
  db,
  gmailFor = (sender) => gmailForRefreshToken(decrypt(sender.refresh_token_enc)),
  decideFn = decide,
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
    ctas: db.prepare('SELECT * FROM ctas WHERE campaign_id = ? ORDER BY id'),
    due: db.prepare(
      `SELECT * FROM prospects WHERE campaign_id = ? AND status = 'active' AND next_send_at IS NOT NULL AND next_send_at <= ?
       ORDER BY current_step DESC, fit_score IS NULL, fit_score DESC, next_send_at ASC LIMIT 200`,
    ),
    sentLast24h: db.prepare('SELECT COUNT(*) AS n FROM messages WHERE sender_id = ? AND sent_at > ?'),
    suppressed: db.prepare('SELECT 1 FROM suppressions WHERE user_id = ? AND email = ?'),
    sender: db.prepare('SELECT * FROM senders WHERE id = ?'),
    lastMessage: db.prepare('SELECT * FROM messages WHERE prospect_id = ? ORDER BY step_number DESC LIMIT 1'),
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
    const sent = stmts.sentLast24h.get(sender.id, since).n;
    return sender.daily_limit - sent;
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
  // Reply / bounce detection
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
    return outcome;
  }

  async function checkReplies() {
    const at = now();
    const cutoff = new Date(at.getTime() - config.scheduler.replyCheckMinutes * 60000).toISOString();
    const recent = new Date(at.getTime() - 30 * DAY_MS).toISOString();
    const rows = db
      .prepare(
        `SELECT p.*, c.id AS c_id FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
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
  // Sending
  // -------------------------------------------------------------------------
  async function sendOne({ campaign, prospect, step, sender, decision, totalSteps, sequence }) {
    const variant = step.variants.find((v) => v.id === decision.variantId) || step.variants[0];
    const ctas = stmts.ctas.all(campaign.id);
    const cta = ctas.find((c) => c.id === decision.ctaId) || null;
    // Only the mailbox that owns the thread can reply in it.
    const canThread = Boolean(prospect.thread_id && prospect.sender_id === sender.id);
    const rendered = renderStep({
      prospect, sender, variant, cta, step,
      threadSubject: canThread ? prospect.first_subject : null,
      fallbackSubject: prospect.first_subject,
    });
    if (rendered.missing.length) {
      setProspect(prospect.id, {
        status: 'stopped',
        next_send_at: null,
        stop_reason: `Faltan campos para personalizar: ${rendered.missing.join(', ')} (usa {{campo|alternativa}})`,
      });
      return false;
    }
    if (!rendered.subject) {
      setProspect(prospect.id, { status: 'stopped', next_send_at: null, stop_reason: `El paso ${step.step_number} no tiene asunto` });
      return false;
    }

    const at = now();
    const token = randomToken();
    const previous = rendered.sameThread ? stmts.lastMessage.get(prospect.id) : null;
    const quoted = previous
      ? {
          header: `El ${new Date(previous.sent_at).toLocaleString('es', { timeZone: campaign.timezone, dateStyle: 'medium', timeStyle: 'short' })}, ${sender.display_name || sender.email} <${sender.email}> escribió:`,
          text: previous.body_text,
        }
      : null;
    const unsub = campaign.include_unsubscribe ? unsubscribeUrl(prospect.unsubscribe_token) : null;
    const { text, html } = buildEmailBody({
      body: rendered.body,
      signatureHtml: sender.signature_html,
      trackingPixelUrl: campaign.track_opens ? trackingPixelUrl(token) : null,
      unsubscribeUrl: unsub,
      quoted,
    });
    const mime = buildMime({
      from: formatAddress(sender.display_name, sender.email),
      to: formatAddress([prospect.first_name, prospect.last_name].filter(Boolean).join(' '), prospect.email),
      subject: rendered.subject,
      text,
      html,
      inReplyTo: rendered.sameThread ? prospect.last_message_id_header : null,
      references: rendered.sameThread ? prospect.last_message_id_header : null,
      headers: unsub ? { 'List-Unsubscribe': `<${unsub}>`, 'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click' } : {},
    });

    const gmail = gmailFor(sender);
    const sent = await gmail.send({ raw: toBase64Url(mime), threadId: rendered.sameThread ? prospect.thread_id : null });
    let messageIdHeader = null;
    try {
      messageIdHeader = await gmail.getMessageIdHeader(sent.id);
    } catch {
      messageIdHeader = null;
    }

    const nextStep = sequence.find((s) => s.step_number === step.step_number + 1);
    const isLast = step.step_number >= totalSteps || !nextStep;
    db.transaction(() => {
      db.prepare(
        `INSERT INTO messages (prospect_id, campaign_id, sender_id, step_number, variant_id, cta_id, subject, body_text,
           gmail_message_id, gmail_thread_id, message_id_header, tracking_token, decision_json, sent_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(prospect.id, campaign.id, sender.id, step.step_number, variant.id, cta?.id ?? null, rendered.subject, rendered.body,
        sent.id, sent.threadId, messageIdHeader, token, JSON.stringify(decision), nowIso(at));
      setProspect(prospect.id, {
        current_step: step.step_number,
        sender_id: sender.id,
        thread_id: rendered.sameThread ? prospect.thread_id : sent.threadId,
        first_subject: step.step_number === 1 || !rendered.sameThread ? rendered.subject : prospect.first_subject,
        last_message_id_header: messageIdHeader || prospect.last_message_id_header,
        status: isLast ? 'finished' : 'active',
        next_send_at: isLast ? null : nowIso(addDays(at, Math.max(1, nextStep.delay_days))),
        pending_decision_json: null,
        postponed_step: null,
        last_error: null,
        fit_score: decision.fitScore ?? prospect.fit_score,
      });
      db.prepare('UPDATE senders SET last_sent_at = ?, last_error = NULL WHERE id = ?').run(nowIso(at), sender.id);
    })();
    sender.last_sent_at = nowIso(at);
    return true;
  }

  async function processCampaign(campaign, usedSenders) {
    const at = now();
    if (!inSendWindow(campaign, at)) return 0;
    const senders = stmts.campaignSenders.all(campaign.id);
    if (!senders.length) return 0;
    const sequence = loadSequence(db, campaign.id).filter((s) => s.variants.length);
    const totalSteps = Math.min(sequence.length, config.sequence.maxSteps);
    if (!totalSteps) return 0;
    const ctas = stmts.ctas.all(campaign.id);
    const ranges = slotRanges(campaign.window_start, campaign.window_end);
    const currentSlot = slotForMinute(ranges, localParts(at, campaign.timezone).minuteOfDay);

    let sentCount = 0;
    for (const prospect of stmts.due.all(campaign.id, nowIso(at))) {
      const available = senders.filter((s) => !usedSenders.has(s.id) && senderReady(s, at) && senderCapacity(s, at) > 0);
      if (!available.length) break;

      const nextNumber = prospect.current_step + 1;
      const step = sequence.find((s) => s.step_number === nextNumber);
      if (!step || nextNumber > totalSteps) {
        setProspect(prospect.id, { status: 'finished', next_send_at: null });
        continue;
      }
      if (stmts.suppressed.get(campaign.user_id, prospect.email)) {
        setProspect(prospect.id, { status: 'unsubscribed', next_send_at: null, stop_reason: 'En lista de supresión' });
        continue;
      }

      // Sticky sender: follow-ups always come from the mailbox that sent step 1.
      let sender = null;
      if (prospect.sender_id) {
        sender = available.find((s) => s.id === prospect.sender_id);
        if (!sender) {
          const original = stmts.sender.get(prospect.sender_id);
          if (!original || original.status !== 'active' || !senders.some((s) => s.id === original.id)) {
            // Original mailbox gone: hand over to another sender in a new thread.
            sender = available[0];
          } else continue;
        }
      } else {
        sender = available.sort((a, b) => senderCapacity(b, at) - senderCapacity(a, at))[0];
      }

      // Never follow up on someone who already replied.
      if (nextNumber > 1 && campaign.stop_on_reply && prospect.sender_id === sender.id) {
        try {
          if (await scanReplies(prospect, campaign, sender)) continue;
        } catch (err) {
          markSenderError(sender, err);
          continue;
        }
      }

      let decision = null;
      if (prospect.pending_decision_json && prospect.postponed_step === nextNumber) {
        decision = JSON.parse(prospect.pending_decision_json);
      } else {
        const ctx = {
          campaign,
          prospect,
          stepNumber: nextNumber,
          totalSteps,
          engagement: engagementFor(db, prospect, campaign, at),
          variants: step.variants.map((v) => ({
            ...v,
            preview: renderStep({ prospect, sender, variant: v, cta: null, step, threadSubject: prospect.first_subject }).body,
          })),
          ctas,
        };
        decision = await decideFn(ctx);
        stmts.logDecision.run(prospect.id, nextNumber, decision.engine, decision.action, JSON.stringify(decision), nowIso(at));
        if (decision.fitScore !== null && decision.fitScore !== undefined) setProspect(prospect.id, { fit_score: decision.fitScore });

        if (decision.action === 'stop') {
          setProspect(prospect.id, { status: 'stopped', next_send_at: null, stop_reason: 'Jev: no encaja con la oferta/ICP' });
          continue;
        }
        // Timing: if Jev prefers another part of the window, reschedule once for this step.
        if (decision.slot && currentSlot && decision.slot !== currentSlot) {
          const target = ranges.find((r) => r.name === decision.slot);
          const when = nextLocalSlot(campaign, at, target.from, target.to);
          if (when > at) {
            setProspect(prospect.id, {
              next_send_at: nowIso(when),
              pending_decision_json: JSON.stringify(decision),
              postponed_step: nextNumber,
            });
            continue;
          }
        }
      }

      try {
        const ok = await sendOne({ campaign, prospect, step, sender, decision, totalSteps, sequence });
        if (ok) {
          usedSenders.add(sender.id);
          sentCount += 1;
        }
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
      const usedSenders = new Set();
      let sent = 0;
      for (const campaign of stmts.activeCampaigns.all()) {
        sent += await processCampaign(campaign, usedSenders);
        const remaining = db
          .prepare("SELECT COUNT(*) AS n FROM prospects WHERE campaign_id = ? AND status = 'active'")
          .get(campaign.id).n;
        const total = db.prepare('SELECT COUNT(*) AS n FROM prospects WHERE campaign_id = ?').get(campaign.id).n;
        if (total > 0 && remaining === 0) {
          db.prepare("UPDATE campaigns SET status = 'completed' WHERE id = ? AND status = 'active'").run(campaign.id);
        }
      }
      return { sent };
    } finally {
      running = false;
    }
  }

  let timer = null;
  return {
    tick,
    checkReplies,
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

