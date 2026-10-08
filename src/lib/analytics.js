// Advanced analytics across campaigns: KPIs (with previous-period deltas), daily series,
// when prospects open (weekday × hour), and breakdowns by campaign, step, subject, sender,
// segment, industry and role. Opens are human opens only (scanner prefetches are excluded).

import { localParts } from './time.js';

const DAY_MS = 86400000;
const POSITIVE = "('interested','referral')";
const POSITIVE_OUTCOMES = "('interested','meeting','opportunity','won')";

const rate = (n, d) => (d ? Math.round((n / d) * 1000) / 10 : null);
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function scope({ userId, campaignId, brandId }) {
  const where = ['c.user_id = @userId'];
  if (campaignId) where.push('c.id = @campaignId');
  if (brandId) where.push('c.brand_id = @brandId');
  return { sql: where.join(' AND '), params: { userId, campaignId: campaignId || null, brandId: brandId || null } };
}

function kpis(db, s, from, to) {
  const p = { ...s.params, from, to };
  const m = db.prepare(
    `SELECT COUNT(*) AS sent, COUNT(DISTINCT m.prospect_id) AS contacted,
       COALESCE(SUM(m.open_count > 0), 0) AS opened, COALESCE(SUM(m.open_count), 0) AS opens_total
     FROM messages m JOIN campaigns c ON c.id = m.campaign_id
     WHERE ${s.sql} AND m.sent_at >= @from AND m.sent_at < @to`,
  ).get(p);
  const pr = db.prepare(
    `SELECT
       COALESCE(SUM(p.status = 'replied' AND p.reply_category IS NOT NULL AND p.reply_category NOT IN ('bounce','auto_reply')), 0) AS replied,
       COALESCE(SUM(p.reply_category IN ${POSITIVE} OR p.outcome IN ${POSITIVE_OUTCOMES}), 0) AS positive,
       COALESCE(SUM(p.reply_category = 'not_interested'), 0) AS not_interested
     FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
     WHERE ${s.sql} AND p.replied_at >= @from AND p.replied_at < @to`,
  ).get(p);
  const meetings = db.prepare(
    `SELECT COALESCE(SUM(p.outcome IN ('meeting','opportunity','won')), 0) AS meetings, COALESCE(SUM(p.outcome = 'won'), 0) AS won
     FROM prospects p JOIN campaigns c ON c.id = p.campaign_id WHERE ${s.sql} AND p.outcome_at >= @from AND p.outcome_at < @to`,
  ).get(p);
  const bounced = db.prepare(
    `SELECT COUNT(DISTINCT p.id) AS n FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
     WHERE ${s.sql} AND p.status = 'bounced' AND EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.sent_at >= @from AND m.sent_at < @to)`,
  ).get(p).n;
  const unsubscribed = db.prepare(
    `SELECT COUNT(DISTINCT p.id) AS n FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
     WHERE ${s.sql} AND p.status = 'unsubscribed' AND EXISTS (SELECT 1 FROM messages m WHERE m.prospect_id = p.id AND m.sent_at >= @from AND m.sent_at < @to)`,
  ).get(p).n;
  const delivered = Math.max(0, m.sent - bounced);
  return {
    sent: m.sent,
    delivered,
    contacted: m.contacted,
    opened: m.opened,
    opens_total: m.opens_total,
    replied: pr.replied,
    positive: pr.positive,
    not_interested: pr.not_interested,
    meetings: meetings.meetings,
    won: meetings.won,
    bounced,
    unsubscribed,
    open_rate: rate(m.opened, delivered),
    reply_rate: rate(pr.replied, m.contacted),
    positive_rate: rate(pr.positive, m.contacted),
    bounce_rate: rate(bounced, m.sent),
    unsubscribe_rate: rate(unsubscribed, m.contacted),
    meeting_rate: rate(meetings.meetings, m.contacted),
  };
}

/**
 * @param opts { userId, from: Date, to: Date, campaignId?, brandId?, tz }
 */
export function computeAnalytics(db, opts) {
  const { from, to, tz = 'UTC' } = opts;
  const s = scope(opts);
  const fromIso = from.toISOString();
  const toIso = to.toISOString();
  const span = to - from;
  const p = { ...s.params, from: fromIso, to: toIso };

  // Daily series (local dates in the viewer's time zone).
  const dayKey = (iso) => {
    const lp = localParts(new Date(iso), tz);
    return `${lp.year}-${String(lp.month).padStart(2, '0')}-${String(lp.day).padStart(2, '0')}`;
  };
  const days = new Map();
  for (let t = from.getTime(); t < to.getTime(); t += DAY_MS) days.set(dayKey(new Date(t).toISOString()), { date: dayKey(new Date(t).toISOString()), sent: 0, opened: 0, replied: 0 });
  const bump = (iso, key) => {
    const d = days.get(dayKey(iso));
    if (d) d[key] += 1;
  };
  const sends = db.prepare(
    `SELECT m.id, m.sent_at, m.first_opened_at FROM messages m JOIN campaigns c ON c.id = m.campaign_id
     WHERE ${s.sql} AND m.sent_at >= @from AND m.sent_at < @to`,
  ).all(p);
  for (const r of sends) bump(r.sent_at, 'sent');
  const opens = db.prepare(
    `SELECT oe.opened_at, c.timezone FROM open_events oe JOIN messages m ON m.id = oe.message_id JOIN campaigns c ON c.id = m.campaign_id
     WHERE ${s.sql} AND oe.suspected_bot = 0 AND oe.opened_at >= @from AND oe.opened_at < @to`,
  ).all(p);
  const firstOpens = sends.filter((r) => r.first_opened_at && r.first_opened_at >= fromIso && r.first_opened_at < toIso);
  for (const r of firstOpens) bump(r.first_opened_at, 'opened');
  const replies = db.prepare(
    `SELECT p.replied_at, (SELECT MIN(sent_at) FROM messages m WHERE m.prospect_id = p.id) AS first_sent
     FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
     WHERE ${s.sql} AND p.replied_at >= @from AND p.replied_at < @to AND p.reply_category NOT IN ('bounce','auto_reply')`,
  ).all(p);
  for (const r of replies) bump(r.replied_at, 'replied');

  // When do they open? weekday (1=Mon) × hour, in each campaign's own time zone.
  const heatmap = Array.from({ length: 7 }, () => Array(24).fill(0));
  for (const o of opens) {
    const lp = localParts(new Date(o.opened_at), o.timezone || tz);
    heatmap[lp.weekday - 1][lp.hour] += 1;
  }

  // Timing.
  const hoursToOpen = sends.filter((r) => r.first_opened_at).map((r) => (new Date(r.first_opened_at) - new Date(r.sent_at)) / 3600000);
  const hoursToReply = replies.filter((r) => r.first_sent).map((r) => (new Date(r.replied_at) - new Date(r.first_sent)) / 3600000);

  // Breakdowns over messages sent in the period; a reply is credited to the prospect's last email.
  const lastEmail = 'm.step_number = (SELECT MAX(step_number) FROM messages m2 WHERE m2.prospect_id = p.id)';
  const breakdown = (groupSql, select, extraJoin = '') => db.prepare(
    `SELECT ${select}, COUNT(*) AS sent, COALESCE(SUM(m.open_count > 0), 0) AS opened,
       COALESCE(SUM(CASE WHEN p.status = 'replied' AND p.reply_category NOT IN ('bounce','auto_reply') AND ${lastEmail} THEN 1 ELSE 0 END), 0) AS replied,
       COALESCE(SUM(CASE WHEN (p.reply_category IN ${POSITIVE} OR p.outcome IN ${POSITIVE_OUTCOMES}) AND ${lastEmail} THEN 1 ELSE 0 END), 0) AS positive,
       COALESCE(SUM(p.status = 'bounced'), 0) AS bounced
     FROM messages m JOIN prospects p ON p.id = m.prospect_id JOIN campaigns c ON c.id = m.campaign_id ${extraJoin}
     WHERE ${s.sql} AND m.sent_at >= @from AND m.sent_at < @to GROUP BY ${groupSql} ORDER BY sent DESC LIMIT 40`,
  ).all(p).map((r) => ({ ...r, open_rate: rate(r.opened, r.sent), reply_rate: rate(r.replied, r.sent), bounce_rate: rate(r.bounced, r.sent) }));

  const previous = kpis(db, s, new Date(from - span).toISOString(), fromIso);
  return {
    period: { from: fromIso, to: toIso, tz },
    kpis: kpis(db, s, fromIso, toIso),
    previous,
    daily: [...days.values()],
    heatmap,
    timing: {
      median_hours_to_open: median(hoursToOpen) === null ? null : Math.round(median(hoursToOpen) * 10) / 10,
      median_hours_to_reply: median(hoursToReply) === null ? null : Math.round(median(hoursToReply) * 10) / 10,
    },
    by_campaign: breakdown('c.id', 'c.id, c.name, c.status'),
    by_step: breakdown('m.step_number', 'm.step_number'),
    by_subject: breakdown('m.variant_id', "m.variant_id, v.label, COALESCE(NULLIF(v.subject, ''), MIN(m.subject)) AS subject, s2.step_number AS variant_step", 'LEFT JOIN variants v ON v.id = m.variant_id LEFT JOIN steps s2 ON s2.id = v.step_id'),
    by_sender: breakdown('m.sender_id', 'm.sender_id, se.email AS sender', 'LEFT JOIN senders se ON se.id = m.sender_id'),
    by_persona: breakdown('p.persona_id', "COALESCE(pe.name, 'Sin perfil') AS persona", 'LEFT JOIN personas pe ON pe.id = p.persona_id'),
    by_segment: breakdown('p.segment_id', "COALESCE(sg.name, 'Sin segmento') AS segment", 'LEFT JOIN segments sg ON sg.id = p.segment_id'),
    by_industry: breakdown("COALESCE(NULLIF(p.industry, ''), '—')", "COALESCE(NULLIF(p.industry, ''), 'Sin industria') AS industry"),
    by_title: breakdown("COALESCE(NULLIF(p.title, ''), '—')", "COALESCE(NULLIF(p.title, ''), 'Sin cargo') AS title"),
    replies_by_category: db.prepare(
      `SELECT p.reply_category AS category, COUNT(*) AS n FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
       WHERE ${s.sql} AND p.replied_at >= @from AND p.replied_at < @to AND p.reply_category IS NOT NULL GROUP BY p.reply_category ORDER BY n DESC`,
    ).all(p),
    pipeline: db.prepare(
      `SELECT p.lead_status, p.status, COUNT(*) AS n FROM prospects p JOIN campaigns c ON c.id = p.campaign_id
       WHERE ${s.sql} GROUP BY p.lead_status, p.status`,
    ).all(s.params),
  };
}
