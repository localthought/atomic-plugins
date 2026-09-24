// @wc-ignore-file
/**
 * The Notion view's pure logic: which databases and columns a scope shows,
 * search, sort, board grouping, the status pill, warning counts. No DOM, so
 * it is unit-tested directly (`view.test.ts`).
 */
import { isRunning, type ViewState } from '../controller.js';
import type { SyncRecord } from '../record.js';
import type { Row } from '../rows.js';
import type { JSONValue } from '../store.js';
import type { DataSourceReport, NotionOption } from '../sync.js';
import { ago, clock } from '../ui/format.js';
import type { PillModel } from '../ui/shell.js';

export type ViewKind = 'table' | 'board' | 'list';
export const ALL = 'all';

/** A column as shown: one Notion property, or several merged in "All". */
export interface ViewColumn {
  key: string;
  name: string;
  /** A Notion property type, or `database` / `edited` for fixed columns. */
  type: string;
  /** Row value keys; more than one when "All" merges same-named properties. */
  shortnames: string[];
  /** Options by id, for select, status and multi-select. */
  options: Map<string, NotionOption>;
  /** Options in Notion's order (board columns). */
  order: NotionOption[];
}

export interface Source {
  title: string;
  count: number;
  report?: DataSourceReport;
}

const FIXED = new Set([
  'notion-page-id',
  'notion-data-source',
  'notion-url',
  'notion-last-edited',
]);

export const TEXT_TYPES = new Set(['title', 'rich_text', 'url', 'email', 'phone_number']);
export const OPTION_TYPES = new Set(['select', 'status', 'multi_select']);

const titleColumn = (): ViewColumn => ({
  key: 'title',
  name: 'Name',
  type: 'title',
  shortnames: [],
  options: new Map(),
  order: [],
});

const fixed = (key: 'database' | 'edited'): ViewColumn => ({
  key,
  name: key === 'database' ? 'Database' : 'Last edited in Notion',
  type: key,
  shortnames: [],
  options: new Map(),
  order: [],
});

/** The databases for the chips: from the sync record, else from the rows. */
export function sources(rows: readonly Row[], last?: SyncRecord): Source[] {
  const counts = new Map<string, number>();
  for (const row of rows) counts.set(row.dataSource, (counts.get(row.dataSource) ?? 0) + 1);
  const out: Source[] = [];

  for (const report of last?.dataSources ?? []) {
    out.push({ title: report.title, count: counts.get(report.title) ?? 0, report });
    counts.delete(report.title);
  }

  for (const [title, count] of counts) if (title) out.push({ title, count });

  return out;
}

const datatypeToType = (datatype: string): string =>
  datatype.endsWith('/boolean')
    ? 'checkbox'
    : datatype.endsWith('/float') || datatype.endsWith('/integer')
      ? 'number'
      : datatype.endsWith('/json')
        ? 'multi_select'
        : 'rich_text';

/**
 * The columns a scope shows (DESIGN.md §5 "Scope"): a database shows exactly
 * its projected properties in Notion's order; "All" shows Name, Database and
 * Last edited plus every property whose name and type all databases share.
 * `fallback` (the ontology's columns by shortname) is used when there is no
 * sync record to read the schema from.
 */
export function columnsFor(
  scope: string,
  list: readonly Source[],
  fallback: ReadonlyMap<string, { name: string; datatype: string }> = new Map(),
): ViewColumn[] {
  const reports = list.flatMap(s => (s.report ? [s.report] : []));
  const single = scope === ALL ? undefined : list.find(s => s.title === scope);

  const propertyColumns = (report: DataSourceReport) =>
    report.properties
      .filter(p => p.shortname && p.type !== 'title')
      .map(p => ({
        key: p.shortname!,
        name: p.name,
        type: p.type,
        shortnames: [p.shortname!],
        options: new Map((p.options ?? []).map(o => [o.id, o])),
        order: p.options ?? [],
      }));

  if (single?.report)
    return [titleColumn(), ...propertyColumns(single.report), fixed('edited')];

  if (!reports.length) {
    const extra = [...fallback]
      .filter(([shortname]) => !FIXED.has(shortname) && shortname !== 'notion-sync-record')
      .filter(([shortname]) => shortname.startsWith('notion-'))
      .filter(([, c]) => c.name !== 'Name' && c.name !== 'Title')
      .map(([shortname, c]) => ({
        key: shortname,
        name: c.name,
        type: datatypeToType(c.datatype),
        shortnames: [shortname],
        options: new Map<string, NotionOption>(),
        order: [],
      }));

    return [
      titleColumn(),
      ...(scope === ALL ? [fixed('database')] : []),
      ...(scope === ALL ? [] : extra),
      fixed('edited'),
    ];
  }

  // "All": properties whose name and type every database has.
  const [first, ...rest] = reports.map(propertyColumns);
  const shared = (first ?? []).flatMap(column => {
    const matches = rest.map(cols =>
      cols.find(c => c.name === column.name && c.type === column.type),
    );
    if (matches.some(m => !m)) return [];
    const all = [column, ...(matches as ViewColumn[])];

    return [
      {
        ...column,
        key: `all:${column.type}:${column.name}`,
        shortnames: all.flatMap(c => c.shortnames),
        options: new Map(all.flatMap(c => [...c.options])),
        order: all.flatMap(c => c.order),
      },
    ];
  });

  return [titleColumn(), fixed('database'), ...shared, fixed('edited')];
}

export function cellValue(row: Row, column: ViewColumn): JSONValue {
  if (column.type === 'title') return row.name;
  if (column.type === 'database') return row.dataSource;
  if (column.type === 'edited') return row.lastEdited;

  for (const shortname of column.shortnames)
    if (row.values[shortname] !== undefined) return row.values[shortname];

  return undefined;
}

export const optionIds = (value: JSONValue): string[] =>
  Array.isArray(value)
    ? value.filter((v): v is string => typeof v === 'string')
    : typeof value === 'string'
      ? [value]
      : [];

/** Text a person would search for in a cell: names, not option ids. */
export function cellText(row: Row, column: ViewColumn): string {
  const value = cellValue(row, column);
  if (OPTION_TYPES.has(column.type))
    return optionIds(value)
      .map(id => column.options.get(id)?.name ?? '')
      .join(' ');

  return typeof value === 'string' ? value : '';
}

/** Case-insensitive match on the title, text and option columns. */
export function searchRows(
  rows: readonly Row[],
  columns: readonly ViewColumn[],
  query: string,
): Row[] {
  const q = query.trim().toLocaleLowerCase();
  if (!q) return [...rows];
  const searchable = columns.filter(
    c => TEXT_TYPES.has(c.type) || OPTION_TYPES.has(c.type) || c.type === 'database',
  );

  return rows.filter(row =>
    searchable.some(c => cellText(row, c).toLocaleLowerCase().includes(q)),
  );
}

export interface Sort {
  key: string;
  dir: 'asc' | 'desc';
}

export const DEFAULT_SORT: Sort = { key: 'edited', dir: 'desc' };

/** Header click: ascending, then descending, then off. */
export function nextSort(current: Sort | null, key: string): Sort | null {
  if (!current || current.key !== key) return { key, dir: 'asc' };
  if (current.dir === 'asc') return { key, dir: 'desc' };

  return null;
}

const sortKey = (row: Row, column: ViewColumn): string | number | undefined => {
  const value = cellValue(row, column);
  if (typeof value === 'number') return value;
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (OPTION_TYPES.has(column.type)) {
    const [id] = optionIds(value);
    if (id === undefined) return undefined;
    const at = column.order.findIndex(o => o.id === id);

    // Options sort in Notion's order, as Notion does.
    return at < 0 ? Number.MAX_SAFE_INTEGER : at;
  }

  return typeof value === 'string' ? value.toLocaleLowerCase() : undefined;
};

/** Sorted copy; empty values last in both directions. */
export function sortRows(
  rows: readonly Row[],
  columns: readonly ViewColumn[],
  sort: Sort | null,
): Row[] {
  const column = sort && columns.find(c => c.key === sort.key);
  if (!sort || !column) return [...rows];
  const sign = sort.dir === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    const x = sortKey(a, column);
    const y = sortKey(b, column);
    if (x === undefined || y === undefined)
      return x === y ? 0 : x === undefined ? 1 : -1;
    if (typeof x === 'number' && typeof y === 'number') return (x - y) * sign;

    return String(x).localeCompare(String(y)) * sign;
  });
}

/** Status first, then select: what a board can group by (DESIGN.md S8). */
export const groupable = (columns: readonly ViewColumn[]) => [
  ...columns.filter(c => c.type === 'status'),
  ...columns.filter(c => c.type === 'select'),
];

export interface BoardGroup {
  key: string;
  option?: NotionOption;
  rows: Row[];
}

/** One group per option in Notion's order, then "No value" when any row has none. */
export function groupRows(rows: readonly Row[], column: ViewColumn): BoardGroup[] {
  const groups: BoardGroup[] = column.order.map(option => ({
    key: option.id,
    option,
    rows: [],
  }));
  const byId = new Map(groups.map(g => [g.key, g]));
  const none: BoardGroup = { key: '', rows: [] };

  for (const row of rows) {
    const [id] = optionIds(cellValue(row, column));
    const group = id === undefined ? undefined : byId.get(id);
    if (group) group.rows.push(row);
    else if (id !== undefined) {
      // An option the record does not know (added in Notion since): its own group.
      const added: BoardGroup = { key: id, rows: [row] };
      byId.set(id, added);
      groups.push(added);
    } else none.rows.push(row);
  }

  return none.rows.length ? [...groups, none] : groups;
}

/** Grouped warning lines of a record, as the sync details list them. */
export function notes(record: SyncRecord | undefined): number {
  if (!record) return 0;

  return (
    record.general.length +
    record.dataSources.reduce(
      (n, d) =>
        n +
        new Set(d.formatted.map(f => f.property)).size +
        (d.archived.length ? 1 : 0) +
        d.errors.length,
      0,
    )
  );
}

export function pill(state: ViewState, now: number, locale?: string): PillModel | undefined {
  switch (state.kind) {
    case 'loading':
    case 'no-proxy':
    case 'not-connected':
    case 'connecting':
      return undefined;
    case 'syncing': {
      const active = [...state.progress].reverse().find(p => p.phase !== 'done');

      return { tone: 'sync', text: active ? `Syncing… ${active.title}` : 'Syncing…' };
    }
    case 'importing': {
      const total = state.progress.length;
      if (!total) return { tone: 'sync', text: 'Importing…' };
      const at = Math.min(total, state.progress.filter(p => p.phase === 'done').length + 1);

      return {
        tone: 'sync',
        text: `Importing ${at} of ${total} ${total === 1 ? 'database' : 'databases'}`,
      };
    }
    case 'no-databases':
      return { tone: 'warn', text: 'No databases shared' };
    case 'reauth':
      return { tone: 'neg', text: 'Reconnect needed' };
    case 'rate-limited':
      return { tone: 'warn', text: `Paused until ${clock(state.retryAt, locale)}` };
    case 'failed':
      return { tone: 'neg', text: 'Sync failed' };
    case 'ready': {
      if (!state.last) return { tone: 'muted', text: 'Not synced yet' };
      const n = notes(state.last);

      return n
        ? { tone: 'warn', text: `Synced · ${n} ${n === 1 ? 'note' : 'notes'}` }
        : { tone: 'ok', text: `Synced ${ago(state.last.at, now)}` };
    }
  }
}

/** Whether the header's "Sync now" is offered, and enabled. */
export function syncAction(state: ViewState): { shown: boolean; enabled: boolean } {
  if (!('rows' in state) || state.kind === 'reauth') return { shown: false, enabled: false };

  return {
    shown: true,
    enabled: !isRunning(state) && state.kind !== 'rate-limited' && !!state.connectionId,
  };
}

/** The default view for a frame width (DESIGN.md §5: List below 640px). */
export const defaultView = (narrow: boolean): ViewKind => (narrow ? 'list' : 'table');
