// @wc-ignore-file
/**
 * The Transactions tab (DESIGN.md 6.1, 6.6, 6.8, 6.10): first run, summary
 * strip, filters, the day-grouped ledger (a table at ≥560px, a list of
 * buttons below) and the no-results state. Pure: state in, nodes out.
 */
import {
  amountLabel,
  formatAmount,
  groupByDay,
  isOut,
  totals,
  type Money,
  type Totals,
} from './amounts.js';
import type { State } from './controller.js';
import {
  count,
  dayLabel,
  groupAccount,
  periodLabel,
  plural,
  shortAccount,
} from './format.js';
import {
  accountKey,
  accounts,
  applyFilters,
  filterExceptAccount,
  sortNewestFirst,
  type Filters,
  type PeriodKind,
} from './ledger.js';
import { canAnnotate, type Txn } from './rows.js';
import { button, chip, empty } from './ui/components.js';
import { h, icons } from './ui/dom.js';
import { detail, type DetailActions } from './viewDetail.js';

export interface LedgerActions extends DetailActions {
  setFilters(patch: Partial<Filters>): void;
  clearFilters(): void;
  showMore(): void;
  select(subject: string | undefined): void;
  chooseFile(): void;
}

export interface Ctx {
  state: State;
  width: number;
  locale?: string;
  today: string;
}

export const narrow = (width: number) => width < 560;

export interface Derived {
  filtered: Txn[];
  visible: Txn[];
  strip: Totals[];
  uncategorised: number;
}

export function derive(state: State, today: string): Derived {
  const except = filterExceptAccount(state.rows, state.filters, today);
  const filtered = sortNewestFirst(
    applyFilters(state.rows, state.filters, today),
  );
  const found = new Map(
    totals(except).map(t => [accountKey(t.account, t.currency), t]),
  );
  // Every account keeps its segment, at zero when the filters leave it empty.
  const strip = accounts(state.rows).map(
    a =>
      found.get(a.key) ?? {
        account: a.account,
        currency: a.currency,
        in: '0',
        out: '0',
        net: '0',
        count: 0,
      },
  );
  const uncategorised = applyFilters(
    state.rows,
    { ...state.filters, uncategorised: false },
    today,
  ).filter(row => !row.category).length;

  return {
    filtered,
    visible: filtered.slice(0, state.limit),
    strip,
    uncategorised,
  };
}

/** The narrative's first line stands in for a counterparty (gap 6). */
export function titleOf(row: { description: string; reference: string }): {
  title: string;
  rest: string;
} {
  const lines = row.description
    .split('\n')
    .map(l => l.trim())
    .filter(Boolean);

  return {
    title: lines[0] || row.reference || 'Transaction',
    rest: lines.slice(1).join(' '),
  };
}

export function amountNode(
  amount: string,
  currency: string,
  locale: string | undefined,
  {
    symbol = true,
    suffix = false,
    sign = 'always' as 'always' | 'negative',
  } = {},
): HTMLElement {
  return h(
    'span',
    {
      class: 'm-amt',
      'data-dir': isOut(amount) ? 'out' : 'in',
      'aria-label': amountLabel(amount, currency, locale ?? 'en'),
    },
    formatAmount(amount, currency, locale, { symbol, sign }),
    suffix ? h('small', {}, currency) : undefined,
  );
}

const netText = (net: Money[], locale?: string) =>
  net.map(m => formatAmount(m.amount, m.currency, locale)).join(' · ');

export function firstRun(ctx: Ctx, actions: LedgerActions): HTMLElement {
  return empty({
    heading: 'Bring in your bank transactions',
    text: 'Export a statement from your bank as MT940 or camt.053 and drop it here. The file is checked in your browser and stored only in this Atomic Server.',
    extra: [
      h(
        'div',
        { class: 'm-drop' },
        button([icons.upload(), 'Choose statement file'], {
          variant: 'primary',
          onClick: actions.chooseFile,
          key: 'first-run-choose',
        }),
        h(
          'span',
          { class: 'm-formats' },
          'or drop it here · MT940 up to 512 KB · camt.053 XML up to 5 MB · up to 500 transactions',
        ),
      ),
      exportHelp(),
      h(
        'div',
        { class: 'm-sources-mini' },
        sourceRow({
          logo: 'MB',
          name: 'Moneybird',
          why: 'Read your financial mutations alongside bank statements. Not available yet.',
          action: button('Connect', { disabled: true }),
        }),
      ),
    ],
  });
}

export function exportHelp(): HTMLElement {
  return h(
    'details',
    { class: 'm-help' },
    h('summary', {}, 'How do I export a statement?'),
    h(
      'ul',
      {},
      h(
        'li',
        {},
        h('b', {}, 'bunq'),
        ': account → Settings → Export statement → MT940.',
      ),
      h(
        'li',
        {},
        h('b', {}, 'ING, Rabobank, ABN AMRO'),
        ': download transactions → choose MT940 or camt.053. Menu names differ per bank.',
      ),
    ),
  );
}

export function sourceRow({
  logo,
  name,
  tag,
  why,
  action,
}: {
  logo: string;
  name: string;
  tag?: string;
  why: string;
  action?: Node;
}): HTMLElement {
  return h(
    'div',
    { class: 'm-src' },
    h('span', { class: 'm-logo', 'aria-hidden': 'true' }, logo),
    h(
      'span',
      { class: 'm-grow' },
      h(
        'span',
        { class: 'm-name' },
        name,
        tag ? h('span', { class: 'm-tag' }, tag) : undefined,
      ),
      h('span', { class: 'm-why' }, why),
    ),
    action,
  );
}

export function accountSwitcher(
  ctx: Ctx,
  actions: LedgerActions,
): HTMLSelectElement {
  const list = accounts(ctx.state.rows);
  const short = narrow(ctx.width);

  return h(
    'select',
    {
      class: 'm-switcher',
      'aria-label': 'Account',
      'data-key': 'account',
      onchange: (event: Event) =>
        actions.setFilters({
          account: (event.target as HTMLSelectElement).value,
        }),
    },
    h(
      'option',
      { value: '', selected: ctx.state.filters.account === '' },
      `All accounts · ${list.length}`,
    ),
    list.map(a =>
      h(
        'option',
        { value: a.key, selected: ctx.state.filters.account === a.key },
        `${short ? shortAccount(a.account) : groupAccount(a.account)} · ${a.currency}`,
      ),
    ),
  );
}

function stripView(ctx: Ctx, derived: Derived, actions: LedgerActions) {
  const { state, locale, today } = ctx;
  const short = narrow(ctx.width);
  const period = periodLabel(state.filters.period, today, locale);

  return h(
    'div',
    {
      class: 'm-strip',
      role: 'group',
      'aria-label': `Accounts, ${period}`,
      'data-scroll-key': 'strip',
    },
    derived.strip.map(t => {
      const key = accountKey(t.account, t.currency);
      const pressed = state.filters.account === key;

      return h(
        'button',
        {
          type: 'button',
          class: 'm-seg',
          'aria-pressed': String(pressed),
          'data-key': `seg-${key}`,
          onclick: () => actions.setFilters({ account: pressed ? '' : key }),
        },
        h(
          'span',
          { class: 'm-acct pl-num' },
          `${short ? shortAccount(t.account) : groupAccount(t.account)} · ${t.currency}`,
        ),
        h(
          'span',
          { class: 'm-net' },
          formatAmount(t.net, t.currency, locale),
          h('small', {}, 'net'),
        ),
        h(
          'span',
          { class: 'm-flow pl-num' },
          h(
            'span',
            { class: 'm-amt', 'data-dir': 'in' },
            `${formatAmount(t.in, t.currency, locale)} in`,
          ),
          h(
            'span',
            {},
            `${formatAmount(t.out, t.currency, locale, { sign: 'negative' })} out`,
          ),
        ),
      );
    }),
  );
}

const PERIODS: [PeriodKind, string][] = [
  ['this-month', 'This month'],
  ['last-month', 'Last month'],
  ['this-year', 'This year'],
  ['custom', 'Custom…'],
];

function filters(ctx: Ctx, derived: Derived, actions: LedgerActions) {
  const { state } = ctx;
  const f = state.filters;
  const period = f.period;

  return h(
    'div',
    { class: 'm-filters' },
    h(
      'label',
      { class: 'm-search' },
      icons.search(),
      h('input', {
        type: 'search',
        placeholder: narrow(ctx.width)
          ? 'Search'
          : 'Search description or reference',
        'aria-label': 'Search transactions',
        'aria-keyshortcuts': '/',
        value: f.query,
        'data-key': 'search',
        oninput: (event: Event) =>
          actions.setFilters({
            query: (event.target as HTMLInputElement).value,
          }),
      }),
      h('kbd', { 'aria-hidden': 'true' }, '/'),
    ),
    h(
      'div',
      { class: 'm-chiprow', 'data-scroll-key': 'chips' },
      h(
        'div',
        { class: 'pl-chips', role: 'group', 'aria-label': 'Period' },
        PERIODS.map(([kind, label]) =>
          chip(
            label,
            period.kind === kind,
            () =>
              actions.setFilters({
                period:
                  period.kind === kind
                    ? { kind: 'all' }
                    : kind === 'custom'
                      ? { kind, from: '', to: '' }
                      : { kind },
              }),
            `period-${kind}`,
          ),
        ),
      ),
      period.kind === 'custom'
        ? h(
            'div',
            { class: 'm-custom' },
            h(
              'label',
              {},
              'From ',
              h('input', {
                type: 'date',
                value: period.from ?? '',
                'data-key': 'custom-from',
                onchange: (event: Event) =>
                  actions.setFilters({
                    period: {
                      ...period,
                      from: (event.target as HTMLInputElement).value,
                    },
                  }),
              }),
            ),
            h(
              'label',
              {},
              'to ',
              h('input', {
                type: 'date',
                value: period.to ?? '',
                'data-key': 'custom-to',
                onchange: (event: Event) =>
                  actions.setFilters({
                    period: {
                      ...period,
                      to: (event.target as HTMLInputElement).value,
                    },
                  }),
              }),
            ),
          )
        : undefined,
      h('span', { class: 'm-sep', 'aria-hidden': 'true' }),
      h(
        'div',
        { class: 'pl-chips', role: 'group', 'aria-label': 'Direction' },
        (
          [
            ['all', 'All'],
            ['in', 'In'],
            ['out', 'Out'],
          ] as const
        ).map(([direction, label]) =>
          chip(
            label,
            f.direction === direction,
            () => actions.setFilters({ direction }),
            `direction-${direction}`,
          ),
        ),
      ),
      canAnnotate(state.fields)
        ? chip(
            `Uncategorised · ${count(derived.uncategorised, ctx.locale)}`,
            f.uncategorised,
            () => actions.setFilters({ uncategorised: !f.uncategorised }),
            'uncategorised',
          )
        : undefined,
      f.statement
        ? chip(
            `Statement ${f.statement.statement} ✕`,
            true,
            () => actions.setFilters({ statement: undefined }),
            'statement',
          )
        : undefined,
    ),
  );
}

function caption(ctx: Ctx, derived: Derived): string {
  const { state, locale, today } = ctx;
  const account = state.filters.account
    ? accounts(state.rows).find(a => a.key === state.filters.account)
    : undefined;

  return [
    account
      ? `${groupAccount(account.account)} · ${account.currency}`
      : 'All accounts',
    periodLabel(state.filters.period, today, locale).replace(/^all/, 'All'),
    plural(derived.filtered.length, 'transaction', 'transactions', locale),
  ].join(' · ');
}

function noResults(ctx: Ctx, actions: LedgerActions): HTMLElement {
  const { filters: f } = ctx.state;
  const period = periodLabel(f.period, ctx.today, ctx.locale);
  const where = f.period.kind === 'all' ? '' : ` in ${period}`;
  const text = f.query.trim()
    ? `No transactions match “${f.query.trim()}”${where}.`
    : `No transactions${where} for these filters.`;

  return empty({
    text,
    action: button('Clear filters', {
      onClick: actions.clearFilters,
      key: 'clear-filters',
    }),
    secondary:
      f.period.kind !== 'all'
        ? button('Search all periods', {
            variant: 'ghost',
            onClick: () => actions.setFilters({ period: { kind: 'all' } }),
            key: 'all-periods',
          })
        : undefined,
  });
}

function table(ctx: Ctx, derived: Derived, actions: LedgerActions) {
  const { state, locale } = ctx;
  const notes = canAnnotate(state.fields);
  const days = groupByDay(derived.visible);
  const columns = notes ? 4 : 3;
  const focusable =
    derived.visible.find(r => r.subject === state.selected)?.subject ??
    derived.visible[0]?.subject;

  return h(
    'table',
    { class: 'm-ledger' },
    h('caption', {}, caption(ctx, derived)),
    h(
      'thead',
      {},
      h(
        'tr',
        {},
        h('th', { scope: 'col', style: 'width: 44%' }, 'Description'),
        notes ? h('th', { scope: 'col' }, 'Category') : undefined,
        h('th', { scope: 'col' }, 'Account'),
        h('th', { scope: 'col' }, 'Amount'),
      ),
    ),
    days.map(day =>
      h(
        'tbody',
        {},
        h(
          'tr',
          { class: 'm-day' },
          h(
            'th',
            { colspan: String(columns), scope: 'rowgroup' },
            dayLabel(day.date, locale),
            h('span', { class: 'pl-num' }, netText(day.net, locale)),
          ),
        ),
        day.rows.map(row => {
          const { title, rest } = titleOf(row);
          const selected = row.subject === state.selected;

          return h(
            'tr',
            {
              class: 'm-row',
              'aria-selected': String(selected),
              onclick: () => actions.select(row.subject),
            },
            h(
              'td',
              { class: 'm-desc' },
              h(
                'button',
                {
                  type: 'button',
                  class: 'm-rowbtn',
                  'data-key': `row-${row.subject}`,
                  'data-row': row.subject,
                  tabindex: row.subject === focusable ? '0' : '-1',
                  'aria-expanded': String(selected),
                },
                h('b', {}, title),
                rest ? h('span', { class: 'm-rest' }, rest) : undefined,
              ),
            ),
            notes ? h('td', {}, categoryChip(row.category)) : undefined,
            h('td', { class: 'm-acctcell' }, shortAccount(row.account)),
            h('td', {}, amountNode(row.amount, row.currency, locale)),
          );
        }),
      ),
    ),
  );
}

export const categoryChip = (category: string) =>
  category
    ? h('span', { class: 'm-cat' }, category)
    : h('span', { class: 'm-cat', 'data-none': true }, 'Uncategorised');

function listView(ctx: Ctx, derived: Derived, actions: LedgerActions) {
  const { state, locale } = ctx;
  const notes = canAnnotate(state.fields);
  const focusable =
    derived.visible.find(r => r.subject === state.selected)?.subject ??
    derived.visible[0]?.subject;

  return h(
    'ul',
    { class: 'm-list', 'aria-label': caption(ctx, derived) },
    groupByDay(derived.visible).map(day => [
      h(
        'li',
        { class: 'm-dayh', role: 'presentation' },
        dayLabel(day.date, locale),
        h('span', { class: 'pl-num' }, netText(day.net, locale)),
      ),
      day.rows.map(row => {
        const { title } = titleOf(row);

        return h(
          'li',
          {},
          h(
            'button',
            {
              type: 'button',
              class: 'm-item',
              'data-key': `row-${row.subject}`,
              'data-row': row.subject,
              tabindex: row.subject === focusable ? '0' : '-1',
              'aria-current':
                row.subject === state.selected ? 'true' : undefined,
              onclick: () => actions.select(row.subject),
            },
            h('span', { class: 'm-t' }, title),
            amountNode(row.amount, row.currency, locale, {
              symbol: false,
              suffix: true,
            }),
            h(
              'span',
              { class: 'm-s' },
              notes ? categoryChip(row.category) : undefined,
              row.note
                ? h('span', {}, row.note.split('\n')[0])
                : !notes
                  ? h('span', {}, shortAccount(row.account))
                  : undefined,
            ),
          ),
        );
      }),
    ]),
  );
}

export function transactions(ctx: Ctx, actions: LedgerActions): HTMLElement[] {
  const main = ledger(ctx, actions);
  const row = ctx.state.rows.find(r => r.subject === ctx.state.selected);
  if (!row) return main;
  const panel = detail(ctx, row, actions);

  return panel.mode === 'side'
    ? [
        h(
          'div',
          { class: 'm-split' },
          h('div', { class: 'm-main' }, main),
          panel.nodes,
        ),
      ]
    : [...main, ...panel.nodes];
}

function ledger(ctx: Ctx, actions: LedgerActions): HTMLElement[] {
  const derived = derive(ctx.state, ctx.today);
  const more = derived.filtered.length - derived.visible.length;
  // The strip sums what the filters let through; with nothing through it
  // would be a row of zeros above the no-results message.
  const body: HTMLElement[] = derived.filtered.length
    ? [stripView(ctx, derived, actions), filters(ctx, derived, actions)]
    : [filters(ctx, derived, actions)];

  if (!derived.filtered.length) body.push(noResults(ctx, actions));
  else {
    body.push(
      narrow(ctx.width)
        ? listView(ctx, derived, actions)
        : table(ctx, derived, actions),
    );
    if (more > 0)
      body.push(
        h(
          'div',
          { class: 'm-more' },
          button('Show earlier transactions', {
            onClick: actions.showMore,
            key: 'show-more',
          }),
          h(
            'span',
            { class: 'pl-muted' },
            `${count(derived.visible.length, ctx.locale)} of ${count(derived.filtered.length, ctx.locale)} shown`,
          ),
        ),
      );
  }

  return body;
}
