// @wc-ignore-file
/**
 * The import sheet (DESIGN.md 6.2–6.5): checking, preview with one
 * reconciliation card per statement, and the designed error and blocked
 * states. A modal dialog; pure, state in, nodes out.
 */
import { addAmounts, formatAmount, negate } from './amounts.js';
import type { FileRow, Problem } from './check.js';
import type { ImportSheet, State } from './controller.js';
import type { StatementErrorData } from '../errors.js';
import type { Statement } from '../parser.js';
import {
  count,
  formatLabel,
  fullDate,
  groupAccount,
  kilobytes,
  plural,
  rangeLabel,
  shortAccount,
  shortDate,
} from './format.js';
import { amountNode, titleOf, type Ctx } from './viewLedger.js';
import { banner, button, pill } from './ui/components.js';
import { h, icons } from './ui/dom.js';

export interface ImportActions {
  closeImport(): void;
  chooseFile(): void;
  setPreviewTab(tab: 'new' | 'already' | 'blocked'): void;
  applyImport(): void;
  openImporter(): void;
}

const fileLine = (sheet: ImportSheet) => {
  const { file } = sheet;
  const format = file.format
    ? `${formatLabel(file.format)}${file.format === 'camt053' ? ' XML' : ''}`
    : '';

  return h(
    'div',
    { class: 'm-file' },
    h(
      'span',
      { class: 'm-doc', 'aria-hidden': 'true' },
      file.format === 'camt053' ? 'XML' : file.format === 'mt940' ? '940' : '',
    ),
    h(
      'div',
      {},
      h('b', {}, file.name),
      h(
        'div',
        { class: 'pl-muted pl-num m-small' },
        [
          kilobytes(file.size),
          format,
          sheet.step === 'checking' && format ? 'detected from contents' : '',
        ]
          .filter(Boolean)
          .join(' · '),
      ),
    ),
  );
};

function checking(
  ctx: Ctx,
  sheet: Extract<ImportSheet, { step: 'checking' }>,
): HTMLElement {
  const { locale } = ctx;
  const labels = [
    sheet.counts
      ? `Read file · ${plural(sheet.counts.statements, 'statement', 'statements', locale)}, ${plural(sheet.counts.entries, 'entry', 'entries', locale)}`
      : 'Read file',
    'Check balances',
    `Compare with ${plural(ctx.state.rows.length, 'existing transaction', 'existing transactions', locale)}`,
  ];

  return h(
    'ul',
    { class: 'm-checklist' },
    labels.map((label, i) =>
      h(
        'li',
        { 'data-status': sheet.lines[i] },
        h(
          'span',
          { class: 'm-st', 'aria-hidden': 'true' },
          sheet.lines[i] === 'done' ? '✓' : '',
        ),
        label,
        h(
          'span',
          { class: 'pl-sr' },
          sheet.lines[i] === 'done'
            ? ', done'
            : sheet.lines[i] === 'now'
              ? ', in progress'
              : ', to do',
        ),
      ),
    ),
  );
}

function card(ctx: Ctx, statement: Statement): HTMLElement {
  const { locale } = ctx;
  const money = (amount: string) =>
    formatAmount(amount, statement.currency, locale, { sign: 'negative' });

  return h(
    'div',
    { class: 'm-stmt' },
    h(
      'div',
      { class: 'm-top' },
      h(
        'span',
        { class: 'pl-num' },
        `${groupAccount(statement.account)} · ${statement.currency}`,
      ),
      h('span', {}, `Statement ${statement.number}`),
    ),
    h(
      'div',
      { class: 'pl-muted pl-num m-small' },
      `${rangeLabel(statement.start, statement.end, locale)} · ${plural(statement.transactions.length, 'entry', 'entries', locale)}`,
    ),
    h(
      'div',
      { class: 'm-flowline pl-num' },
      h('span', {}, money(statement.opening)),
      h('span', { class: 'm-arrow', 'aria-label': 'to' }, '→'),
      h('span', {}, money(statement.closing)),
    ),
    h('div', { class: 'm-ok' }, 'Balances match'),
  );
}

function rowsTable(ctx: Ctx, rows: FileRow[], caption: string): HTMLElement {
  const { locale } = ctx;
  const currencies = [...new Set(rows.map(r => r.currency))];
  const single = currencies.length === 1 ? currencies[0] : undefined;
  const shown = rows.slice(0, 200);

  return h(
    'div',
    { class: 'm-scroll', 'data-scroll-key': 'preview-rows' },
    h(
      'table',
      { class: 'm-ledger m-preview' },
      h('caption', { class: 'pl-sr' }, caption),
      h(
        'thead',
        {},
        h(
          'tr',
          {},
          h('th', { scope: 'col' }, 'Date'),
          h('th', { scope: 'col' }, 'Description'),
          h('th', { scope: 'col', class: 'm-hide-narrow' }, 'Account'),
          h('th', { scope: 'col' }, single ? `Amount (${single})` : 'Amount'),
        ),
      ),
      h(
        'tbody',
        {},
        shown.map(row => {
          const { title, rest } = titleOf(row);

          return h(
            'tr',
            {},
            h('td', { class: 'pl-num m-nowrap' }, shortDate(row.date, locale)),
            h(
              'td',
              { class: 'm-desc' },
              h('b', {}, title),
              rest ? h('span', { class: 'm-rest' }, rest) : undefined,
            ),
            h(
              'td',
              { class: 'm-acctcell m-hide-narrow' },
              shortAccount(row.account).replace(/^\S+ (?=…)/, ''),
            ),
            h(
              'td',
              {},
              amountNode(row.amount, row.currency, locale, {
                symbol: !single,
              }),
            ),
          );
        }),
      ),
    ),
    rows.length > shown.length
      ? h(
          'p',
          { class: 'pl-muted m-small' },
          `${count(rows.length - shown.length, locale)} more not listed.`,
        )
      : undefined,
  );
}

function preview(
  ctx: Ctx,
  sheet: Extract<ImportSheet, { step: 'preview' }>,
  actions: ImportActions,
): { body: HTMLElement[]; footer: HTMLElement[] } {
  const { locale, state } = ctx;
  const { fresh, already, statements, withoutReference } = sheet.preview;
  const total = fresh.length + already.length;
  const tabs: ['new' | 'already' | 'blocked', string, number][] = [
    ['new', 'New', fresh.length],
    ['already', 'Already imported', already.length],
    ['blocked', 'Blocked', 0],
  ];
  const listed =
    sheet.tab === 'new' ? fresh : sheet.tab === 'already' ? already : [];
  const body: HTMLElement[] = [
    h(
      'div',
      { class: 'm-recon' },
      statements.map(s => card(ctx, s)),
    ),
  ];

  if (!fresh.length)
    body.push(
      h(
        'p',
        { class: 'm-nothing' },
        `Nothing new in this file. ${total === 1 ? 'Its one transaction was' : `All ${count(total, locale)} transactions were`} imported before.`,
      ),
    );
  else {
    body.push(
      h(
        'div',
        {
          class: 'm-subtabs',
          role: 'tablist',
          'aria-label': 'Transactions in this file',
        },
        tabs.map(([id, label, n]) =>
          h(
            'button',
            {
              type: 'button',
              role: 'tab',
              'aria-selected': String(sheet.tab === id),
              'data-key': `preview-tab-${id}`,
              onclick: () => actions.setPreviewTab(id),
            },
            `${label} `,
            h('b', { class: 'pl-num' }, count(n, locale)),
          ),
        ),
      ),
      listed.length
        ? rowsTable(
            ctx,
            listed,
            `${plural(listed.length, 'transaction', 'transactions', locale)}, newest first`,
          )
        : h(
            'p',
            { class: 'pl-muted' },
            sheet.tab === 'blocked'
              ? 'Nothing in this file is blocked.'
              : 'None.',
          ),
    );
  }

  if (withoutReference)
    body.push(
      banner({
        tone: 'info',
        text: `${plural(withoutReference, 'transaction has', 'transactions have', locale)} no unique bank reference. Importing this same file again is safe; an overlapping export of a different period would be blocked.`,
      }),
    );

  if (fresh.length && !state.canApply)
    body.push(
      h(
        'div',
        { id: 'money-apply-note' },
        banner({
          tone: 'info',
          title: 'Import this file from the Bank statements importer',
          text: `Apps can't run the importer yet, so this check changes nothing. Open the importer's Import tab and choose ${sheet.file.name} there: it proposes the same ${plural(fresh.length, 'new transaction', 'new transactions', locale)}.`,
          action: state.importer
            ? button('Open the importer', {
                onClick: actions.openImporter,
                key: 'open-importer',
              })
            : undefined,
          details: state.openFailure,
        }),
      ),
    );

  if (sheet.failure)
    body.push(
      banner({
        tone: 'neg',
        title: "The import didn't go through",
        text: 'Nothing was saved. Try again, or import the file from the importer’s page.',
        details: sheet.failure,
      }),
    );

  const summary = h(
    'span',
    { class: 'm-grow pl-num' },
    fresh.length
      ? `${count(fresh.length, locale)} new · ${count(already.length, locale)} already imported, skipped`
      : '',
  );

  return {
    body,
    footer: fresh.length
      ? [
          summary,
          button('Cancel', {
            onClick: actions.closeImport,
            key: 'import-cancel',
          }),
          button(
            sheet.applying
              ? 'Importing…'
              : `Import ${plural(fresh.length, 'transaction', 'transactions', locale)}`,
            {
              variant: 'primary',
              disabled: !state.canApply || sheet.applying,
              onClick: actions.applyImport,
              key: 'import-apply',
              'aria-describedby': state.canApply
                ? undefined
                : 'money-apply-note',
            },
          ),
        ]
      : [
          summary,
          button('Close', {
            variant: 'primary',
            onClick: actions.closeImport,
            key: 'import-close-footer',
          }),
        ],
  };
}

type Data<C extends keyof StatementErrorData> = StatementErrorData[C];

/** Title, sentence and recovery hint for each problem (DESIGN.md 6.4–6.5). */
export function explain(
  problem: Problem,
  ctx: Ctx,
  size: number,
): { title: string; text: string; hint: string } {
  const { locale } = ctx;
  const shorter =
    'Export a shorter period from your bank, then choose it here.';

  switch (problem.code) {
    case 'BALANCE_MISMATCH': {
      const d = problem.data as Data<'BALANCE_MISMATCH'>;

      return {
        title: "Balances in this statement don't add up",
        text: `Statement ${d.statement} for ${groupAccount(d.account)} ends on a different balance than its entries produce. The file may be cut off or edited. Nothing was imported.`,
        hint: 'Download the statement from your bank again, then choose it here.',
      };
    }

    case 'CHANGED_TRANSACTION': {
      const changed = problem.changed!;
      const more =
        (problem.count ?? 1) > 1
          ? ` ${plural((problem.count ?? 1) - 1, 'other transaction differs', 'other transactions differ', locale)} too.`
          : '';

      return {
        title: 'This file changes a transaction you already have',
        text: `Bank reference ${changed.mine.reference || changed.file.reference} was imported on ${fullDate(changed.mine.bookingDate, locale)} with different details. To protect your records, nothing in this file was imported.${more}`,
        hint: 'Usually this means the bank corrected a booking, or the file was edited after download. Export the original statement again, or ask your bank which version is right.',
      };
    }

    case 'OVERLAP_WITHOUT_REFERENCES': {
      const d = problem.data as Data<'OVERLAP_WITHOUT_REFERENCES'>;

      return {
        title: 'This statement overlaps an earlier import',
        text: `Statement ${d.statement} (${rangeLabel(d.thisPeriod.start, d.thisPeriod.end, locale)}) has transactions without bank references that match ones you already imported${d.overlappingDate ? `, from ${fullDate(d.overlappingDate, locale)}` : ''}. Nothing was imported.`,
        hint: 'Export a non-overlapping period, or use the original statement.',
      };
    }

    case 'REPEATED_REFERENCE': {
      const d = problem.data as Data<'REPEATED_REFERENCE'>;

      return {
        title: 'The same transaction appears twice in this file',
        text: `Bank reference ${d.reference} is in this file twice. Nothing was imported.`,
        hint: 'Export statements that don’t overlap, then choose one here.',
      };
    }

    case 'CONFLICTING_REFERENCE': {
      const d = problem.data as Data<'CONFLICTING_REFERENCE'>;

      return {
        title: 'Two transactions in this file share a bank reference',
        text: `Bank reference ${d.reference} is used by two different transactions. Nothing was imported.`,
        hint: 'Export the statement from your bank again, then choose it here.',
      };
    }

    case 'FILE_TOO_LARGE': {
      const d = problem.data as Data<'FILE_TOO_LARGE'>;

      return {
        title:
          d.format === 'mt940'
            ? 'This statement is larger than 512 KB'
            : 'This statement is larger than 5 MB',
        text: `The file is ${kilobytes(size)}. Nothing was imported.`,
        hint: shorter,
      };
    }

    case 'TOO_MANY_ENTRIES':
      return {
        title: 'This statement has more than 500 transactions',
        text: 'One import takes at most 500. Nothing was imported.',
        hint: shorter,
      };

    case 'JSON_NARRATIVE': {
      const d = problem.data as Data<'JSON_NARRATIVE'>;

      return {
        title: "This statement has descriptions we can't store safely yet",
        text: `${plural(d.count, 'description looks', 'descriptions look', locale)} like JSON, which this server would not keep as plain text. Nothing was imported.`,
        hint: 'This is a known gap in the importer; there is no workaround yet.',
      };
    }

    case 'MISSING_BALANCE':
      return {
        title: 'This statement has no opening or closing balance',
        text: "Without both, its balances can't be checked, so nothing was imported.",
        hint: 'Export the full statement from your bank again.',
      };

    case 'INVALID_FIELD': {
      const d = problem.data as Data<'INVALID_FIELD'>;
      const where = d.line
        ? `Line ${count(d.line, locale)} (field :${d.tag}:)`
        : d.tag === 'xml'
          ? 'The XML'
          : `A ${d.tag} element`;

      return {
        title: "This file couldn't be read as a bank statement",
        text: `${where} isn't in a form the reader knows. Nothing was imported.`,
        hint: 'Choose an MT940 or camt.053 export straight from your bank.',
      };
    }

    default:
      return {
        title: "This isn't a bank statement we can read",
        text: 'Choose an MT940 or camt.053 (ISO 20022 XML) export from your bank. Nothing was imported.',
        hint: 'Most banks offer MT940 or camt.053 under their download or export options.',
      };
  }
}

function figures(ctx: Ctx, d: Data<'BALANCE_MISMATCH'>): HTMLElement {
  const { locale } = ctx;
  const money = (amount: string, sign: 'always' | 'negative' = 'negative') =>
    formatAmount(amount, d.currency, locale, { sign });
  const difference = addAmounts([d.closing, negate(d.expectedClosing)]);
  const row = (label: string, value: string, kind?: string) =>
    h(
      'tr',
      kind ? { class: kind } : {},
      h('td', {}, label),
      h('td', {}, value),
    );

  return h(
    'table',
    { class: 'm-figs' },
    h(
      'tbody',
      {},
      row(`Opening balance, ${shortDate(d.start, locale)}`, money(d.opening)),
      row(
        plural(d.entries, 'entry', 'entries', locale),
        money(d.entriesSum, 'always'),
      ),
      row('Expected closing', money(d.expectedClosing), 'm-total'),
      row(`Closing in file, ${shortDate(d.end, locale)}`, money(d.closing)),
      row('Difference', money(difference), 'm-bad'),
    ),
  );
}

function compareGrid(ctx: Ctx, problem: Problem): HTMLElement | undefined {
  const changed = problem.changed;
  if (!changed) return undefined;
  const { locale } = ctx;
  const { mine, file } = changed;

  const line = (
    label: string,
    key: 'date' | 'amount' | 'description' | 'account',
    a: string,
    b: string,
  ) => {
    const differs = changed.fields.includes(key);

    return [
      h('div', { class: 'm-k', role: 'rowheader' }, label),
      h('div', { role: 'cell' }, a),
      h(
        'div',
        { role: 'cell', class: differs ? 'm-chg' : undefined },
        b,
        differs ? h('span', { class: 'pl-sr' }, ' (changed)') : undefined,
      ),
    ];
  };

  return h(
    'div',
    { class: 'm-compare', role: 'table', 'aria-label': 'Differences' },
    h(
      'div',
      { role: 'row', class: 'm-compare-row' },
      h('div', { class: 'm-h', role: 'columnheader' }),
      h('div', { class: 'm-h', role: 'columnheader' }, 'In your table'),
      h('div', { class: 'm-h', role: 'columnheader' }, 'In this file'),
    ),
    h(
      'div',
      { role: 'row', class: 'm-compare-row' },
      line(
        'Date',
        'date',
        fullDate(mine.bookingDate, locale),
        fullDate(file.date, locale),
      ),
    ),
    h(
      'div',
      { role: 'row', class: 'm-compare-row' },
      line(
        'Amount',
        'amount',
        formatAmount(mine.amount, mine.currency, locale, { sign: 'negative' }),
        formatAmount(file.amount, file.currency, locale, { sign: 'negative' }),
      ),
    ),
    h(
      'div',
      { role: 'row', class: 'm-compare-row' },
      line('Description', 'description', mine.description, file.description),
    ),
    h(
      'div',
      { role: 'row', class: 'm-compare-row' },
      line(
        'Account',
        'account',
        groupAccount(mine.account),
        groupAccount(file.account),
      ),
    ),
  );
}

function failed(
  ctx: Ctx,
  sheet: Extract<ImportSheet, { step: 'error' | 'blocked' }>,
  actions: ImportActions,
): { body: HTMLElement[]; footer: HTMLElement[] } {
  const { problem } = sheet;
  const words = explain(problem, ctx, sheet.file.size);
  const blocked = sheet.step === 'blocked';

  return {
    body: [
      ...(problem.code === 'CHANGED_TRANSACTION' ? [] : [fileLine(sheet)]),
      banner({
        tone: blocked ? 'warn' : 'neg',
        title: words.title,
        text: words.text,
        body:
          problem.code === 'BALANCE_MISMATCH'
            ? figures(ctx, problem.data as Data<'BALANCE_MISMATCH'>)
            : undefined,
        details: problem.message,
      }),
      ...(problem.code === 'CHANGED_TRANSACTION'
        ? [
            compareGrid(ctx, problem)!,
            h('p', { class: 'pl-muted m-hint' }, words.hint),
          ]
        : []),
    ],
    footer: [
      h(
        'span',
        { class: 'm-grow' },
        problem.code === 'CHANGED_TRANSACTION' ? '' : words.hint,
      ),
      button(blocked ? 'Cancel import' : 'Close', {
        onClick: actions.closeImport,
        key: 'import-cancel',
      }),
      button('Choose another file', {
        variant: 'primary',
        onClick: actions.chooseFile,
        key: 'import-again',
      }),
    ],
  };
}

export function importSheet(
  ctx: Ctx,
  sheet: ImportSheet,
  actions: ImportActions,
): HTMLElement[] {
  const parts =
    sheet.step === 'checking'
      ? {
          body: [fileLine(sheet), checking(ctx, sheet)],
          footer: [
            h(
              'span',
              { class: 'm-grow' },
              'Nothing is saved until you confirm.',
            ),
            button('Cancel', {
              onClick: actions.closeImport,
              key: 'import-cancel',
            }),
          ],
        }
      : sheet.step === 'preview'
        ? preview(ctx, sheet, actions)
        : failed(ctx, sheet, actions);
  const status =
    sheet.step === 'checking'
      ? h('span', { class: 'm-steps' }, 'Step 1 of 2 · Check')
      : sheet.step === 'preview'
        ? h('span', { class: 'm-steps' }, 'Step 2 of 2 · Review')
        : sheet.step === 'error'
          ? pill('error', 'Import failed')
          : pill('paused', 'Blocked');

  return [
    h('div', { class: 'pl-scrim m-sheet-scrim' }),
    h(
      'div',
      {
        class: 'm-dialog',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'money-import-title',
        'data-step': sheet.step,
      },
      h(
        'header',
        {},
        h('h2', { id: 'money-import-title' }, 'Import statement'),
        status,
        button(icons.close(), {
          variant: 'ghost',
          iconOnly: true,
          ariaLabel: 'Close',
          onClick: actions.closeImport,
          key: 'import-close',
        }),
      ),
      h(
        'div',
        { class: 'm-body', 'data-scroll-key': 'import-body' },
        parts.body,
      ),
      h('footer', {}, parts.footer),
    ),
  ];
}

/** The header pill while the sheet is open. */
export function importStatus(
  state: State,
): { state: 'syncing' | 'error' | 'paused'; text: string } | undefined {
  const sheet = state.importing;
  if (!sheet) return undefined;
  if (sheet.step === 'checking')
    return {
      state: 'syncing',
      text:
        sheet.lines[0] !== 'done'
          ? 'Reading file…'
          : sheet.lines[1] !== 'done'
            ? 'Checking balances…'
            : 'Comparing…',
    };
  if (sheet.step === 'error') return { state: 'error', text: 'Import failed' };
  if (sheet.step === 'blocked') return { state: 'paused', text: 'Blocked' };

  return undefined;
}
