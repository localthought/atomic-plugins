// @wc-ignore-file
/**
 * DOM-free state for the Money app: what `main.ts` renders, and the only
 * place that talks to the store. Tests drive it with `fakeStore.ts`.
 */
import {
  defaultPeriod,
  noFilters,
  WINDOW,
  type Filters,
  type Period,
} from './ledger.js';
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
  filters: Filters;
  /** How many of the filtered rows the ledger renders. */
  limit: number;
  /** Subject of the row whose detail is open. */
  selected?: string;
  /** Rows that arrived through the table subscription since the last load. */
  arrived?: { count: number };
}

export const NOT_A_BANK_TABLE =
  'This app shows a Bank transactions table. Open it from the app tab of the table the Bank statements importer created.';

export interface Controller {
  state(): State;
  load(): Promise<void>;
  setTab(tab: Tab): void;
  setFilters(patch: Partial<Filters>): void;
  clearFilters(): void;
  showMore(): void;
  select(subject: string | undefined): void;
  /** ISO date the period filters are relative to. */
  today(): string;
  dispose(): void;
}

export interface Options {
  /** ISO date of "today"; the harness and tests pin it. */
  today?: () => string;
}

export function localToday(): string {
  const now = new Date();

  return [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, '0'),
    String(now.getDate()).padStart(2, '0'),
  ].join('-');
}

export function createController(
  store: PluginStore,
  render: (state: State) => void,
  { today = localToday }: Options = {},
): Controller {
  let state: State = {
    view: { kind: 'loading', loaded: 0 },
    tab: 'transactions',
    rows: [],
    fields: {},
    filters: noFilters({ kind: 'all' }),
    limit: WINDOW,
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
    const known = new Set(state.rows.map(row => row.subject));
    const fresh = subjects.filter(s => !known.has(s));
    const added = await readRows(store, fresh, state.fields);
    const present = new Set(subjects);
    const wasEmpty = state.rows.length === 0;
    const rows = [
      ...state.rows.filter(row => present.has(row.subject)),
      ...added,
    ];
    update({
      rows,
      view: settled(rows),
      ...(added.length ? { arrived: { count: added.length } } : {}),
      // A first import into an empty table opens where its rows are.
      ...(wasEmpty && rows.length
        ? { filters: noFilters(defaultPeriod(rows, today())) }
        : {}),
    });
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

  const fail = (message: string) =>
    update({ view: { kind: 'error', message } });

  return {
    state: () => state,
    async load() {
      update({ view: { kind: 'loading', loaded: 0 } });

      try {
        const data = await store.getData();
        if (!data?.rowClass) return fail(NOT_A_BANK_TABLE);
        const fields = await resolveFields(store, data.rowClass);
        if (!isBankTable(fields)) return fail(NOT_A_BANK_TABLE);
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
        update({
          rows,
          view: settled(rows),
          filters: noFilters(defaultPeriod(rows, today())),
          limit: WINDOW,
          arrived: undefined,
        });
        unsubscribe?.();
        unsubscribe = store.subscribe(table, queueRefresh);
      } catch (error) {
        fail(error instanceof Error ? error.message : String(error));
      }
    },
    setTab(tab) {
      update({ tab });
    },
    setFilters(patch) {
      update({
        filters: { ...state.filters, ...patch },
        limit: WINDOW,
        arrived: undefined,
      });
    },
    clearFilters() {
      const period: Period = { kind: 'all' };
      update({ filters: noFilters(period), limit: WINDOW });
    },
    showMore() {
      update({ limit: state.limit + WINDOW });
    },
    select(subject) {
      update({ selected: subject });
    },
    today,
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}
