// @wc-ignore-file
/**
 * Agenda (DESIGN.md §5.8): a week strip of day chips with dots for days that
 * have events, above a day-grouped list with sticky day headers. Every row is
 * a button with a complete accessible name, at least 48px tall.
 */
import { accessibleName, relativeDay, type Ctx } from './context.js';
import { agendaDays, busyDays, type CalEvent, type Segment } from './events.js';
import { h } from './ui/dom.js';
import {
  addDays,
  hhmm,
  mondayOf,
  shortDay,
  weekdayLong,
  weekdayShort,
} from './time.js';

export function dayStrip(
  ctx: Ctx,
  events: CalEvent[],
  selected: string,
): HTMLElement {
  const { doc } = ctx;
  const monday = mondayOf(selected);
  const busy = busyDays(events, monday, 7, ctx.zone);

  return h(
    doc,
    'div',
    { class: 'strip', role: 'group', 'aria-label': 'Days of this week' },
    ...Array.from({ length: 7 }, (_, i) => {
      const date = addDays(monday, i);

      return h(
        doc,
        'button',
        {
          class: 'st-d',
          'data-key': `strip-${date}`,
          'aria-current': date === selected ? 'date' : undefined,
          'aria-label': `${weekdayLong(date)} ${Number(date.slice(8))}${busy.has(date) ? ', has events' : ''}${date === ctx.today ? ', today' : ''}`,
          onclick: () => ctx.goTo(date),
        },
        h(doc, 'span', { 'aria-hidden': 'true' }, weekdayShort(date)[0]),
        h(doc, 'b', { 'aria-hidden': 'true' }, String(Number(date.slice(8)))),
        h(doc, 'i', { class: busy.has(date) ? '' : 'off' }),
      );
    }),
  );
}

function row(ctx: Ctx, segment: Segment): HTMLElement {
  const { doc } = ctx;
  const e = segment.event;
  const time = segment.allDay
    ? [h(doc, 'span', {}, 'All day')]
    : [
        h(doc, 'span', {}, hhmm(segment.startMin)),
        h(doc, 'small', {}, hhmm(segment.endMin)),
      ];
  const second = segment.dayOf
    ? `Day ${segment.dayOf.n} of ${segment.dayOf.total}`
    : e.location || e.calendar.name;
  const button = h(
    doc,
    'button',
    {
      class: 'ag-row',
      'data-key': `ev-${e.subject}-${segment.date}`,
      'data-subject': e.subject,
      'aria-label': accessibleName(segment),
      onclick: (event: Event) =>
        ctx.open(e, event.currentTarget as HTMLElement),
    },
    h(doc, 'span', { class: 'ag-time', 'aria-hidden': 'true' }, ...time),
    h(doc, 'span', {
      class: 'sw',
      style: `--c:${e.calendar.color}`,
      'aria-hidden': 'true',
    }),
    h(
      doc,
      'span',
      { class: 'ag-main', 'aria-hidden': 'true' },
      h(doc, 'b', {}, e.title || '(untitled)'),
      h(doc, 'span', {}, second),
      e.pending
        ? h(doc, 'span', { class: 'tagline accent' }, 'Not sent yet')
        : null,
      e.conflict ? h(doc, 'span', { class: 'tagline warn' }, 'Conflict') : null,
    ),
  );

  return h(doc, 'li', {}, button);
}

/** The list from `from` to the end of its week. */
export function agenda(
  ctx: Ctx,
  events: CalEvent[],
  from: string,
): HTMLElement {
  const { doc } = ctx;
  const end = addDays(mondayOf(from), 7);
  const days = agendaDays(
    events,
    from,
    Math.max(1, Math.round((Date.parse(end) - Date.parse(from)) / 86_400_000)),
    ctx.zone,
  );

  return h(
    doc,
    'div',
    { class: 'agenda' },
    ...days.map(day =>
      h(
        doc,
        'section',
        {
          class: 'ag-day',
          'aria-label': `${weekdayLong(day.date)} ${shortDay(day.date).slice(4)}`,
        },
        h(
          doc,
          'h3',
          { class: `ag-dh${day.date === ctx.today ? ' is-today' : ''}` },
          relativeDay(ctx, day.date, weekdayLong(day.date)),
          h(doc, 'span', {}, shortDay(day.date)),
        ),
        day.items.length
          ? h(doc, 'ul', {}, ...day.items.map(s => row(ctx, s)))
          : h(doc, 'p', { class: 'ag-none' }, 'No events'),
      ),
    ),
  );
}
