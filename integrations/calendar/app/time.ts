// @wc-ignore-file
/**
 * Civil dates and wall-clock times in a named IANA zone, for display only.
 *
 * Stored values stay the exact strings Google sent (`YYYY-MM-DD`, or a
 * date-time with its UTC offset). Nothing here writes a `Date` or a number
 * back to a row: `toDateTime` builds the offset-qualified string an edit
 * stores, from a civil date, minutes since midnight and the viewer's zone.
 *
 * Every function takes the zone explicitly so tests are independent of the
 * machine's zone. The app passes `viewerZone()`.
 */

export const DAY_MS = 86_400_000;

/** The viewer's IANA zone, e.g. `Europe/Amsterdam`. */
export function viewerZone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
}

const partsFormats = new Map<string, Intl.DateTimeFormat>();

function partsFormat(zone: string): Intl.DateTimeFormat {
  let format = partsFormats.get(zone);

  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    partsFormats.set(zone, format);
  }

  return format;
}

export interface Wall {
  /** `YYYY-MM-DD` in the zone. */
  date: string;
  /** Minutes since that date's midnight, 0–1439. */
  minutes: number;
}

/** The wall-clock date and time of an instant in `zone`. */
export function wall(ms: number, zone: string): Wall {
  const parts: Record<string, string> = {};
  for (const p of partsFormat(zone).formatToParts(new Date(ms)))
    parts[p.type] = p.value;

  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutes: Number(parts.hour) * 60 + Number(parts.minute),
  };
}

/** The zone's UTC offset at an instant, in minutes (east positive). */
export function offsetAt(ms: number, zone: string): number {
  const w = wall(ms, zone);
  const asUtc = Date.parse(`${w.date}T00:00:00Z`) + w.minutes * 60_000;

  return Math.round((asUtc - Math.floor(ms / 60_000) * 60_000) / 60_000);
}

/** The instant a wall-clock time in `zone` names (the earlier one in a fold). */
export function instant(date: string, minutes: number, zone: string): number {
  const guess = Date.parse(`${date}T00:00:00Z`) + minutes * 60_000;
  let at = guess - offsetAt(guess, zone) * 60_000;
  // A second pass settles instants whose offset differs from the guess's.
  at = guess - offsetAt(at, zone) * 60_000;

  return at;
}

export function formatOffset(minutes: number): string {
  const sign = minutes < 0 ? '-' : '+';
  const abs = Math.abs(minutes);

  return `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
}

const pad = (n: number) => String(n).padStart(2, '0');

/** `HH:MM` from minutes since midnight (1440 reads as `24:00`). */
export function hhmm(minutes: number): string {
  return `${pad(Math.floor(minutes / 60))}:${pad(minutes % 60)}`;
}

/** Minutes since midnight from `HH:MM`, or undefined when it isn't one. */
export function parseHhmm(text: string): number | undefined {
  const m = /^(\d{1,2}):(\d{2})$/.exec(text.trim());
  if (!m) return undefined;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return undefined;

  return h * 60 + min;
}

/**
 * The offset-qualified date-time string an edit stores:
 * `YYYY-MM-DDTHH:MM:00+02:00`, the offset being the viewer's zone's at that
 * wall time. The offset is attached, never typed by the person.
 */
export function toDateTime(
  date: string,
  minutes: number,
  zone: string,
): string {
  const at = instant(date, minutes, zone);
  const w = wall(at, zone);

  return `${w.date}T${hhmm(w.minutes)}:00${formatOffset(offsetAt(at, zone))}`;
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS)
    .toISOString()
    .slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round(
    (Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS,
  );
}

/** 0 for Monday … 6 for Sunday. */
export function weekday(date: string): number {
  return (new Date(`${date}T00:00:00Z`).getUTCDay() + 6) % 7;
}

/** The Monday on or before `date`. */
export function mondayOf(date: string): string {
  return addDays(date, -weekday(date));
}

export function isDate(value: string): boolean {
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
  );
}

// Fixed English names rather than Intl: the copy is English, and Intl's
// short month names differ between runtimes ("Sep" vs "Sept").
const WEEKDAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday',
];
const MONTHS = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];
const dayNum = (date: string) => Number(date.slice(8, 10));
const monthName = (date: string) => MONTHS[Number(date.slice(5, 7)) - 1];

export function weekdayLong(date: string): string {
  return WEEKDAYS[weekday(date)];
}

export function weekdayShort(date: string): string {
  return weekdayLong(date).slice(0, 3);
}

/** `Thu 24 Sep` */
export function shortDay(date: string): string {
  return `${weekdayShort(date)} ${dayNum(date)} ${monthName(date).slice(0, 3)}`;
}

/** `Thursday 24 September` */
export function longDay(date: string): string {
  return `${weekdayLong(date)} ${dayNum(date)} ${monthName(date)}`;
}

/** `September 2026` */
export function monthTitle(date: string): string {
  return `${monthName(date)} ${date.slice(0, 4)}`;
}

/** `21 – 27 September 2026`, `28 September – 4 October 2026`, across years in full. */
export function rangeTitle(from: string, to: string): string {
  if (from === to) return `${longDay(from)} ${from.slice(0, 4)}`;
  const [fy, ty] = [from.slice(0, 4), to.slice(0, 4)];
  const [f, t] = [dayNum(from), dayNum(to)];
  if (fy !== ty)
    return `${f} ${monthName(from)} ${fy} – ${t} ${monthName(to)} ${ty}`;
  if (from.slice(5, 7) !== to.slice(5, 7))
    return `${f} ${monthName(from)} – ${t} ${monthName(to)} ${ty}`;

  return `${f} – ${t} ${monthName(to)} ${ty}`;
}

/** `GMT+2`, the short label of the zone's offset at an instant. */
export function offsetLabel(ms: number, zone: string): string {
  const off = offsetAt(ms, zone);
  if (off === 0) return 'GMT';
  const h = Math.floor(Math.abs(off) / 60);
  const m = Math.abs(off) % 60;

  return `GMT${off < 0 ? '−' : '+'}${h}${m ? `:${pad(m)}` : ''}`;
}
