// @wc-ignore-file
/**
 * Entries view (#89 frame B) and the narrow week strip (frame E): day cards,
 * newest day first, each entry a button that opens the detail drawer.
 */
import {
  dayKey,
  dayOfMonth,
  formatDay,
  formatDuration,
  formatTime,
  longWeekday,
  shortWeekday,
  spokenDuration,
  type DayKey,
} from '../model/time.js';
import type { TimeEntry } from '../model/types.js';
import {
  NO_PROJECT,
  projectLabel,
  type DayGroup,
  type GridDay,
} from '../model/views.js';
import type { H } from './dom.js';
import { dot, duration } from './week.js';

export interface Highlight {
  day: DayKey;
  projectKey: string;
}

export interface DayCardProps {
  timeZone: string;
  today: DayKey;
  /** Stacked rows (narrow frames). */
  stack: boolean;
  highlight?: Highlight | undefined;
  onOpen: (entry: TimeEntry) => void;
  /** Extra attributes for the card (the narrow strip's tabpanel). */
  attrs?: Record<string, string>;
}

const dayTitle = (key: DayKey, today: DayKey, stack: boolean) =>
  key === today && stack
    ? `Today, ${formatDay(key)}`
    : `${longWeekday(key)} ${formatDay(key)}`;

export function entryRow(h: H, entry: TimeEntry, p: DayCardProps) {
  const projectKey = entry.project?.id ?? NO_PROJECT;
  const lit =
    p.highlight &&
    p.highlight.projectKey === projectKey &&
    p.highlight.day === dayKey(entry.start, p.timeZone);
  const range = `${formatTime(entry.start, p.timeZone)} – ${formatTime(entry.end, p.timeZone)}`;
  const label = projectLabel(entry.project);
  const row = h(
    'button',
    {
      type: 'button',
      class: `entry${lit ? ' hl' : ''}`,
      'data-k': `entry:${entry.id}`,
      'data-entry': entry.id,
    },
    entry.description
      ? h('span', { class: 'desc' }, entry.description)
      : h('span', { class: 'desc muted' }, '(no description)'),
    h(
      'span',
      { class: 'pj' },
      dot(h, entry.project),
      h(
        'span',
        null,
        label,
        p.stack && entry.billable
          ? [
              h('span', { 'aria-hidden': 'true' }, ' · $'),
              h('span', { class: 'sr' }, ', billable'),
            ]
          : null,
      ),
    ),
    h(
      'span',
      { class: 'bill' },
      entry.billable
        ? [
            h('span', { 'aria-hidden': 'true', title: 'Billable' }, '$'),
            h('span', { class: 'sr' }, 'Billable'),
          ]
        : null,
    ),
    h('span', { class: 'rng' }, range),
    h(
      'span',
      { class: 'dur' },
      h(
        'span',
        { 'aria-hidden': 'true' },
        formatDuration(entry.end - entry.start),
      ),
      h('span', { class: 'sr' }, spokenDuration(entry.end - entry.start)),
    ),
  );
  row.addEventListener('click', () => p.onOpen(entry));

  return row;
}

export function dayCard(h: H, group: DayGroup, p: DayCardProps) {
  return h(
    'section',
    {
      class: `card day${p.stack ? ' stack' : ''}`,
      'data-day': group.key,
      'aria-label': dayTitle(group.key, p.today, false),
      ...(p.attrs ?? {}),
    },
    h(
      'div',
      { class: 'dayhead' },
      h('h3', null, dayTitle(group.key, p.today, p.stack)),
      h('span', { class: 'num' }, ...duration(h, group.total)),
    ),
    ...group.entries.map(e => entryRow(h, e, p)),
  );
}

export function dayCards(h: H, groups: DayGroup[], p: DayCardProps) {
  if (!groups.length)
    return [
      h(
        'p',
        { class: 'muted', style: 'margin: 8px 2px' },
        'No completed entries this week.',
      ),
    ];

  return groups.map(g => dayCard(h, g, p));
}

/** The seven-day strip (a tablist) over the selected day's entries. */
export function weekStrip(
  h: H,
  days: GridDay[],
  totals: number[],
  selected: DayKey,
  onSelect: (day: DayKey) => void,
) {
  const tabs = days.map((day, i) => {
    const tab = h(
      'button',
      {
        type: 'button',
        role: 'tab',
        id: `tab-${day.key}`,
        'aria-selected': day.key === selected ? 'true' : 'false',
        'aria-controls': 'day-panel',
        tabindex: day.key === selected ? '0' : '-1',
        disabled: day.isFuture,
        'data-k': `tab:${day.key}`,
        'aria-label': `${longWeekday(day.key)} ${formatDay(day.key)}, ${
          totals[i] ? spokenDuration(totals[i]) : 'no entries'
        }${day.inWindow ? '' : ', outside import window'}`,
      },
      h(
        'span',
        { class: 'wd', 'aria-hidden': 'true' },
        shortWeekday(day.key).slice(0, 1),
      ),
      h(
        'span',
        { class: 'dd', 'aria-hidden': 'true' },
        String(dayOfMonth(day.key)),
      ),
      h(
        'span',
        { class: 't', 'aria-hidden': 'true' },
        totals[i] ? formatDuration(totals[i]) : '–',
      ),
    );
    tab.addEventListener('click', () => onSelect(day.key));

    return tab;
  });
  const strip = h(
    'div',
    { class: 'strip', role: 'tablist', 'aria-label': 'Days' },
    ...tabs,
  );

  // Arrow keys move between enabled tabs (the tablist pattern).
  strip.addEventListener('keydown', event => {
    const keys: Record<string, number> = { ArrowRight: 1, ArrowLeft: -1 };
    const step = keys[event.key];
    if (!step) return;
    const enabled = days.filter(d => !d.isFuture).map(d => d.key);
    const at = enabled.indexOf(selected);
    const next = enabled[(at + step + enabled.length) % enabled.length];
    if (!next) return;
    event.preventDefault();
    onSelect(next);
  });

  return strip;
}
