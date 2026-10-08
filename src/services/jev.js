// Decision engine, in two stages:
//   1. analyzeProspect — commercial intelligence once per lead: segment, ICP fit, exclusion.
//   2. decide — per email step: message variant, personalization hook, problem hypothesis,
//      CTA and send slot, informed by engagement and by each variant's past results.
// Plus classifyReply for inbound replies. Uses Jev (TypeSafe System One) when
// TYPESAFE_API_KEY is set and transparent rules otherwise. Code owns the policy; Jev only
// supplies typed judgments over options the code has already validated.

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

function prospectFacts(prospect) {
  let custom = {};
  try {
    custom = JSON.parse(prospect.fields_json || '{}');
  } catch {
    custom = {};
  }
  const facts = {
    name: [prospect.first_name, prospect.last_name].filter(Boolean).join(' '),
    title: prospect.title,
    company: prospect.company,
    industry: prospect.industry,
    country: prospect.country,
    email_domain: prospect.email.split('@')[1],
  };
  for (const [k, v] of Object.entries(custom).slice(0, 25)) facts[k] = truncate(v, 300);
  return Object.fromEntries(Object.entries(facts).filter(([, v]) => v));
}

const rate = (num, den) => (den ? Number((num / den).toFixed(3)) : null);

// ---------------------------------------------------------------------------
// Stage 1 — commercial intelligence (once per prospect, right after import):
// segment, ICP fit and exclusion.
// ---------------------------------------------------------------------------

const tokenize = (text) =>
  new Set(
    String(text || '')
      .normalize('NFD')
      .replace(/[\u0300-\u036f]/g, '')
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 3),
  );

/** Rule fallback: segment with the most keyword overlap with the prospect's role/industry. */
export function ruleAnalysis({ prospect, segments }) {
  const profile = tokenize(Object.values(prospectFacts(prospect)).join(' '));
  let best = null;
  let bestScore = 0;
  for (const seg of segments) {
    const overlap = [...tokenize(`${seg.name} ${seg.description}`)].filter((w) => profile.has(w)).length;
    if (overlap > bestScore) {
      best = seg;
      bestScore = overlap;
    }
  }
  return {
    engine: 'rules',
    segmentId: best?.id ?? null,
    fitScore: null,
    exclude: false,
    detail: { segment: best ? `coincidencia de palabras clave (${bestScore})` : 'sin coincidencias' },
  };
}

/** @param ctx { campaign, prospect, segments } */
export async function analyzeProspect(ctx, { client = defaultClient() } = {}) {
  const fallback = ruleAnalysis(ctx);
  if (!ctx.campaign.jev_enabled || !client) return fallback;
  const { campaign, prospect, segments } = ctx;
  const questions = {
    exclude: noul(
      'Should this prospect be excluded from outreach? Answer yes only when the facts in `prospect` clearly show they cannot benefit from `campaign.offer`: an unrelated industry or role, a direct competitor, a student or job seeker, or a generic inbox unlikely to be read by a decision maker. Missing data is not a reason to exclude.',
    ),
  };
  if (segments.length) {
    questions.segment = choice('Which commercial segment in `segments` does this prospect belong to, based on their role, industry and company?', {
      ...Object.fromEntries(segments.map((sg) => [`s${sg.id}`, truncate(`${sg.name}: ${sg.description}`, 300)])),
      none: 'None of the segments describes this prospect',
    });
  }
  if (campaign.icp?.trim()) {
    questions.fit = score('How well does `prospect` match `campaign.ideal_customer_profile` (role, industry, company type)?', [
      'Clearly outside the ideal customer profile',
      'Weak match: only one minor attribute matches',
      'Partial match: industry or role matches but not both',
      'Good match: role and company type match',
      'Ideal match: matches the profile on every stated attribute',
    ]);
  }
  try {
    const result = await client.systemOne({
      state: {
        campaign: { offer: truncate(campaign.offer, 1500), ideal_customer_profile: truncate(campaign.icp, 1500) },
        segments: Object.fromEntries(segments.map((sg) => [`s${sg.id}`, { name: sg.name, description: sg.description }])),
        prospect: prospectFacts(prospect),
      },
      questions,
    });
    const a = result.answers;
    const seg = a.segment && a.segment.choice !== 'none' ? Number(a.segment.choice.slice(1)) : null;
    return {
      engine: 'jev',
      segmentId: seg,
      fitScore: a.fit ? Number((a.fit.score / 4).toFixed(3)) : null,
      exclude: (a.exclude?.noul ?? 0) >= STOP_THRESHOLD,
      detail: {
        model: result.model,
        exclude_probability: a.exclude?.noul ?? null,
        segment: a.segment ? { choice: a.segment.choice, confidence: a.segment.confidence, probabilities: a.segment.probabilities } : null,
        fit: a.fit ? { score: a.fit.score, confidence: a.fit.confidence } : null,
      },
    };
  } catch (err) {
    return { ...fallback, detail: { ...fallback.detail, jev_error: String(err.message || err).slice(0, 300) } };
  }
}

// ---------------------------------------------------------------------------
// Stage 2 — message decision (every email step): which variant, personalization hook,
// problem hypothesis, CTA and time slot. Candidates are pre-filtered by code (segment and
// data availability), so Jev can only pick options that render with real data.
// ---------------------------------------------------------------------------

/** Builds the state object Jev evaluates. Kept compact: only facts useful for the judgments. */
export function buildState(ctx) {
  const { campaign, prospect, segment, stepNumber, totalSteps, engagement, variants, ctas, hooks = [], problems = [] } = ctx;
  return {
    campaign: {
      offer: truncate(campaign.offer, 1500),
      ideal_customer_profile: truncate(campaign.icp, 1500),
    },
    prospect: { ...prospectFacts(prospect), segment: segment ? `${segment.name}: ${segment.description}` : null },
    sequence: { next_step: stepNumber, total_steps: totalSteps, is_follow_up: stepNumber > 1 },
    engagement,
    candidate_messages: Object.fromEntries(
      variants.map((v) => [
        `v${v.id}`,
        {
          angle: v.angle || v.label,
          opening: truncate(v.preview, 280),
          // Learning loop: past results of this variant in this campaign.
          history: v.stats ? { sent: v.stats.sent, reply_rate: rate(v.stats.replied, v.stats.sent), positive_rate: rate(v.stats.positive, v.stats.sent) } : null,
        },
      ]),
    ),
    candidate_hooks: Object.fromEntries(hooks.map((h) => [`h${h.id}`, { purpose: h.description || h.label, text: truncate(h.preview, 280) }])),
    candidate_problems: Object.fromEntries(problems.map((p) => [`p${p.id}`, { purpose: p.description || p.label, text: truncate(p.preview, 280) }])),
    candidate_ctas: Object.fromEntries(
      ctas.map((c) => [`c${c.id}`, { purpose: c.description || c.label, text: c.text, history: c.stats ? { sent: c.stats.sent, reply_rate: rate(c.stats.replied, c.stats.sent) } : null }]),
    ),
  };
}

export function buildQuestions(ctx, ranges) {
  const { variants, ctas, hooks = [], problems = [], stepNumber } = ctx;
  const questions = {
    send_slot: choice(
      'Which part of the sending window is the best moment to deliver the next email to this prospect? Use `engagement.previous_open_slots` (when the prospect actually opened earlier emails) as the strongest evidence; otherwise reason from their role and seniority.',
      Object.fromEntries(
        ranges.map((r) => [r.name, `${r.label} local time${r.name === 'early' ? ' — before the day fills with meetings' : r.name === 'late' ? ' — end of the working day' : ''}`]),
      ),
    ),
  };
  if (variants.length > 1) {
    questions.variant = choice(
      `Which message angle in \`candidate_messages\` is most likely to earn a reply from this prospect for step ${stepNumber} of the sequence? Match the angle to the prospect's role, segment and situation, and to \`engagement\`: prospects who opened several times but did not reply need a different angle than the ones already sent. When \`history\` shows a clear difference over a meaningful number of sends, prefer the angle with the better positive reply rate.`,
      Object.fromEntries(variants.map((v) => [`v${v.id}`, truncate(v.angle || v.label, 300)])),
    );
  }
  if (hooks.length > 1) {
    questions.hook = choice(
      'Which opening in `candidate_hooks` refers to the most relevant, specific and non-trivial fact about this prospect or their responsibility? Prefer concrete facts about their role, company situation or recent activity over generic ones.',
      Object.fromEntries(hooks.map((h) => [`h${h.id}`, truncate(h.description || h.preview, 300)])),
    );
  }
  if (problems.length > 1) {
    questions.problem = choice(
      'Which problem hypothesis in `candidate_problems` is most likely to be real and relevant for someone with this prospect\'s role, segment and industry?',
      Object.fromEntries(problems.map((p) => [`p${p.id}`, truncate(p.description || p.preview, 300)])),
    );
  }
  if (ctas.length > 1) {
    questions.cta = choice(
      'Which call-to-action in `candidate_ctas` has the right ask size for this prospect right now? Prefer the lowest-friction ask (interest check, offer to send info) for prospects with little or no engagement, and a more direct ask (short call) only for prospects who engaged repeatedly or are a very strong fit.',
      Object.fromEntries(ctas.map((c) => [`c${c.id}`, truncate(c.description || c.text, 300)])),
    );
  }
  return questions;
}

function hashPick(items, seed) {
  const n = crypto.createHash('sha1').update(seed).digest().readUInt32BE(0);
  return items[n % items.length];
}

const MIN_SENDS_TO_EXPLOIT = 20;

/** Rotates evenly until every variant has enough sends, then favours the best one 80% of the time. */
function pickVariant(variants, seed) {
  if (variants.length < 2) return variants[0] || null;
  const enough = variants.every((v) => (v.stats?.sent || 0) >= MIN_SENDS_TO_EXPLOIT);
  if (!enough) return hashPick(variants, seed);
  const best = [...variants].sort((a, b) => rate(b.stats.positive, b.stats.sent) - rate(a.stats.positive, a.stats.sent))[0];
  const roll = crypto.createHash('sha1').update(`${seed}:explore`).digest().readUInt8(0) / 255;
  return roll < 0.8 ? best : hashPick(variants.filter((v) => v !== best), seed);
}

/** Segment-specific snippets first, then generic ones; rotate within the preferred group. */
function pickSnippet(snippets, segmentId, seed) {
  if (!snippets.length) return null;
  const specific = snippets.filter((s) => segmentId && s.segment_id === segmentId);
  return hashPick(specific.length ? specific : snippets, seed);
}

/** Rule-based fallback; deterministic so A/B splits are stable. */
export function ruleDecision(ctx) {
  const { prospect, stepNumber, variants, ctas, engagement, hooks = [], problems = [] } = ctx;
  const seed = `${prospect.id}:${stepNumber}`;
  const variant = pickVariant(variants, seed);
  const engaged = engagement.human_opens_total >= 2;
  const cta = ctas.length ? (engaged ? ctas[ctas.length - 1] : ctas[0]) : null;
  const slots = engagement.previous_open_slots || [];
  const counts = SLOTS.map((s) => [s, slots.filter((x) => x === s).length]).sort((a, b) => b[1] - a[1]);
  return {
    engine: 'rules',
    action: 'send',
    variantId: variant?.id ?? null,
    ctaId: cta?.id ?? null,
    hookId: pickSnippet(hooks, prospect.segment_id, `${seed}:hook`)?.id ?? null,
    problemId: pickSnippet(problems, prospect.segment_id, `${seed}:problem`)?.id ?? null,
    slot: counts[0][1] > 0 ? counts[0][0] : null,
    detail: {
      variant: variants.length > 1 ? 'rotación A/B (favorece la mejor tras 20 envíos por variante)' : 'única variante',
      cta: ctas.length ? (engaged ? 'prospecto con 2+ aperturas → CTA más directo' : 'baja interacción → CTA de baja fricción') : null,
      slot: counts[0][1] > 0 ? 'franja con más aperturas previas' : 'sin preferencia',
    },
  };
}

const idFrom = (answer) => (answer ? Number(answer.choice.slice(1)) : undefined);
const summary = (answer) => (answer ? { choice: answer.choice, confidence: answer.confidence, probabilities: answer.probabilities } : null);

/**
 * @param ctx { campaign, prospect, segment, stepNumber, totalSteps, engagement, variants, ctas, hooks, problems }
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
    return {
      engine: 'jev',
      action: 'send',
      variantId: idFrom(a.variant) ?? fallback.variantId,
      ctaId: idFrom(a.cta) ?? fallback.ctaId,
      hookId: idFrom(a.hook) ?? fallback.hookId,
      problemId: idFrom(a.problem) ?? fallback.problemId,
      slot: a.send_slot && a.send_slot.confidence >= SLOT_MIN_CONFIDENCE ? a.send_slot.choice : null,
      detail: {
        model: result.model,
        variant: summary(a.variant),
        hook: summary(a.hook),
        problem: summary(a.problem),
        cta: summary(a.cta),
        send_slot: a.send_slot ? { choice: a.send_slot.choice, confidence: a.send_slot.confidence } : null,
        usage: result.usage,
      },
    };
  } catch (err) {
    return { ...fallback, detail: { ...fallback.detail, jev_error: String(err.message || err).slice(0, 300) } };
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
