// Decision engine. For every prospect whose next step is due it decides:
//   - whether to keep contacting them (stop on clear non-fit),
//   - which message angle (variant) to send,
//   - which call-to-action fits their engagement,
//   - which time slot of the sending window to use,
//   - how well they fit the ICP (used to prioritise when daily limits are tight).
// It uses Jev (TypeSafe System One) when TYPESAFE_API_KEY is set and falls back to
// transparent rules otherwise. Code owns the policy; Jev only supplies typed judgments.

import crypto from 'node:crypto';
import { TypeSafeClient, choice, noul, score } from '@typesafe-ai/sdk';
import { config, jevConfigured } from '../config.js';

export const SLOTS = ['early', 'middle', 'late'];
const STOP_THRESHOLD = 0.85;
const SLOT_MIN_CONFIDENCE = 0.5;

let sharedClient = null;
function defaultClient() {
  if (!jevConfigured()) return null;
  sharedClient ??= new TypeSafeClient({
    apiKey: config.typesafe.apiKey,
    defaultModel: config.typesafe.model,
    baseURL: config.typesafe.baseURL,
    timeout: 15000,
  });
  return sharedClient;
}

const truncate = (value, max = 400) => {
  const s = String(value ?? '');
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Splits the sending window into three named slots, e.g. 08:00–11:00. */
export function slotRanges(windowStart, windowEnd) {
  const toMin = (t) => {
    const [h, m] = t.split(':').map(Number);
    return h * 60 + m;
  };
  const start = toMin(windowStart);
  const end = toMin(windowEnd);
  const size = Math.max(1, Math.floor((end - start) / 3));
  const fmt = (min) => `${String(Math.floor(min / 60)).padStart(2, '0')}:${String(min % 60).padStart(2, '0')}`;
  return SLOTS.map((name, i) => {
    const from = start + i * size;
    const to = i === 2 ? end : start + (i + 1) * size;
    return { name, from, to, label: `${fmt(from)}–${fmt(to)}` };
  });
}

export function slotForMinute(ranges, minuteOfDay) {
  return ranges.find((r) => minuteOfDay >= r.from && minuteOfDay < r.to)?.name ?? null;
}

/** Builds the state object Jev evaluates. Kept compact: only facts useful for the judgments. */
export function buildState(ctx) {
  const { campaign, prospect, stepNumber, totalSteps, engagement, variants, ctas } = ctx;
  let custom = {};
  try {
    custom = JSON.parse(prospect.fields_json || '{}');
  } catch {
    custom = {};
  }
  const customFacts = Object.fromEntries(Object.entries(custom).slice(0, 25).map(([k, v]) => [k, truncate(v, 300)]));
  return {
    campaign: {
      offer: truncate(campaign.offer, 1500),
      ideal_customer_profile: truncate(campaign.icp, 1500),
    },
    prospect: {
      name: [prospect.first_name, prospect.last_name].filter(Boolean).join(' '),
      title: prospect.title,
      company: prospect.company,
      email_domain: prospect.email.split('@')[1],
      ...customFacts,
    },
    sequence: { next_step: stepNumber, total_steps: totalSteps, is_follow_up: stepNumber > 1 },
    engagement,
    candidate_messages: Object.fromEntries(
      variants.map((v) => [`v${v.id}`, { angle: v.angle || v.label, opening: truncate(v.preview, 280) }]),
    ),
    candidate_ctas: Object.fromEntries(ctas.map((c) => [`c${c.id}`, { purpose: c.description || c.label, text: c.text }])),
  };
}

export function buildQuestions(ctx, ranges) {
  const { campaign, variants, ctas, stepNumber } = ctx;
  const questions = {
    stop: noul(
      'Should outreach to this prospect stop now? Answer yes only when the facts in `prospect` clearly show they cannot benefit from `campaign.offer`: an unrelated industry or role, a direct competitor, a generic or role inbox unlikely to be read by a decision maker, or a stated request not to be contacted. Missing data is not a reason to stop.',
    ),
    send_slot: choice(
      'Which part of the sending window is the best moment to deliver the next email to this prospect? Use `engagement.previous_open_slots` (when the prospect actually opened earlier emails) as the strongest evidence; otherwise reason from their role and seniority.',
      Object.fromEntries(
        ranges.map((r) => [r.name, `${r.label} local time${r.name === 'early' ? ' — before the day fills with meetings' : r.name === 'late' ? ' — end of the working day' : ''}`]),
      ),
    ),
  };
  if (variants.length > 1) {
    questions.variant = choice(
      `Which message angle in \`candidate_messages\` is most likely to earn a reply from this prospect for step ${stepNumber} of the sequence? Match the angle to the prospect's role, company and situation, and to \`engagement\`: prospects who opened several times but did not reply need a different angle than the ones already sent; prospects who never opened need a fresh, short angle.`,
      Object.fromEntries(variants.map((v) => [`v${v.id}`, truncate(v.angle || v.label, 300)])),
    );
  }
  if (ctas.length > 1) {
    questions.cta = choice(
      'Which call-to-action in `candidate_ctas` has the right ask size for this prospect right now? Prefer the lowest-friction ask (interest check, offer to send info) for prospects with little or no engagement, and a more direct ask (short call) only for prospects who engaged repeatedly or are a very strong fit.',
      Object.fromEntries(ctas.map((c) => [`c${c.id}`, truncate(c.description || c.text, 300)])),
    );
  }
  if (campaign.icp?.trim()) {
    questions.fit = score('How well does `prospect` match `campaign.ideal_customer_profile`?', [
      'Clearly outside the ideal customer profile',
      'Weak match: only one minor attribute matches',
      'Partial match: industry or role matches but not both',
      'Good match: role and company type match',
      'Ideal match: matches the profile on every stated attribute',
    ]);
  }
  return questions;
}

function hashPick(items, seed) {
  const n = crypto.createHash('sha1').update(seed).digest().readUInt32BE(0);
  return items[n % items.length];
}

/** Rule-based fallback; deterministic so A/B splits are stable. */
export function ruleDecision(ctx) {
  const { prospect, stepNumber, variants, ctas, engagement } = ctx;
  const variant = variants.length ? hashPick(variants, `${prospect.id}:${stepNumber}`) : null;
  const engaged = engagement.human_opens_total >= 2;
  const cta = ctas.length ? (engaged ? ctas[ctas.length - 1] : ctas[0]) : null;
  const slots = engagement.previous_open_slots || [];
  const counts = SLOTS.map((s) => [s, slots.filter((x) => x === s).length]).sort((a, b) => b[1] - a[1]);
  return {
    engine: 'rules',
    action: 'send',
    variantId: variant?.id ?? null,
    ctaId: cta?.id ?? null,
    slot: counts[0][1] > 0 ? counts[0][0] : null,
    fitScore: null,
    detail: {
      variant: variants.length > 1 ? 'rotación A/B determinística' : 'única variante',
      cta: ctas.length ? (engaged ? 'prospecto con 2+ aperturas → CTA más directo' : 'baja interacción → CTA de baja fricción') : null,
      slot: counts[0][1] > 0 ? 'franja con más aperturas previas' : 'sin preferencia',
    },
  };
}

/**
 * @param ctx { campaign, prospect, stepNumber, totalSteps, engagement, variants, ctas }
 * @param options { client } injectable TypeSafe client (tests)
 */
export async function decide(ctx, { client = defaultClient() } = {}) {
  const fallback = ruleDecision(ctx);
  if (!ctx.campaign.jev_enabled || !client) return fallback;

  const ranges = slotRanges(ctx.campaign.window_start, ctx.campaign.window_end);
  const questions = buildQuestions(ctx, ranges);
  try {
    const result = await client.systemOne({ state: buildState(ctx), questions });
    const a = result.answers;
    const stopP = a.stop?.noul ?? 0;
    const variantId = a.variant ? Number(a.variant.choice.slice(1)) : fallback.variantId;
    const ctaId = a.cta ? Number(a.cta.choice.slice(1)) : fallback.ctaId;
    const slot = a.send_slot && a.send_slot.confidence >= SLOT_MIN_CONFIDENCE ? a.send_slot.choice : null;
    // Score is 0..4; normalise to 0..1 for sorting.
    const fitScore = a.fit ? Number((a.fit.score / 4).toFixed(3)) : null;
    return {
      engine: 'jev',
      action: stopP >= STOP_THRESHOLD ? 'stop' : 'send',
      variantId,
      ctaId,
      slot,
      fitScore,
      detail: {
        model: result.model,
        stop_probability: stopP,
        variant: a.variant ? { choice: a.variant.choice, confidence: a.variant.confidence, probabilities: a.variant.probabilities } : null,
        cta: a.cta ? { choice: a.cta.choice, confidence: a.cta.confidence, probabilities: a.cta.probabilities } : null,
        send_slot: a.send_slot ? { choice: a.send_slot.choice, confidence: a.send_slot.confidence } : null,
        fit: a.fit ? { score: a.fit.score, confidence: a.fit.confidence } : null,
        usage: result.usage,
      },
    };
  } catch (err) {
    return { ...fallback, engine: 'rules', detail: { ...fallback.detail, jev_error: String(err.message || err).slice(0, 300) } };
  }
}

const AUTO_REPLY_RE = /out of (the )?office|fuera de la oficina|automatic reply|auto[- ]?reply|respuesta autom[aá]tica|vacaciones|on vacation|on leave|de licencia|ausente|away from|no estar[eé] disponible/i;
const NEGATIVE_RE = /no (me|nos) interesa|not interested|unsubscribe|remove me|no me escrib|stop emailing|darme de baja|borr(a|en)me/i;
const BOUNCE_RE = /mailer-daemon|postmaster|mail delivery (subsystem|failed)|undeliverable|delivery status notification|no se pudo entregar|address not found/i;

export const REPLY_CATEGORIES = ['interested', 'not_interested', 'referral', 'question', 'auto_reply', 'bounce'];

/** Rule-based reply classification (fallback). */
export function ruleClassifyReply({ from, snippet }) {
  const text = `${from} ${snippet}`;
  if (BOUNCE_RE.test(text)) return 'bounce';
  if (AUTO_REPLY_RE.test(snippet)) return 'auto_reply';
  if (NEGATIVE_RE.test(snippet)) return 'not_interested';
  return 'question';
}

/**
 * Classifies an inbound message on a prospect thread. Auto-replies keep the sequence running;
 * everything else stops it. Returns { category, engine, confidence }.
 */
export async function classifyReply({ from, snippet, campaign }, { client = defaultClient() } = {}) {
  const ruled = ruleClassifyReply({ from, snippet });
  if (ruled === 'bounce' || !client || !campaign?.jev_enabled) return { category: ruled, engine: 'rules', confidence: null };
  try {
    const result = await client.systemOne({
      state: { reply: { from, text: truncate(snippet, 1500) }, our_offer: truncate(campaign.offer, 600) },
      questions: {
        category: choice('What kind of reply is `reply` to our cold outreach email?', {
          interested: 'Shows interest: wants info, a call, pricing or a next step',
          not_interested: 'Declines, asks to stop or unsubscribe, or says it is not relevant',
          referral: 'Points us to another person or team who is the right contact',
          question: 'Asks a question or responds neutrally without a clear yes or no',
          auto_reply: 'Automatic message: out of office, vacation, leave, or a ticket/auto-acknowledgement — not written by a person',
          bounce: 'Delivery failure notice: address not found, mailbox full, rejected',
        }),
      },
    });
    const answer = result.answers.category;
    return { category: answer.choice, engine: 'jev', confidence: answer.confidence };
  } catch {
    return { category: ruled, engine: 'rules', confidence: null };
  }
}
