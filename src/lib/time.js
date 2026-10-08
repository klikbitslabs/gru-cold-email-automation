// Time-zone helpers built on Intl (no external dependency).

const WEEKDAYS = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 };

export function isValidTimeZone(tz) {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/** Local calendar parts of `date` in `tz`. weekday: 1=Mon … 7=Sun. */
export function localParts(date, tz) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    })
      .formatToParts(date)
      .map((p) => [p.type, p.value]),
  );
  const hour = Number(parts.hour) % 24;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour,
    minute: Number(parts.minute),
    second: Number(parts.second),
    weekday: WEEKDAYS[parts.weekday],
    minuteOfDay: hour * 60 + Number(parts.minute),
  };
}

function offsetMs(date, tz) {
  const p = localParts(date, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(date.getTime() / 1000) * 1000;
}

/** UTC Date for a local wall-clock time in `tz`. */
export function zonedToUtc({ year, month, day, minuteOfDay }, tz) {
  const guess = Date.UTC(year, month - 1, day, Math.floor(minuteOfDay / 60), minuteOfDay % 60);
  let result = guess - offsetMs(new Date(guess), tz);
  result = guess - offsetMs(new Date(result), tz);
  return new Date(result);
}

export const parseHHMM = (t) => {
  const [h, m] = String(t).split(':').map(Number);
  return h * 60 + m;
};

export const parseDays = (sendDays) =>
  String(sendDays)
    .split(',')
    .map((d) => Number(d.trim()))
    .filter((d) => d >= 1 && d <= 7);

/**
 * Per-day sending schedule: { "1": { on, start, end }, … "7": … } (1 = Monday).
 * Campaigns without one fall back to send_days + a single window.
 */
export function campaignSchedule(campaign) {
  if (campaign.schedule_json) {
    try {
      return JSON.parse(campaign.schedule_json);
    } catch {
      /* fall through */
    }
  }
  const days = parseDays(campaign.send_days);
  return Object.fromEntries([1, 2, 3, 4, 5, 6, 7].map((d) => [d, { on: days.includes(d), start: campaign.window_start, end: campaign.window_end }]));
}

export function inSendWindow(campaign, date) {
  const p = localParts(date, campaign.timezone);
  const day = campaignSchedule(campaign)[p.weekday];
  return Boolean(day?.on) && p.minuteOfDay >= parseHHMM(day.start) && p.minuteOfDay < parseHHMM(day.end);
}

/** Minutes of sending time per week, used for the "how long will N emails take" summary. */
export function weeklySendingMinutes(schedule) {
  return Object.values(schedule).reduce((sum, d) => sum + (d.on ? Math.max(0, parseHHMM(d.end) - parseHHMM(d.start)) : 0), 0);
}

/**
 * Next instant >= `from` that falls on a sending day at local minute `targetMinute`
 * (or later the same day if `from` is already past it but before `untilMinute`).
 */
export function nextLocalSlot(campaign, from, targetMinute, untilMinute) {
  const days = parseDays(campaign.send_days);
  for (let i = 0; i < 15; i += 1) {
    const probe = new Date(from.getTime() + i * 86400000);
    const p = localParts(probe, campaign.timezone);
    if (!days.includes(p.weekday)) continue;
    const candidate = zonedToUtc({ year: p.year, month: p.month, day: p.day, minuteOfDay: targetMinute }, campaign.timezone);
    if (candidate >= from) return candidate;
    if (i === 0 && untilMinute !== undefined && p.minuteOfDay < untilMinute) return from;
  }
  return new Date(from.getTime() + 86400000);
}

export const addDays = (date, days) => new Date(date.getTime() + days * 86400000);
