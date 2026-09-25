// @wc-ignore-file
/**
 * The Imports tab (issues.md M-11): one row per statement the table's rows
 * came from. Selecting one shows its transactions.
 */
import { formatAmount, totals } from './amounts.js';
import type { StoredStatement } from './rows.js';
import {
  count,
  formatLabel,
  fullDate,
  groupAccount,
  rangeLabel,
  shortAccount,
} from './format.js';
import { importedStatements, type StatementKey } from './ledger.js';
import { narrow, type Ctx } from './viewLedger.js';
import { button, empty } from './ui/components.js';
import { h, icons } from './ui/dom.js';

export interface ImportsActions {
  showStatement(key: StatementKey): void;
  chooseFile(): void;
}

export function imports(ctx: Ctx, actions: ImportsActions): HTMLElement[] {
  const { state, locale } = ctx;
  if (state.statements?.length) return stored(ctx, actions);
  const list = importedStatements(state.rows);

  if (!list.length)
    return [
      empty({
        heading: 'No imports yet',
        text: 'Each statement you import shows up here, with its account, period and number of transactions.',
        action: button([icons.upload(), 'Import statement'], {
          variant: 'primary',
          onClick: actions.chooseFile,
          key: 'imports-choose',
        }),
      }),
    ];

  const short = narrow(ctx.width);

  const flow = (rows: (typeof list)[number]['rows']) => {
    const [t] = totals(rows);

    return [
      h(
        'span',
        { class: 'm-line' },
        `${formatAmount(t.in, t.currency, locale)} in`,
      ),
      h(
        'span',
        { class: 'm-line' },
        `${formatAmount(t.out, t.currency, locale, { sign: 'negative' })} out`,
      ),
    ];
  };

  const label = (key: StatementKey) =>
    `${ctx.width < 900 ? shortAccount(key.account) : groupAccount(key.account)} · ${key.currency}`;
  const note = h(
    'p',
    { class: 'pl-muted m-small m-pad' },
    'Built from the imported transactions. Opening and closing balances and import dates are not stored yet.',
  );

  if (short)
    return [
      h(
        'ul',
        { class: 'm-list m-flat', 'aria-label': 'Imported statements' },
        list.map(s =>
          h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                class: 'm-item',
                'data-key': `import-${JSON.stringify(s.key)}`,
                onclick: () => actions.showStatement(s.key),
              },
              h(
                'span',
                { class: 'm-t' },
                `${shortAccount(s.key.account)} · ${s.key.currency}`,
              ),
              h(
                'span',
                { class: 'pl-muted pl-num' },
                `Statement ${s.key.statement || '—'}`,
              ),
              h(
                'span',
                { class: 'm-s pl-num' },
                h(
                  'span',
                  {},
                  `${rangeLabel(s.start, s.end, locale)} · ${count(s.entries, locale)} · ${formatLabel(s.key.format)}`,
                ),
              ),
            ),
          ),
        ),
      ),
      note,
    ];

  return [
    h(
      'table',
      { class: 'm-ledger m-imports' },
      h(
        'caption',
        {},
        `${count(list.length, locale)} imported statements, newest first`,
      ),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Account'),
          h('th', { scope: 'col' }, 'Period'),
          h('th', { scope: 'col' }, 'Statement'),
          h('th', { scope: 'col' }, 'Format'),
          h('th', { scope: 'col' }, 'In · out'),
          h('th', { scope: 'col' }, 'Entries'),
        ),
      ),
      h(
        'tbody',
        {},
        list.map(s =>
          h(
            'tr',
            { class: 'm-row', onclick: () => actions.showStatement(s.key) },
            h(
              'td',
              {},
              h(
                'button',
                {
                  type: 'button',
                  class: 'm-rowbtn',
                  'data-key': `import-${JSON.stringify(s.key)}`,
                  'aria-label': `Show the transactions of statement ${s.key.statement || 'without a number'} for ${groupAccount(s.key.account)} ${s.key.currency}`,
                },
                h('b', {}, label(s.key)),
              ),
            ),
            h(
              'td',
              { class: 'pl-num m-nowrap' },
              rangeLabel(s.start, s.end, locale),
            ),
            h('td', { class: 'pl-num' }, s.key.statement || '—'),
            h('td', {}, formatLabel(s.key.format) || '—'),
            h('td', { class: 'pl-num m-small' }, flow(s.rows)),
            h('td', { class: 'pl-num' }, count(s.entries, locale)),
          ),
        ),
      ),
    ),
    note,
  ];
}

/**
 * The statements the importer stored (atomic-server#1768): with their
 * reconciled opening and closing balances and the date they were imported.
 */
function stored(ctx: Ctx, actions: ImportsActions): HTMLElement[] {
  const { locale } = ctx;
  const list = [...ctx.state.statements!].sort((a, b) =>
    a.end === b.end ? (a.account < b.account ? -1 : 1) : a.end < b.end ? 1 : -1,
  );
  const key = (s: StoredStatement): StatementKey => ({
    account: s.account,
    currency: s.currency,
    statement: s.number,
    format: s.format,
  });
  const label = (s: StoredStatement) =>
    `${narrow(ctx.width) || ctx.width < 900 ? shortAccount(s.account) : groupAccount(s.account)} · ${s.currency}`;
  const money = (s: StoredStatement, amount: string) =>
    formatAmount(amount, s.currency, locale, { sign: 'negative' });
  const period = (s: StoredStatement) =>
    s.start ? rangeLabel(s.start, s.end, locale) : fullDate(s.end, locale);

  if (narrow(ctx.width))
    return [
      h(
        'ul',
        { class: 'm-list m-flat', 'aria-label': 'Imported statements' },
        list.map(s =>
          h(
            'li',
            {},
            h(
              'button',
              {
                type: 'button',
                class: 'm-item',
                'data-key': `import-${s.subject}`,
                onclick: () => actions.showStatement(key(s)),
              },
              h('span', { class: 'm-t' }, label(s)),
              h('span', { class: 'pl-num m-strong' }, money(s, s.closing)),
              h(
                'span',
                { class: 'm-s pl-num' },
                h(
                  'span',
                  {},
                  `Statement ${s.number || '—'} · ${period(s)} · ${formatLabel(s.format)}`,
                ),
              ),
            ),
          ),
        ),
      ),
    ];

  return [
    h(
      'table',
      { class: 'm-ledger m-imports' },
      h(
        'caption',
        {},
        `${count(list.length, locale)} imported statements, newest first`,
      ),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Account'),
          h('th', { scope: 'col' }, 'Period'),
          h('th', { scope: 'col' }, 'Statement'),
          h('th', { scope: 'col' }, 'Opening → closing'),
          h('th', { scope: 'col' }, 'Entries'),
          h('th', { scope: 'col' }, 'Imported'),
        ),
      ),
      h(
        'tbody',
        {},
        list.map(s =>
          h(
            'tr',
            { class: 'm-row', onclick: () => actions.showStatement(key(s)) },
            h(
              'td',
              {},
              h(
                'button',
                {
                  type: 'button',
                  class: 'm-rowbtn',
                  'data-key': `import-${s.subject}`,
                  'aria-label': `Show the transactions of statement ${s.number || 'without a number'} for ${groupAccount(s.account)} ${s.currency}`,
                },
                h('b', {}, label(s)),
                h(
                  'span',
                  { class: 'm-line pl-muted m-small' },
                  formatLabel(s.format),
                ),
              ),
            ),
            h('td', { class: 'pl-num m-nowrap' }, period(s)),
            h('td', { class: 'pl-num' }, s.number || '—'),
            h(
              'td',
              { class: 'pl-num' },
              h('span', { class: 'm-line' }, `${money(s, s.opening)} →`),
              h('b', { class: 'm-line' }, money(s, s.closing)),
            ),
            h('td', { class: 'pl-num' }, s.entries || '—'),
            h(
              'td',
              { class: 'pl-num m-nowrap' },
              s.imported ? fullDate(s.imported, locale) : '—',
            ),
          ),
        ),
      ),
    ),
  ];
}
