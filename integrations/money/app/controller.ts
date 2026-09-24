// @wc-ignore-file
/**
 * DOM-free state for the Money app: what `main.ts` renders, and the only
 * place that talks to the store. Tests drive it with `fakeStore.ts`.
 */
import {
  atomic,
  isBankTable,
  readRows,
  resolveFields,
  type Fields,
  type Txn,
} from './rows.js';
import type { PluginStore } from './store.js';

export type ViewState =
  | { kind: 'loading'; loaded: number; total?: number }
  | { kind: 'empty' }
  | { kind: 'populated'; count: number }
  | { kind: 'error'; message: string };

export type Tab = 'transactions' | 'imports' | 'sources';

export interface State {
  view: ViewState;
  tab: Tab;
  rows: Txn[];
  fields: Fields;
}

export const NOT_A_BANK_TABLE =
  'This app shows a Bank transactions table. Open it from the app tab of the table the Bank statements importer created.';

export interface Controller {
  state(): State;
  load(): Promise<void>;
  setTab(tab: Tab): void;
  dispose(): void;
}

export function createController(
  store: PluginStore,
  render: (state: State) => void,
): Controller {
  let state: State = {
    view: { kind: 'loading', loaded: 0 },
    tab: 'transactions',
    rows: [],
    fields: {},
  };
  let table: string | undefined;
  let unsubscribe: (() => void) | undefined;
  let refreshing: Promise<void> | undefined;
  let again = false;

  const update = (patch: Partial<State>) => {
    state = { ...state, ...patch };
    render(state);
  };

  const settled = (rows: Txn[]): ViewState =>
    rows.length ? { kind: 'populated', count: rows.length } : { kind: 'empty' };

  /** Re-reads the table's children, fetching only rows not seen before. */
  const refresh = async () => {
    if (!table) return;
    const subjects = await store.query({
      property: atomic.parent,
      value: table,
    });
    const known = new Map(state.rows.map(row => [row.subject, row]));
    const fresh = subjects.filter(s => !known.has(s));
    const added = await readRows(store, fresh, state.fields);
    const present = new Set(subjects);
    const rows = [
      ...state.rows.filter(row => present.has(row.subject)),
      ...added,
    ];
    update({ rows, view: settled(rows) });
  };

  const queueRefresh = () => {
    if (refreshing) {
      again = true;

      return;
    }

    refreshing = refresh()
      .catch(() => {
        // Keep what is shown; the next change notification retries.
      })
      .finally(() => {
        refreshing = undefined;

        if (again) {
          again = false;
          queueRefresh();
        }
      });
  };

  return {
    state: () => state,
    async load() {
      update({ view: { kind: 'loading', loaded: 0 } });

      try {
        const data = await store.getData();

        if (!data?.rowClass) {
          update({ view: { kind: 'error', message: NOT_A_BANK_TABLE } });

          return;
        }

        const fields = await resolveFields(store, data.rowClass);

        if (!isBankTable(fields)) {
          update({ view: { kind: 'error', message: NOT_A_BANK_TABLE } });

          return;
        }

        table = data.table;
        const subjects = await store.query({
          property: atomic.parent,
          value: table,
        });
        update({
          fields,
          view: { kind: 'loading', loaded: 0, total: subjects.length },
        });
        const rows = await readRows(store, subjects, fields, loaded => {
          // Progress in steps, not per row: each update re-renders.
          if (loaded % 50 === 0)
            update({
              view: { kind: 'loading', loaded, total: subjects.length },
            });
        });
        update({ rows, view: settled(rows) });
        unsubscribe?.();
        unsubscribe = store.subscribe(table, queueRefresh);
      } catch (error) {
        update({
          view: {
            kind: 'error',
            message: error instanceof Error ? error.message : String(error),
          },
        });
      }
    },
    setTab(tab) {
      update({ tab });
    },
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** One line for the status pill. */
export function describe(view: ViewState): string {
  switch (view.kind) {
    case 'loading':
      return view.total
        ? `Loading ${view.loaded} of ${view.total}`
        : 'Loading transactions…';
    case 'empty':
      return 'No transactions yet';
    case 'populated':
      return `${view.count} transactions`;
    case 'error':
      return "Couldn't load";
  }
}
