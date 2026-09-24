// @wc-ignore-file
/**
 * DOM-free state for the Money app: what `main.ts` renders, and the only
 * place that talks to the store. Tests drive it with `fakeStore.ts`.
 */
import {
  compare,
  formatOfText,
  isBlocked,
  problemOf,
  read,
  tooLarge,
  type FileInfo,
  type Preview,
  type Problem,
} from './check.js';
import {
  defaultPeriod,
  noFilters,
  WINDOW,
  type Filters,
  type Period,
} from './ledger.js';
import {
  atomic,
  canAnnotate,
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

export type NoteKey = 'category' | 'note';

export type StepStatus = 'done' | 'now' | 'todo';

/** The import sheet (DESIGN.md 6.2–6.5). */
export type ImportSheet =
  | {
      step: 'checking';
      file: FileInfo;
      /** Read file · Check balances · Compare with existing transactions. */
      lines: [StepStatus, StepStatus, StepStatus];
      counts?: { statements: number; entries: number };
    }
  | {
      step: 'preview';
      file: FileInfo;
      preview: Preview;
      tab: 'new' | 'already' | 'blocked';
      applying?: boolean;
      /** Why applying failed, when it did. */
      failure?: string;
    }
  | { step: 'error' | 'blocked'; file: FileInfo; problem: Problem };

/** A file handed to the app: its name, size, and a way to read it as text. */
export interface ChosenFile {
  name: string;
  size: number;
  text(): Promise<string>;
}

/**
 * Applies a checked statement through the sandbox importer. The pinned host
 * has no app op for this (issues.md M-8), so `view()` passes none and the
 * preview says where to import instead; tests pass a fake.
 */
export interface ImportPort {
  apply(text: string, file: FileInfo): Promise<{ created: number }>;
}

/** A save of one annotation field, kept until the row is closed. */
export interface Edit {
  value: string;
  status: 'saving' | 'saved' | 'error';
  /** For `error`: one sentence of cause, and the host's raw message. */
  message?: string;
  details?: string;
}

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
  /** Saves of the open row's annotations, by field. */
  edits: Partial<Record<NoteKey, Edit>>;
  /** What is typed but not yet saved, by field; kept across re-renders. */
  drafts: Partial<Record<NoteKey, string>>;
  importing?: ImportSheet;
  /** Whether the host can apply an import from the app (M-8). */
  canApply: boolean;
  /** The keyboard shortcuts popover (`?`). */
  help?: boolean;
  /**
   * The importer that owns the table (the table's parent), when the host
   * can open it for the person (`store.openResource`).
   */
  importer?: string;
  /** Why opening the importer failed, when it did. */
  openFailure?: string;
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
  /** Remembers typed text without re-rendering. */
  draft(field: NoteKey, value: string): void;
  /** Saves one annotation of the open row (on blur); no-op when unchanged. */
  saveNote(field: NoteKey, value: string): Promise<void>;
  /** Checks a statement file and shows the import sheet. */
  importFile(file: ChosenFile): Promise<void>;
  setPreviewTab(tab: 'new' | 'already' | 'blocked'): void;
  applyImport(): Promise<void>;
  /** Closes the import sheet; during a check, abandons it. */
  closeImport(): void;
  toggleHelp(open?: boolean): void;
  /** Leaves the app for the importer's page, where Import applies (M-8). */
  openImporter(): Promise<void>;
  /** ISO date the period filters are relative to. */
  today(): string;
  dispose(): void;
}

export interface Options {
  /** ISO date of "today"; the harness and tests pin it. */
  today?: () => string;
  importer?: ImportPort;
  /** Yields between check steps so each line can render; tests may pin it. */
  tick?: () => Promise<void>;
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
  {
    today = localToday,
    importer,
    tick = () => new Promise(resolve => setTimeout(resolve, 0)),
  }: Options = {},
): Controller {
  let state: State = {
    view: { kind: 'loading', loaded: 0 },
    tab: 'transactions',
    rows: [],
    fields: {},
    filters: noFilters({ kind: 'all' }),
    limit: WINDOW,
    edits: {},
    drafts: {},
    canApply: Boolean(importer),
  };
  /** Bumped on every new check or close, so a stale check stops. */
  let run = 0;
  let pendingText: string | undefined;
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

  const PROPERTY: Record<NoteKey, 'money-category' | 'money-note'> = {
    category: 'money-category',
    note: 'money-note',
  };

  const setEdit = (field: NoteKey, edit: Edit | undefined) =>
    update({ edits: { ...state.edits, [field]: edit } });

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
        const owner = store.openResource
          ? await store
              .getResource(table)
              .then(r => r.get(atomic.parent))
              .catch(() => undefined)
          : undefined;
        if (typeof owner === 'string') update({ importer: owner });
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
      if (subject === state.selected) return;
      update({ selected: subject, edits: {}, drafts: {} });
    },
    draft(field, value) {
      state.drafts = { ...state.drafts, [field]: value };
    },
    async saveNote(field, value) {
      const subject = state.selected;
      const row = state.rows.find(r => r.subject === subject);
      const property = state.fields[PROPERTY[field]];
      if (!subject || !row || !property || !canAnnotate(state.fields)) return;
      const next = field === 'note' ? value : value.trim();
      const edit = state.edits[field];
      if (next === row[field] && edit?.status !== 'error') return;
      setEdit(field, { value: next, status: 'saving' });

      try {
        const resource = await store.getResource(subject);
        if (next) resource.set(property, next);
        else resource.remove(property);
        await resource.save();
        // Written; the row now carries it, whether or not it is still open.
        const rows = state.rows.map(r =>
          r.subject === subject ? { ...r, [field]: next } : r,
        );

        if (state.selected === subject) {
          const drafts = { ...state.drafts };
          delete drafts[field];
          update({
            rows,
            drafts,
            edits: {
              ...state.edits,
              [field]: { value: next, status: 'saved' },
            },
          });
        } else update({ rows });
      } catch (error) {
        const details = error instanceof Error ? error.message : String(error);
        if (state.selected === subject)
          setEdit(field, {
            value: next,
            status: 'error',
            message: saveFailure(details),
            details,
          });
      }
    },
    async importFile(file) {
      const mine = ++run;
      const info: FileInfo = { name: file.name, size: file.size };
      const stale = () => mine !== run;
      const stop = (problem: Problem) =>
        update({
          importing: {
            step: isBlocked(problem) ? 'blocked' : 'error',
            file: info,
            problem,
          },
        });
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['now', 'todo', 'todo'],
        },
      });
      const large = tooLarge(file.size);
      if (large) return stop(large);
      let text: string;

      try {
        text = await file.text();
      } catch (error) {
        if (!stale()) stop(problemOf(error));

        return;
      }

      if (stale()) return;
      info.format = formatOfText(text);
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['now', 'todo', 'todo'],
        },
      });
      await tick();
      if (stale()) return;
      // The readers parse and reconcile in one pass; the checklist shows the
      // two halves as the design's first two lines.
      const parsed = read(text);
      if (!parsed.ok) return stop(parsed.problem);
      const counts = {
        statements: parsed.statements.length,
        entries: parsed.statements.reduce(
          (n, s) => n + s.transactions.length,
          0,
        ),
      };
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['done', 'now', 'todo'],
          counts,
        },
      });
      await tick();
      if (stale()) return;
      update({
        importing: {
          step: 'checking',
          file: info,
          lines: ['done', 'done', 'now'],
          counts,
        },
      });
      await tick();
      if (stale()) return;
      const checked = compare(parsed.format, parsed.statements, state.rows);
      if (!checked.ok) return stop(checked.problem);
      pendingText = text;
      update({
        importing: {
          step: 'preview',
          file: info,
          preview: checked.preview,
          tab: checked.preview.fresh.length ? 'new' : 'already',
        },
      });
    },
    setPreviewTab(tab) {
      if (state.importing?.step === 'preview')
        update({ importing: { ...state.importing, tab } });
    },
    async applyImport() {
      const sheet = state.importing;
      if (sheet?.step !== 'preview' || !importer || !pendingText) return;
      const mine = run;
      update({ importing: { ...sheet, applying: true, failure: undefined } });

      try {
        const { created } = await importer.apply(pendingText, sheet.file);
        if (mine !== run) return;
        pendingText = undefined;
        update({ importing: undefined, arrived: { count: created } });
      } catch (error) {
        if (mine === run)
          update({
            importing: {
              ...sheet,
              applying: false,
              failure: error instanceof Error ? error.message : String(error),
            },
          });
      }
    },
    closeImport() {
      run++;
      pendingText = undefined;
      if (state.importing) update({ importing: undefined });
    },
    async openImporter() {
      if (!state.importer || !store.openResource) return;

      try {
        await store.openResource(state.importer);
      } catch (error) {
        update({
          openFailure: error instanceof Error ? error.message : String(error),
        });
      }
    },
    toggleHelp(open = !state.help) {
      update({ help: open });
    },
    today,
    dispose() {
      unsubscribe?.();
      unsubscribe = undefined;
    },
  };
}

/** One sentence of cause for a failed annotation save. */
export function saveFailure(message: string): string {
  if (/only write its own data/i.test(message))
    return "This app isn't allowed to write to the importer's table yet. Your text is kept here.";
  if (/did not answer|timed? ?out|network/i.test(message))
    return "Your server didn't respond.";

  return 'Your server refused the change.';
}
