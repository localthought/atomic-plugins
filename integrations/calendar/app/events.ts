// @wc-ignore-file
/**
 * The display model of the Calendar app's views: events as the rows hold
 * them, laid out per day (Agenda) and per column (Week) in the viewer's zone.
 * Pure functions only; `main.ts` and the view modules draw from these.
 *
 * All-day `end` is exclusive (the day after the last day), as Google and the
 * lens store it. A timed event that crosses midnight is split into one
 * segment per day it covers.
 */
import type { Projection } from '../adapter.js';
import { addDays, daysBetween, instant, wall } from './time.js';

export interface CalEvent extends Projection {
  /** The row's subject. */
  subject: string;
  /** The Google event id; absent for rows made in the table. */
  id?: string;
  /** Edited here and not sent yet: the row differs from its sync baseline. */
  pending: boolean;
  /** Listed as a conflict by the last preview. */
  conflict: boolean;
  /** The calendar is read-only for this person: never offer Edit. */
  readOnly: boolean;
  calendar: { name: string; color: string };
}

/** Start and end as instants, for ordering and timed layout. */
export function bounds(
  event: Projection,
  zone: string,
): { start: number; end: number } | undefined {
  if (event.allDay) {
    const s = Date.parse(`${event.start}T00:00:00Z`);
    const e = Date.parse(`${event.end}T00:00:00Z`);
    if (!Number.isFinite(s) || !Number.isFinite(e) || e <= s) return undefined;

    return {
      start: instant(event.start, 0, zone),
      end: instant(event.end, 0, zone),
    };
  }

  const start = Date.parse(event.start);
  const end = Date.parse(event.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start)
    return undefined;

  return { start, end };
}

export interface Segment {
  event: CalEvent;
  date: string;
  /** All-day, or a timed event covering this whole day (drawn as all-day). */
  allDay: boolean;
  /** Minutes since midnight in the viewer's zone (0 when it continues from the day before). */
  startMin: number;
  /** Minutes since midnight (1440 when it continues into the next day). */
  endMin: number;
  /** 1-based day of a multi-day event, and how many days it covers. */
  dayOf?: { n: number; total: number };
}

/** The per-day pieces of one event, clipped to [from, from + days). */
export function segments(
  event: CalEvent,
  from: string,
  days: number,
  zone: string,
): Segment[] {
  const out: Segment[] = [];
  const last = addDays(from, days);

  if (event.allDay) {
    if (!bounds(event, zone)) return out;
    const total = daysBetween(event.start, event.end);

    for (let d = event.start, n = 1; d < event.end; d = addDays(d, 1), n++)
      if (d >= from && d < last)
        out.push({
          event,
          date: d,
          allDay: true,
          startMin: 0,
          endMin: 1440,
          ...(total > 1 ? { dayOf: { n, total } } : {}),
        });

    return out;
  }

  const b = bounds(event, zone);
  if (!b) return out;
  const s = wall(b.start, zone);
  const e = wall(b.end, zone);
  // An end at exactly midnight belongs to the day before.
  const lastDay = e.minutes === 0 ? addDays(e.date, -1) : e.date;
  const total = daysBetween(s.date, lastDay) + 1;

  for (let d = s.date, n = 1; d <= lastDay; d = addDays(d, 1), n++) {
    if (d < from || d >= last) continue;
    const startMin = d === s.date ? s.minutes : 0;
    const endMin = d === e.date ? e.minutes : 1440;
    out.push({
      event,
      date: d,
      allDay: total > 1 && startMin === 0 && endMin === 1440,
      startMin,
      endMin,
      ...(total > 1 ? { dayOf: { n, total } } : {}),
    });
  }

  return out;
}

const order = (a: Segment, b: Segment) =>
  Number(b.allDay) - Number(a.allDay) ||
  a.startMin - b.startMin ||
  a.endMin - b.endMin ||
  a.event.title.localeCompare(b.event.title) ||
  a.event.subject.localeCompare(b.event.subject);

export interface AgendaDay {
  date: string;
  items: Segment[];
}

/**
 * The Agenda: one entry per day from `from`, `days` long, each with its
 * events in display order (all-day first, then by start time). Days without
 * events are kept, so the view can say "No events".
 */
export function agendaDays(
  events: CalEvent[],
  from: string,
  days: number,
  zone: string,
): AgendaDay[] {
  const byDay = new Map<string, Segment[]>();
  for (let i = 0; i < days; i++) byDay.set(addDays(from, i), []);

  for (const event of events)
    for (const segment of segments(event, from, days, zone))
      byDay.get(segment.date)!.push(segment);

  return [...byDay].map(([date, items]) => ({
    date,
    items: items.sort(order),
  }));
}

export interface Bar {
  event: CalEvent;
  /** Column index of the first day shown, 0-based. */
  col: number;
  /** Number of columns spanned. */
  span: number;
  /** Row in the all-day area, 0-based. */
  row: number;
}

export interface Block {
  segment: Segment;
  /** Lane within its overlap cluster, 0-based, and how many lanes the cluster has. */
  lane: number;
  lanes: number;
}

export interface WeekLayout {
  days: string[];
  bars: Bar[];
  /** How many all-day rows are used. */
  rows: number;
  columns: Block[][];
}

/**
 * The Week: all-day bars spanning columns (exclusive end), and per day the
 * timed blocks packed into lanes so overlapping events split the column.
 */
export function packWeek(
  events: CalEvent[],
  from: string,
  count: number,
  zone: string,
): WeekLayout {
  const days = Array.from({ length: count }, (_, i) => addDays(from, i));
  const barSegs = new Map<string, Segment[]>();
  const perDay: Segment[][] = days.map(() => []);

  for (const event of events)
    for (const segment of segments(event, from, count, zone)) {
      if (segment.allDay) {
        const list = barSegs.get(event.subject) ?? [];
        list.push(segment);
        barSegs.set(event.subject, list);
      } else perDay[days.indexOf(segment.date)].push(segment);
    }

  // Consecutive all-day days of one event become one bar.
  const pending: Array<Omit<Bar, 'row'>> = [];

  for (const list of barSegs.values()) {
    let current: Omit<Bar, 'row'> | undefined;

    for (const segment of list) {
      const col = days.indexOf(segment.date);

      if (current && current.col + current.span === col) current.span++;
      else {
        current = { event: segment.event, col, span: 1 };
        pending.push(current);
      }
    }
  }

  pending.sort(
    (a, b) =>
      a.col - b.col ||
      b.span - a.span ||
      a.event.title.localeCompare(b.event.title),
  );
  const occupied: boolean[][] = [];
  const bars: Bar[] = pending.map(bar => {
    let row = 0;

    for (; ; row++) {
      occupied[row] ??= [];
      const cells = occupied[row];
      let free = true;
      for (let c = bar.col; c < bar.col + bar.span; c++)
        if (cells[c]) free = false;
      if (!free) continue;
      for (let c = bar.col; c < bar.col + bar.span; c++) cells[c] = true;
      break;
    }

    return { ...bar, row };
  });

  const columns = perDay.map(list => packColumn(list.sort(order)));

  return { days, bars, rows: occupied.length, columns };
}

/** Greedy lane packing within clusters of transitively overlapping blocks. */
function packColumn(sorted: Segment[]): Block[] {
  const out: Block[] = [];
  let cluster: Block[] = [];
  let laneEnds: number[] = [];
  let clusterEnd = -1;

  const close = () => {
    for (const block of cluster) block.lanes = laneEnds.length;
    out.push(...cluster);
    cluster = [];
    laneEnds = [];
  };

  for (const segment of sorted) {
    if (cluster.length && segment.startMin >= clusterEnd) {
      close();
      clusterEnd = -1;
    }

    let lane = laneEnds.findIndex(end => end <= segment.startMin);
    if (lane < 0) lane = laneEnds.push(0) - 1;
    laneEnds[lane] = segment.endMin;
    cluster.push({ segment, lane, lanes: 0 });
    clusterEnd = Math.max(clusterEnd, segment.endMin);
  }

  if (cluster.length) close();

  return out;
}

/** The first event starting on or after `date`, for "Jump to next event". */
export function nextEvent(
  events: CalEvent[],
  after: string,
  zone: string,
): { event: CalEvent; date: string } | undefined {
  let best: { event: CalEvent; date: string; at: number } | undefined;

  for (const event of events) {
    const b = bounds(event, zone);
    if (!b) continue;
    const date = event.allDay ? event.start : wall(b.start, zone).date;
    if (date < after) continue;
    if (!best || b.start < best.at) best = { event, date, at: b.start };
  }

  return best && { event: best.event, date: best.date };
}

/** Days in [from, from + days) that have at least one event, for the day strip's dots. */
export function busyDays(
  events: CalEvent[],
  from: string,
  days: number,
  zone: string,
): Set<string> {
  const out = new Set<string>();
  for (const event of events)
    for (const s of segments(event, from, days, zone)) out.add(s.date);

  return out;
}
