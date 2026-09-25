// @wc-ignore-file
/**
 * Times as the shell shows them, in the viewer's locale: "4 min ago" for
 * the status pill, "Today, 10:12" / "22 Sep, 16:18" for values. Pure, with
 * `now` passed in, so tests do not depend on the clock.
 */

const MINUTE = 60_000;

export function ago(at: number, now: number): string {
  const diff = Math.max(0, now - at);
  if (diff < MINUTE) return 'just now';
  if (diff < 60 * MINUTE) return `${Math.floor(diff / MINUTE)} min ago`;
  if (diff < 24 * 60 * MINUTE)
    return `${Math.floor(diff / (60 * MINUTE))} h ago`;
  const days = Math.floor(diff / (24 * 60 * MINUTE));

  return days === 1 ? 'yesterday' : `${days} days ago`;
}

const startOfDay = (t: number) => {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);

  return d.getTime();
};

export function clock(at: number, locale?: string): string {
  return new Date(at).toLocaleTimeString(locale, {
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** "Today, 10:12", "Yesterday, 17:30", "22 Sep, 16:18", or with the year. */
export function when(at: number, now: number, locale?: string): string {
  const day = startOfDay(at);
  const today = startOfDay(now);
  if (day === today) return `Today, ${clock(at, locale)}`;
  if (day === today - 24 * 60 * MINUTE)
    return `Yesterday, ${clock(at, locale)}`;
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear();

  return `${new Date(at).toLocaleDateString(locale, {
    day: 'numeric',
    month: 'short',
    ...(sameYear ? {} : { year: 'numeric' }),
  })}, ${clock(at, locale)}`;
}

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
