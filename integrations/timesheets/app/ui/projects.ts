// @wc-ignore-file
/**
 * Projects view (#89 frame C): the whole import window, one row per project
 * with a bar scaled to the largest (solid part billable), its total and its
 * share of the window with one decimal.
 */
import { formatDuration, spokenDuration } from '../model/time.js';
import { formatShare, type ProjectSummary } from '../model/views.js';
import type { H } from './dom.js';
import { duration, projectCell } from './week.js';

export function projectsView(h: H, summary: ProjectSummary) {
  const stat = (label: string, ms: number) =>
    h(
      'div',
      null,
      h('small', null, label),
      h('strong', null, ...duration(h, ms)),
    );

  return [
    h(
      'div',
      { class: 'sumline' },
      stat('Total', summary.total),
      stat('Billable', summary.billable),
      stat('Not billable', summary.notBillable),
    ),
    h(
      'ul',
      {
        class: 'card',
        style: 'list-style: none; margin: 0; padding: 0',
        'aria-label': 'Time per project',
      },
      ...summary.rows.map(row => {
        const color = row.project?.color;
        const fill = color ? `background: ${color}; ` : '';

        return h(
          'li',
          { class: 'prow' },
          projectCell(h, row.project),
          h(
            'div',
            { class: 'track', 'aria-hidden': 'true' },
            h('i', { class: 'all', style: `${fill}width: ${row.barPercent}%` }),
            row.billable
              ? h('i', { style: `${fill}width: ${row.billableBarPercent}%` })
              : null,
          ),
          h(
            'span',
            { class: 'num' },
            h('span', { 'aria-hidden': 'true' }, formatDuration(row.total)),
            h(
              'span',
              { class: 'sr' },
              `${spokenDuration(row.total)}, of which ${spokenDuration(row.billable)} billable, `,
            ),
          ),
          h('span', { class: 'num pct' }, formatShare(row.shareTenths)),
        );
      }),
    ),
    h(
      'div',
      { class: 'legend', 'aria-hidden': 'true' },
      h('span', null, h('i'), 'Billable'),
      h('span', null, h('i', { class: 'a' }), 'Not billable'),
    ),
  ];
}
