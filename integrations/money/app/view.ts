// @wc-ignore-file
/**
 * The whole Money view as a pure function of the controller's state, the
 * frame's width and the locale. `main.ts` re-renders it on every state
 * change and keeps focus with `replaceKeepingFocus`; the screenshot harness
 * calls it directly.
 */
import type { Tab } from './controller.js';
import { count, shortDate } from './format.js';
import { importedStatements, latestDate } from './ledger.js';
import {
  accountSwitcher,
  firstRun,
  narrow,
  sourceRow,
  transactions,
  type Ctx,
  type LedgerActions,
} from './viewLedger.js';
import {
  banner,
  button,
  header,
  pill,
  tabs,
  type PillState,
} from './ui/components.js';
import { h, icons } from './ui/dom.js';
import { importSheet, importStatus, type ImportActions } from './viewImport.js';
import { imports, type ImportsActions } from './viewImports.js';

export interface Actions extends LedgerActions, ImportActions, ImportsActions {
  setTab(tab: Tab): void;
  reload(): void;
}

export type { Ctx };

/** The status pill: always names the state in words. */
export function status(ctx: Ctx): { state: PillState; text: string } {
  const { state, locale } = ctx;
  const view = state.view;
  const importing = importStatus(state);
  if (importing) return importing;

  switch (view.kind) {
    case 'loading':
      return {
        state: 'syncing',
        text: view.total
          ? `Loading ${count(view.loaded, locale)} of ${count(view.total, locale)}`
          : 'Loading…',
      };
    case 'error':
      return { state: 'error', text: "Couldn't load" };
    case 'empty':
      return { state: 'idle', text: 'No transactions yet' };
    case 'populated':
      if (state.arrived)
        return {
          state: 'synced',
          text: `Imported ${count(state.arrived.count, locale)} · just now`,
        };

      return {
        state: 'idle',
        text: `Latest entry · ${shortDate(latestDate(state.rows), locale)}`,
      };
  }
}

function importButton(ctx: Ctx, actions: Actions): HTMLButtonElement {
  return narrow(ctx.width)
    ? button(icons.upload(), {
        variant: 'primary',
        iconOnly: true,
        ariaLabel: 'Import statement',
        onClick: actions.chooseFile,
        key: 'import',
        'aria-keyshortcuts': 'i',
      })
    : button([icons.upload(), 'Import statement'], {
        variant: 'primary',
        onClick: actions.chooseFile,
        key: 'import',
        'aria-keyshortcuts': 'i',
      });
}

function sources(ctx: Ctx, actions: Actions): HTMLElement {
  return h(
    'div',
    { class: 'm-sources' },
    sourceRow({
      logo: '940',
      name: 'Statement files',
      why: `MT940 and camt.053 · ${ctx.state.rows.length ? `${count(ctx.state.rows.length, ctx.locale)} transactions` : 'nothing imported yet'}`,
      action: button('Import statement', { onClick: actions.chooseFile }),
    }),
    sourceRow({
      logo: 'MB',
      name: 'Moneybird',
      tag: 'read-only',
      why: 'Financial mutations alongside your bank statements. Not available yet.',
      action: button('Connect', { disabled: true }),
    }),
    sourceRow({
      logo: 'QB',
      name: 'QuickBooks',
      why: 'Planned. Not available yet.',
    }),
  );
}

function body(ctx: Ctx, actions: Actions): Node[] {
  const { state } = ctx;
  const view = state.view;

  if (view.kind === 'error')
    return [
      h(
        'div',
        { class: 'm-pad' },
        banner({
          tone: 'neg',
          title: "The transactions couldn't be loaded",
          text: view.message,
          action: button('Try again', { onClick: actions.reload }),
        }),
      ),
    ];

  if (state.tab === 'sources') return [sources(ctx, actions)];

  if (view.kind === 'loading')
    return [
      h(
        'p',
        { class: 'm-loading', 'aria-busy': 'true' },
        'Loading transactions…',
      ),
    ];
  if (state.tab === 'imports') return imports(ctx, actions);
  if (view.kind === 'empty') return [firstRun(ctx, actions)];

  return transactions(ctx, actions);
}

export function renderApp(ctx: Ctx, actions: Actions): Node[] {
  const { state, locale } = ctx;
  const pillState = status(ctx);
  const populated = state.view.kind === 'populated';

  return [
    header({
      title: 'Money',
      context: populated ? accountSwitcher(ctx, actions) : undefined,
      status: pill(pillState.state, pillState.text),
      action:
        state.view.kind === 'error' ? undefined : importButton(ctx, actions),
    }),
    tabs(
      [
        {
          id: 'transactions',
          label: 'Transactions',
          count: populated ? count(state.rows.length, locale) : undefined,
        },
        {
          id: 'imports',
          label: 'Imports',
          count: populated
            ? count(importedStatements(state.rows).length, locale)
            : undefined,
        },
        { id: 'sources', label: 'Sources' },
      ],
      state.tab,
      actions.setTab,
      'Money views',
    ),
    ...body(ctx, actions),
    ...(state.importing ? importSheet(ctx, state.importing, actions) : []),
  ];
}
