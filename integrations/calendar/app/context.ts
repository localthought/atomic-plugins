// @wc-ignore-file
/**
 * What the Calendar view modules share: the document, the viewer's zone and
 * today, and the actions they may call. Plus the text helpers that turn an
 * event into the words the views and screen readers use.
 */
import type { Projection } from '../adapter.js';
import type { CalEvent, Segment } from './events.js';
import { LABELS } from './sync.js';
import {
  addDays,
  formatOffset,
  hhmm,
  longDay,
  offsetAt,
  shortDay,
  wall,
} from './time.js';

export interface Ctx {
  doc: Document;
  zone: string;
  today: string;
  now: number;
  /** Width of the frame, px. */
  width: number;
  open(event: CalEvent, from: HTMLElement): void;
  goTo(date: string): void;
  setView(view: 'agenda' | 'week'): void;
}

export const isToday = (ctx: Ctx, date: string) => date === ctx.today;

/** `Today`, `Tomorrow`, or the weekday. */
export function relativeDay(ctx: Ctx, date: string, long: string): string {
  if (date === ctx.today) return 'Today';
  if (date === addDays(ctx.today, 1)) return 'Tomorrow';
  if (date === addDays(ctx.today, -1)) return 'Yesterday';

  return long;
}

/** `10:00 to 11:00`, or `All day`, for one segment. */
export function spoken(segment: Segment): string {
  if (segment.allDay) return 'All day';

  return `${hhmm(segment.startMin)} to ${hhmm(segment.endMin)}`;
}

/**
 * The complete accessible name of an event button (DESIGN.md §7):
 * "Design review, 10:00 to 11:00, Room 4, Work calendar".
 */
export function accessibleName(segment: Segment): string {
  const e = segment.event;
  const parts = [e.title || '(untitled)', spoken(segment)];
  if (segment.dayOf)
    parts.push(`day ${segment.dayOf.n} of ${segment.dayOf.total}`);
  if (e.location) parts.push(e.location);
  parts.push(`${e.calendar.name} calendar`);
  if (e.pending) parts.push('not sent yet');
  if (e.conflict) parts.push('conflict');

  return parts.join(', ');
}

/** When an event is, in the viewer's zone: a day line and a time line. */
export function when(
  event: Projection,
  zone: string,
): { day: string; time?: string; own?: string } {
  if (event.allDay) {
    const last = addDays(event.end, -1);

    return {
      day:
        last === event.start
          ? longDay(event.start)
          : `${longDay(event.start)} – ${longDay(last)}`,
      time: 'All day',
    };
  }

  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!Number.isFinite(start) || !Number.isFinite(end))
    return { day: `${event.start} – ${event.end}` };
  const s = wall(start, zone);
  const e = wall(end, zone);
  const time =
    s.date === e.date
      ? `${hhmm(s.minutes)} – ${hhmm(e.minutes)}`
      : `${hhmm(s.minutes)} – ${shortDay(e.date)} ${hhmm(e.minutes)}`;
  // The event's own zone, when its stored offset differs from the viewer's.
  const own = /([+-]\d{2}:\d{2}|Z)$/.exec(event.start)?.[1];
  const viewer = formatOffset(offsetAt(start, zone));
  const ownOffset = own === 'Z' ? '+00:00' : own;
  const local = (value: string) => value.slice(11, 16);

  return {
    day: longDay(s.date),
    time,
    ...(ownOffset && ownOffset !== viewer
      ? {
          own: `${local(event.start)} – ${local(event.end)} in the event’s time zone (UTC${ownOffset.replace('-', '−')})`,
        }
      : {}),
  };
}

/** A field value as the review and conflict sheets show it. */
export function fieldValue(
  field: keyof Projection,
  value: Projection,
  zone: string,
): string {
  const raw = value[field];
  if (field === 'allDay') return raw ? 'All day' : 'Timed';
  if (field !== 'start' && field !== 'end') return String(raw) || '(empty)';

  if (value.allDay) {
    const date = field === 'end' ? addDays(String(raw), -1) : String(raw);

    return shortDay(date);
  }

  const at = Date.parse(String(raw));
  if (!Number.isFinite(at)) return String(raw);
  const w = wall(at, zone);

  return `${shortDay(w.date)} ${hhmm(w.minutes)}`;
}

/** `Location changed from Room 4 to Room 2.` or `Title and location changed.` */
export function changeLine(event: CalEvent, zone: string): string | undefined {
  const base = event.baseline;
  if (!base) return undefined;
  const keys = (Object.keys(LABELS) as Array<keyof Projection>).filter(
    k => base[k] !== event[k],
  );
  if (!keys.length) return undefined;

  if (keys.length === 1) {
    const [k] = keys;

    return `${LABELS[k]} changed from ${fieldValue(k, base, zone)} to ${fieldValue(k, event, zone)}.`;
  }

  const names = keys.map(k => LABELS[k].toLowerCase());
  const list = `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;

  return `${list[0].toUpperCase()}${list.slice(1)} changed.`;
}
