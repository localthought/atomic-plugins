// @wc-ignore-file
/**
 * Clockify reads the time-entry list's `start`/`end` as wall-clock time in
 * the user's profile time zone (`GET /user` → `settings.timeZone`): the
 * `Z` suffix and explicit offsets are ignored, and a string without either
 * is refused (checked live on 2026-09-24, #123). So the app sends local
 * wall-clock digits with a `Z`, and turns them back into UTC instants to
 * record what a read covered.
 *
 * Around a daylight-saving change a wall-clock time can mean two instants
 * (a repeated hour) or none (a skipped hour). How Clockify resolves those
 * was not checked, so `instantsOf` returns every instant it could mean and
 * the caller picks the one that claims the least coverage.
 */

const HOUR = 3_600_000;

/** No zone is further than this from UTC (UTC−12 … UTC+14). */
export const MAX_ZONE_OFFSET_MS = 14 * HOUR;

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let found = formatters.get(timeZone);

  if (!found) {
    found = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, found);
  }

  return found;
}

/** Whether `Intl` knows this IANA zone name. */
export function isTimeZone(timeZone: unknown): timeZone is string {
  if (typeof timeZone !== 'string' || !timeZone) return false;

  try {
    formatter(timeZone);

    return true;
  } catch {
    return false;
  }
}

/** The wall clock in `timeZone` at `at`, as epoch ms of the same digits in UTC. */
export function wallClock(at: number, timeZone: string): number {
  const parts = Object.fromEntries(
    formatter(timeZone)
      .formatToParts(at)
      .map(p => [p.type, p.value]),
  );

  return Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
}

/** `timeZone`'s UTC offset at `at`, in ms. */
export const zoneOffsetMs = (at: number, timeZone: string) =>
  wallClock(at, timeZone) - Math.floor(at / 1000) * 1000;

/** `yyyy-MM-ddTHH:mm:ssZ`: the wall-clock digits, with the `Z` Clockify
 * requires and ignores. */
export const wallClockParam = (at: number, timeZone: string) =>
  new Date(wallClock(at, timeZone)).toISOString().replace(/\.\d{3}Z$/, 'Z');

/**
 * Every instant the wall-clock time `wall` (epoch ms of its digits in UTC)
 * can mean in `timeZone`, ascending: one normally, two in a repeated hour.
 * In a skipped hour none is valid, so both offsets around the gap are
 * returned; they are the two readings a server could plausibly apply.
 */
export function instantsOf(wall: number, timeZone: string): number[] {
  const offsets = new Set([
    zoneOffsetMs(wall - MAX_ZONE_OFFSET_MS - 12 * HOUR, timeZone),
    zoneOffsetMs(wall, timeZone),
    zoneOffsetMs(wall + MAX_ZONE_OFFSET_MS + 12 * HOUR, timeZone),
  ]);
  const candidates = [...offsets].map(offset => wall - offset);
  const valid = candidates.filter(at => wallClock(at, timeZone) === wall);

  return (valid.length ? valid : candidates).sort((a, b) => a - b);
}
