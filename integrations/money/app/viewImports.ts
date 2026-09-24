// @wc-ignore-file
/**
 * The Imports tab (issues.md M-11): one row per statement the table's rows
 * came from. Selecting one shows its transactions.
 */
import { formatAmount, totals } from './amounts.js';
import {
  count,
  formatLabel,
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
