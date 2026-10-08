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

export function inSendWindow(campaign, date) {
  const p = localParts(date, campaign.timezone);
  return (
    parseDays(campaign.send_days).includes(p.weekday) &&
    p.minuteOfDay >= parseHHMM(campaign.window_start) &&
    p.minuteOfDay < parseHHMM(campaign.window_end)
  );
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
