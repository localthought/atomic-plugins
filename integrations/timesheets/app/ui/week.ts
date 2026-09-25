// @wc-ignore-file
/**
 * Week view (#89 frames A, L, O): a project × day `<table>`, today tinted,
 * zero as a muted en dash, row and day totals, days before the import
 * window hatched. A non-empty cell is a button that opens Entries at that
 * day with the project's rows highlighted.
 */
import {
  dayOfMonth,
  formatDay,
  formatDuration,
  formatRange,
  longWeekday,
  shortWeekday,
  spokenDuration,
  type DayKey,
  type Week,
} from '../model/time.js';
import type { Project } from '../model/types.js';
import { projectLabel, type WeekGrid } from '../model/views.js';
import type { H } from './dom.js';

/** Visible `h:mm` plus a spoken form for screen readers. */
export const duration = (h: H, ms: number) => [
  h('span', { 'aria-hidden': 'true' }, formatDuration(ms)),
  h('span', { class: 'sr' }, spokenDuration(ms)),
];

export function dot(h: H, project: Project | undefined) {
  return h('span', {
    class: `dot${project ? '' : ' none'}`,
    // `color` is checked to be `#hex` in model/source.ts.
    style: project?.color ? `background: ${project.color}` : undefined,
    'aria-hidden': 'true',
  });
}

export function projectCell(h: H, project: Project | undefined) {
  return h(
    'div',
    { class: 'proj' },
    dot(h, project),
    h(
      'span',
      null,
      projectLabel(project),
      project?.client ? h('small', null, project.client) : null,
    ),
  );
}

export interface WeekProps {
  grid: WeekGrid;
  week: Week;
  onCell: (day: DayKey, projectKey: string) => void;
}

export function weekTable(h: H, { grid, week, onCell }: WeekProps) {
  const range = formatRange(week.days[0], week.days[6]);
  const dayClass = (i: number) =>
    [
      grid.days[i].isToday ? 'today' : '',
      grid.days[i].isFuture ? 'future' : '',
      grid.days[i].inWindow ? '' : 'out',
    ]
      .filter(Boolean)
      .join(' ') || undefined;
  const zero = (i: number | undefined, extra = '') =>
    h(
      'td',
      {
        class:
          [i === undefined ? '' : dayClass(i), 'z', extra]
            .filter(Boolean)
            .join(' ') || undefined,
      },
      h('span', { 'aria-hidden': 'true' }, '–'),
      h('span', { class: 'sr' }, 'none'),
    );

  return h(
    'div',
    { class: 'card gridwrap' },
    h(
      'table',
      { class: 'week' },
      h('caption', { class: 'sr' }, `Hours per project, ${range}`),
      h(
        'thead',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'col' }, 'Project'),
          ...grid.days.map((day, i) =>
            h(
              'th',
              {
                scope: 'col',
                class: dayClass(i),
                'aria-label': `${longWeekday(day.key)} ${formatDay(day.key)}${
                  day.isToday ? ', today' : ''
                }${day.inWindow ? '' : ', outside import window'}`,
              },
              h(
                'span',
                { class: 'wd' },
                day.isToday ? 'Today' : shortWeekday(day.key),
              ),
              h('span', { class: 'dd' }, String(dayOfMonth(day.key))),
            ),
          ),
          h('th', { scope: 'col', class: 'tot' }, 'Total'),
        ),
      ),
      h(
        'tbody',
        null,
        ...grid.rows.map(row =>
          h(
            'tr',
            null,
            h('th', { scope: 'row' }, projectCell(h, row.project)),
            ...row.cells.map((ms, i) => {
              if (!ms) return zero(i);
              const button = h(
                'button',
                {
                  type: 'button',
                  'data-k': `cell:${row.key}:${grid.days[i].key}`,
                },
                ...duration(h, ms),
              );
              button.addEventListener('click', () =>
                onCell(grid.days[i].key, row.key),
              );

              return h('td', { class: dayClass(i) }, button);
            }),
            h('td', { class: 'tot' }, ...duration(h, row.total)),
          ),
        ),
      ),
      h(
        'tfoot',
        null,
        h(
          'tr',
          null,
          h('th', { scope: 'row' }, 'Day total'),
          ...grid.dayTotals.map((ms, i) =>
            ms ? h('td', { class: dayClass(i) }, ...duration(h, ms)) : zero(i),
          ),
          h('td', { class: 'tot' }, ...duration(h, grid.total)),
        ),
      ),
    ),
  );
}

export function weekFoot(h: H, grid: WeekGrid, timeZone: string) {
  return h(
    'div',
    { class: 'foot' },
    h('span', null, 'Billable ', h('b', null, formatDuration(grid.billable))),
    h(
      'span',
      null,
      'Not billable ',
      h('b', null, formatDuration(grid.notBillable)),
    ),
    h('span', null, `Times in ${timeZone}`),
  );
}

export function runningNote(h: H, running: number) {
  if (!running) return null;

  return h(
    'div',
    { class: 'note' },
    h('span', { class: 'ring', 'aria-hidden': 'true' }),
    running === 1
      ? '1 timer is running in Clockify. It appears here after you stop it and sync.'
      : `${running} timers are running in Clockify. They appear here after you stop them and sync.`,
  );
}
