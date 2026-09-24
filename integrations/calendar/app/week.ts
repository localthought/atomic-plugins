// @wc-ignore-file
/**
 * Week (DESIGN.md §5.7): hour gutter, all-day row with spanning bars, time
 * grid with overlap lanes, now line, today tint, edited (dashed) and
 * conflict ("!") markers. Not an ARIA grid: each day column is a labelled
 * `<section>` with a list of event buttons; a visually hidden "Switch to
 * agenda view" link comes first.
 */
import { accessibleName, type Ctx } from './context.js';
import { packWeek, type Block, type CalEvent } from './events.js';
import { h } from './ui/dom.js';
import { hhmm, longDay, offsetLabel, wall, weekdayShort } from './time.js';

/** One hour, px. */
export const ROW = 44;
const GUTTER = 52;
/** Narrower than this per lane, overlapping events collapse into "+N". */
const MIN_LANE = 44;

/**
 * Where the week grid starts scrolled (DESIGN.md §5.7): 08:00, so the
 * working day shows, unless now is outside 08:00–18:00; then one hour
 * before now.
 */
export function firstHour(nowMinutes: number): number {
  const hour = Math.floor(nowMinutes / 60);

  return hour >= 8 && hour < 18 ? 8 : Math.max(0, hour - 1);
}

/** 3, 5 or 7 days by frame width (DESIGN.md §8). */
export function dayCount(width: number): number {
  if (width < 560) return 3;
  if (width < 720) return 5;

  return 7;
}

function block(ctx: Ctx, b: Block, lanes: number, left: number): HTMLElement {
  const { doc } = ctx;
  const s = b.segment;
  const e = s.event;
  const top = (s.startMin / 60) * ROW;
  const height = Math.max(((s.endMin - s.startMin) / 60) * ROW, 16);
  const short = s.endMin - s.startMin < 30;
  const width = `calc(${100 / lanes}% - 4px)`;
  const meta = [`${hhmm(s.startMin)}–${hhmm(s.endMin)}`, e.location]
    .filter(Boolean)
    .join(' · ');

  return h(
    doc,
    'li',
    {},
    h(
      doc,
      'button',
      {
        class: `ev${short ? ' ev-short' : ''}${e.pending ? ' ev-edited' : ''}`,
        style: `--c:${e.calendar.color};top:${top + 1}px;height:${height - 2}px;left:calc(${(100 / lanes) * left}% + 2px);width:${width}`,
        'data-key': `ev-${e.subject}-${s.date}`,
        'data-subject': e.subject,
        'aria-label': accessibleName(s),
        onclick: (event: Event) =>
          ctx.open(e, event.currentTarget as HTMLElement),
      },
      h(
        doc,
        'span',
        { class: 'ev-t', 'aria-hidden': 'true' },
        e.title || '(untitled)',
      ),
      short
        ? null
        : h(doc, 'span', { class: 'ev-m', 'aria-hidden': 'true' }, meta),
      e.conflict
        ? h(doc, 'span', { class: 'ev-badge', 'aria-hidden': 'true' }, '!')
        : e.pending
          ? h(doc, 'span', { class: 'ev-dot', 'aria-hidden': 'true' })
          : null,
    ),
  );
}

function column(
  ctx: Ctx,
  date: string,
  blocks: Block[],
  maxLanes: number,
): HTMLElement {
  const { doc } = ctx;
  const items: HTMLElement[] = [];
  const byCluster = new Map<number, Block[]>();

  for (const b of blocks) {
    const list = byCluster.get(b.cluster) ?? [];
    list.push(b);
    byCluster.set(b.cluster, list);
  }

  for (const cluster of byCluster.values()) {
    const lanes = cluster[0].lanes;

    if (lanes <= maxLanes) {
      for (const b of cluster) items.push(block(ctx, b, lanes, b.lane));
      continue;
    }

    // Too narrow: keep the first lanes, fold the rest into one "+N".
    const keep = Math.max(1, maxLanes - 1);
    const shown = cluster.filter(b => b.lane < keep);
    const folded = cluster.filter(b => b.lane >= keep);
    for (const b of shown) items.push(block(ctx, b, keep + 1, b.lane));
    const start = Math.min(...folded.map(b => b.segment.startMin));
    items.push(
      h(
        doc,
        'li',
        {},
        h(
          doc,
          'button',
          {
            class: 'ev-more',
            style: `top:${(start / 60) * ROW + 1}px;height:22px;left:calc(${(100 / (keep + 1)) * keep}% + 2px);width:calc(${100 / (keep + 1)}% - 4px)`,
            'data-key': `more-${date}-${start}`,
            'aria-label': `${folded.length} more ${folded.length === 1 ? 'event' : 'events'} on ${longDay(date)}: show in agenda`,
            onclick: () => {
              ctx.goTo(date);
              ctx.setView('agenda');
            },
          },
          `+${folded.length}`,
        ),
      ),
    );
  }

  const isToday = date === ctx.today;
  const now = wall(ctx.now, ctx.zone);

  return h(
    doc,
    'section',
    {
      class: `wk-col${isToday ? ' is-today' : ''}`,
      'aria-label': longDay(date),
    },
    h(doc, 'h3', { class: 'sr-only' }, longDay(date)),
    isToday && now.date === date
      ? h(doc, 'div', {
          class: 'now',
          style: `top:${(now.minutes / 60) * ROW}px`,
          'aria-hidden': 'true',
        })
      : null,
    items.length ? h(doc, 'ul', {}, ...items) : null,
  );
}

export function week(
  ctx: Ctx,
  events: CalEvent[],
  from: string,
  count: number,
  gridWidth: number,
): HTMLElement {
  const { doc } = ctx;
  const layout = packWeek(events, from, count, ctx.zone);
  const colWidth = (gridWidth - GUTTER) / count;
  const maxLanes = Math.max(1, Math.floor(colWidth / MIN_LANE));
  const template = `--n:${count}`;
  const rows = Math.max(layout.rows, 1);

  const head = h(
    doc,
    'div',
    { class: 'wk-head', 'aria-hidden': 'true' },
    h(doc, 'div', { class: 'wk-tz' }, offsetLabel(ctx.now, ctx.zone)),
    ...layout.days.map(date =>
      h(
        doc,
        'div',
        { class: `wk-dh${date === ctx.today ? ' is-today' : ''}` },
        h(doc, 'span', {}, weekdayShort(date)),
        h(doc, 'b', {}, String(Number(date.slice(8)))),
      ),
    ),
  );

  const allDay = h(
    doc,
    'div',
    {
      class: 'wk-all',
      role: 'group',
      'aria-label': 'All-day events',
      style: `grid-template-rows:repeat(${rows}, 22px)`,
    },
    h(
      doc,
      'div',
      { class: 'wk-tz', style: `grid-row:1 / span ${rows}` },
      'all-day',
    ),
    ...layout.bars.map(bar =>
      h(
        doc,
        'button',
        {
          class: `ad${bar.event.pending ? ' ev-edited' : ''}`,
          style: `--c:${bar.event.calendar.color};grid-column:${bar.col + 2} / span ${bar.span};grid-row:${bar.row + 1}`,
          'data-key': `ad-${bar.event.subject}`,
          'data-subject': bar.event.subject,
          'aria-label': accessibleName({
            event: bar.event,
            date: layout.days[bar.col],
            allDay: true,
            startMin: 0,
            endMin: 1440,
          }),
          onclick: (event: Event) =>
            ctx.open(bar.event, event.currentTarget as HTMLElement),
        },
        `${bar.event.title || '(untitled)'}${bar.event.location ? ` · ${bar.event.location}` : ''}`,
      ),
    ),
  );

  const hours = h(
    doc,
    'div',
    { class: 'wk-hours', 'aria-hidden': 'true' },
    ...Array.from({ length: 24 }, (_, i) =>
      h(doc, 'div', { class: 'wk-h' }, h(doc, 'span', {}, hhmm(i * 60))),
    ),
  );

  const body = h(
    doc,
    'div',
    { class: 'wk-body' },
    hours,
    ...layout.days.map((date, i) =>
      column(ctx, date, layout.columns[i], maxLanes),
    ),
  );

  return h(
    doc,
    'div',
    { class: 'wk', style: template },
    h(
      doc,
      'button',
      {
        class: 'sr-only sr-only-focusable link',
        'data-key': 'to-agenda',
        onclick: () => ctx.setView('agenda'),
      },
      'Switch to agenda view',
    ),
    head,
    allDay,
    h(doc, 'div', { class: 'wk-scroll', 'data-scroll': 'week' }, body),
  );
}
