// @wc-ignore-file
/**
 * Durations, calendar days and weeks for the timesheet views (design #89
 * §7), as pure functions over epoch milliseconds and IANA zone names. No
 * DOM, no store, no library: `Intl.DateTimeFormat` does the zone work, via
 * `../timeZone.ts`.
 *
 * - A **day key** is a local calendar date, `yyyy-mm-dd`. Date arithmetic on
 *   day keys is done on UTC midnights, so it has no DST steps.
 * - Durations are summed as integer milliseconds and rounded to whole
 *   minutes only when formatted, so a displayed total can differ by one
 *   minute from the sum of the displayed parts.
 */
import { instantsOf, wallClock } from '../timeZone.js';

const MINUTE = 60_000;
const DAY = 86_400_000;

export type DayKey = string;

/** Clockify's `settings.weekStart` values, Monday first. */
export const WEEKDAYS = [
  'MONDAY',
  'TUESDAY',
  'WEDNESDAY',
  'THURSDAY',
  'FRIDAY',
  'SATURDAY',
  'SUNDAY',
] as const;

export type WeekStart = (typeof WEEKDAYS)[number];

/** `WeekStart` from whatever Clockify sent; Monday when unknown. */
export const weekStartOf = (value: unknown): WeekStart =>
  WEEKDAYS.find(d => d === String(value).toUpperCase()) ?? 'MONDAY';

const minutes = (ms: number) => Math.round(Math.max(0, ms) / MINUTE);

/** `2:05`, `26:50`, `0:00`: hours and minutes, no day rollover. */
export function formatDuration(ms: number): string {
  const total = minutes(ms);

  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** `2 hours 30 minutes`, `1 hour`, `45 minutes`, `0 minutes`. */
export function spokenDuration(ms: number): string {
  const total = minutes(ms);
  const h = Math.floor(total / 60);
  const m = total % 60;
  const parts = [
    ...(h ? [`${h} ${h === 1 ? 'hour' : 'hours'}`] : []),
    ...(m || !h ? [`${m} ${m === 1 ? 'minute' : 'minutes'}`] : []),
  ];

  return parts.join(' ');
}

const pad = (n: number) => String(n).padStart(2, '0');

const keyOfUtc = (utcMidnight: number): DayKey => {
  const d = new Date(utcMidnight);

  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
};

const utcOfKey = (key: DayKey) => Date.parse(`${key}T00:00:00Z`);

/** The local calendar date of `at` in `timeZone`. */
export const dayKey = (at: number, timeZone: string): DayKey =>
  keyOfUtc(Math.floor(wallClock(at, timeZone) / DAY) * DAY);

export const addDays = (key: DayKey, n: number): DayKey =>
  keyOfUtc(utcOfKey(key) + n * DAY);

/** 0 = Monday … 6 = Sunday. */
export const weekdayIndex = (key: DayKey) =>
  (new Date(utcOfKey(key)).getUTCDay() + 6) % 7;

/**
 * The first instant of local day `key` in `timeZone`. Where midnight is
 * skipped by a DST change, the first instant after the gap.
 */
export function startOfDay(key: DayKey, timeZone: string): number {
  const [first] = instantsOf(utcOfKey(key), timeZone);
  // In a skipped midnight both candidates read back as another wall time;
  // take the later, which lies on the day itself.
  if (dayKey(first, timeZone) === key) return first;

  return Math.max(...instantsOf(utcOfKey(key), timeZone));
}

export interface Week {
  /** The seven local days, in display order. */
  days: DayKey[];
  start: DayKey;
}

/** The week containing `key`, starting on `weekStart`. */
export function weekContaining(key: DayKey, weekStart: WeekStart): Week {
  const offset = (weekdayIndex(key) - WEEKDAYS.indexOf(weekStart) + 7) % 7;
  const start = addDays(key, -offset);

  return { start, days: [0, 1, 2, 3, 4, 5, 6].map(i => addDays(start, i)) };
}

export const weekOf = (at: number, weekStart: WeekStart, timeZone: string) =>
  weekContaining(dayKey(at, timeZone), weekStart);

export const shiftWeek = (week: Week, weeks: number): Week => {
  const start = addDays(week.start, 7 * weeks);

  return { start, days: week.days.map(d => addDays(d, 7 * weeks)) };
};

/** `[from, to)` of the week in `timeZone`. */
export const weekSpan = (week: Week, timeZone: string) => ({
  from: startOfDay(week.start, timeZone),
  to: startOfDay(addDays(week.start, 7), timeZone),
});

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const DAY_NAMES = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];

const parts = (key: DayKey) => {
  const [y, m, d] = key.split('-').map(Number);

  return { y, m, d };
};

export const dayOfMonth = (key: DayKey) => parts(key).d;
/** `Mon`. */
export const shortWeekday = (key: DayKey) =>
  DAY_NAMES[weekdayIndex(key)].slice(0, 3);
/** `Monday`. */
export const longWeekday = (key: DayKey) => DAY_NAMES[weekdayIndex(key)];

/** `24 Sep`, or `24 Sep 2026` with `year`. */
export function formatDay(key: DayKey, year = false): string {
  const { y, m, d } = parts(key);

  return `${d} ${MONTHS[m - 1]}${year ? ` ${y}` : ''}`;
}

/**
 * `21 – 27 Sep 2026`, `31 Aug – 6 Sep 2026`, `28 Dec 2026 – 3 Jan 2027`;
 * without `year`, the year is left off entirely.
 */
export function formatRange(from: DayKey, to: DayKey, year = true): string {
  const a = parts(from);
  const b = parts(to);
  const tail = year ? ` ${b.y}` : '';
  if (a.y !== b.y && year)
    return `${formatDay(from, true)} – ${formatDay(to, true)}`;
  if (a.m === b.m) return `${a.d} – ${b.d} ${MONTHS[b.m - 1]}${tail}`;

  return `${formatDay(from)} – ${formatDay(to)}${tail}`;
}

/** `09:15`: the local 24-hour time of `at`. */
export function formatTime(at: number, timeZone: string): string {
  const wall = new Date(wallClock(at, timeZone));

  return `${pad(wall.getUTCHours())}:${pad(wall.getUTCMinutes())}`;
}

/** The browser's zone; `UTC` if `Intl` does not say. */
export const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
};

/** `4 min ago`, `2 h ago`, `just now`, `3 days ago`. */
export function ago(at: number, now: number): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 60) return 'just now';
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ago`;

  return `${Math.floor(h / 24)} days ago`;
}
