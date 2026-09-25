// @wc-ignore-file
/**
 * Transaction detail (DESIGN.md 6.7): the bank's fields read-only, the
 * person's category and note editable and saved on blur. A docked region at
 * ≥900px, a drawer at 560–899px and a full-screen sheet below; the last two
 * are modal dialogs.
 */
import type { Edit, NoteKey } from './controller.js';
import { formatLabel, groupAccount, longDate, shortAccount } from './format.js';
import { categories, type StatementKey } from './ledger.js';
import { canAnnotate, type Txn } from './rows.js';
import { amountNode, titleOf, type Ctx } from './viewLedger.js';
import {
  banner,
  button,
  panel,
  panelMode,
  type PanelMode,
} from './ui/components.js';
import { h, icons } from './ui/dom.js';

export interface DetailActions {
  select(subject: string | undefined): void;
  draft(field: NoteKey, value: string): void;
  saveNote(field: NoteKey, value: string): void;
  showStatement(key: StatementKey): void;
  allowEditing(): void;
}

const LABEL: Record<NoteKey, string> = { category: 'Category', note: 'Note' };

function field(
  ctx: Ctx,
  row: Txn,
  key: NoteKey,
  actions: DetailActions,
): HTMLElement[] {
  const { state } = ctx;
  const edit: Edit | undefined = state.edits[key];
  const value = state.drafts[key] ?? edit?.value ?? row[key];
  const id = `money-${key}`;
  const common = {
    id,
    class: 'm-input',
    'data-key': `note-${key}-${row.subject}`,
    value,
    'aria-invalid': edit?.status === 'error' ? 'true' : undefined,
    'aria-describedby': edit?.status === 'error' ? `${id}-error` : undefined,
    oninput: (event: Event) =>
      actions.draft(key, (event.target as HTMLInputElement).value),
    onchange: (event: Event) =>
      actions.saveNote(key, (event.target as HTMLInputElement).value),
  };
  const control =
    key === 'category'
      ? h('input', {
          ...common,
          type: 'text',
          list: 'money-categories',
          autocomplete: 'off',
          placeholder: 'Uncategorised',
        })
      : h('textarea', { ...common, placeholder: 'Add a note', rows: '3' });
  if (key === 'note') control.textContent = value;
  const nodes: HTMLElement[] = [
    h(
      'div',
      { class: 'm-field' },
      h('label', { for: id }, LABEL[key]),
      control,
    ),
  ];

  if (edit?.status === 'error')
    nodes.push(
      h(
        'div',
        { id: `${id}-error` },
        banner({
          tone: 'neg',
          text: `Couldn't save the ${LABEL[key].toLowerCase()}. ${edit.message ?? ''}`.trim(),
          action: button(
            ctx.state.rowAccess === 'denied' ? 'Ask again' : 'Retry',
            {
              onClick: () => actions.saveNote(key, edit.value),
              key: `retry-${key}`,
            },
          ),
          details: edit.details,
        }),
      ),
    );

  return nodes;
}

/**
 * Whether Money may save here (atomic-server#1788). Said before anyone
 * types, so a refusal is never a surprise; saving asks in any case.
 */
function access(ctx: Ctx, actions: DetailActions): HTMLElement | undefined {
  const { rowAccess, rowAccessReason } = ctx.state;
  const allow = button('Allow editing', {
    onClick: actions.allowEditing,
    key: 'allow-editing',
  });

  if (rowAccess === 'none')
    return banner({
      tone: 'info',
      text: 'Money can show this table. To save categories and notes on its rows, allow it to edit them.',
      action: allow,
    });

  if (rowAccess === 'denied')
    return banner({
      tone: 'warn',
      text: `Editing isn't allowed${rowAccessReason ? `: ${rowAccessReason}` : ''}. Categories and notes you type are kept here but not saved.`,
      action: button('Ask again', {
        onClick: actions.allowEditing,
        key: 'allow-editing',
      }),
    });

  if (rowAccess === 'unavailable')
    return banner({
      tone: 'info',
      text: 'Categories and notes can be saved when Money is open as a view of your Bank transactions table.',
    });

  return undefined;
}

function footer(ctx: Ctx, row: Txn, actions: DetailActions): HTMLElement {
  const edits = Object.values(ctx.state.edits);
  const asking = edits.some(e => e?.status === 'asking');
  const saving = edits.some(e => e?.status === 'saving');
  const saved = !saving && !asking && edits.some(e => e?.status === 'saved');

  return h(
    'footer',
    { class: 'm-panel-foot' },
    h(
      'span',
      { class: saved ? 'm-saved' : 'pl-muted', 'aria-live': 'polite' },
      asking
        ? 'Waiting for you to allow editing…'
        : saving
          ? 'Saving…'
          : saved
            ? 'Saved'
            : '',
    ),
    h('span', { class: 'pl-spacer' }),
    row.statement
      ? button(`Show statement ${row.statement}`, {
          variant: 'ghost',
          key: 'show-statement',
          onClick: () =>
            actions.showStatement({
              account: row.account,
              currency: row.currency,
              statement: row.statement,
              format: row.format,
            }),
        })
      : undefined,
  );
}

export function detail(
  ctx: Ctx,
  row: Txn,
  actions: DetailActions,
): { mode: PanelMode; nodes: HTMLElement[] } {
  const { state, locale } = ctx;
  const mode = panelMode(ctx.width);
  const { title } = titleOf(row);
  const close = () => actions.select(undefined);
  const kv = (label: string, value: string, mono = false) => [
    h('dt', {}, label),
    h('dd', mono ? { class: 'pl-mono' } : {}, value || '—'),
  ];
  const statement = [row.statement, formatLabel(row.format)]
    .filter(Boolean)
    .join(' · ');
  const options = categories(state.rows);

  const node = panel(
    mode,
    'Transaction details',
    mode === 'sheet'
      ? h(
          'div',
          { class: 'm-sheetbar' },
          button(icons.back(), {
            variant: 'ghost',
            iconOnly: true,
            ariaLabel: 'Back to transactions',
            onClick: close,
            key: 'detail-close',
          }),
          h('strong', {}, 'Transaction'),
        )
      : undefined,
    h(
      'div',
      { class: 'm-panel-head' },
      h(
        'div',
        { class: 'm-grow' },
        h(
          'span',
          { class: 'pl-muted m-small' },
          `${longDate(row.bookingDate, locale)} · ${shortAccount(row.account)}`,
        ),
        h(
          'span',
          { class: 'm-big' },
          amountNode(row.amount, row.currency, locale),
        ),
        h('b', {}, title),
      ),
      mode === 'sheet'
        ? undefined
        : button(icons.close(), {
            variant: 'ghost',
            iconOnly: true,
            ariaLabel: 'Close details',
            onClick: close,
            key: 'detail-close',
          }),
    ),
    h(
      'section',
      { 'aria-labelledby': 'money-notes-h' },
      h('h3', { id: 'money-notes-h' }, 'Your notes'),
      canAnnotate(state.fields)
        ? [
            access(ctx, actions),
            ...field(ctx, row, 'category', actions),
            ...field(ctx, row, 'note', actions),
            h(
              'datalist',
              { id: 'money-categories' },
              options.map(name => h('option', { value: name })),
            ),
          ]
        : h(
            'p',
            { class: 'pl-muted m-small' },
            'Category and note need the newer Bank statements schema. Run Set up again on the importer to add them.',
          ),
    ),
    h(
      'section',
      { 'aria-labelledby': 'money-bank-h' },
      h('h3', { id: 'money-bank-h' }, 'From your bank'),
      h(
        'dl',
        { class: 'm-kv pl-num' },
        kv('Value date', longDate(row.valueDate, locale)),
        kv('Booking date', longDate(row.bookingDate, locale)),
        kv('Account', `${groupAccount(row.account)} · ${row.currency}`),
        kv('Reference', row.reference, true),
        kv('Code', row.code, true),
        kv('Statement', statement),
      ),
      row.description
        ? h(
            'pre',
            {
              class: 'm-narr pl-mono',
              'aria-label': 'Original bank narrative',
            },
            row.description,
          )
        : undefined,
    ),
    footer(ctx, row, actions),
  );

  return {
    mode,
    nodes:
      mode === 'side'
        ? [node]
        : [h('div', { class: 'pl-scrim', onclick: close }), node],
  };
}
