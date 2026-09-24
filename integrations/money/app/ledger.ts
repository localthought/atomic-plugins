// @wc-ignore-file
/**
 * The Transactions tab's filters, as pure functions over `Txn` rows
 * (DESIGN.md 6.6, 6.10). Dates are ISO strings compared as text; `today` is
 * passed in so tests (and the screenshot harness) pin it.
 */
import { isOut } from './amounts.js';
import type { Txn } from './rows.js';

export type PeriodKind =
  | 'all'
  | 'this-month'
  | 'last-month'
  | 'this-year'
  | 'custom';

export interface Period {
  kind: PeriodKind;
  /** Inclusive ISO dates, for `custom`. Either may be empty. */
  from?: string;
  to?: string;
}

export type Direction = 'all' | 'in' | 'out';

/** A statement as the rows name it (`bank-statement` per account + format). */
export interface StatementKey {
  account: string;
  currency: string;
  statement: string;
  format?: string;
}

export interface Filters {
  /** `accountKey()` of one account + currency, or `''` for all. */
  account: string;
  query: string;
  period: Period;
  direction: Direction;
  uncategorised: boolean;
  statement?: StatementKey;
}

export const WINDOW = 200;

export const accountKey = (account: string, currency: string) =>
  JSON.stringify([account, currency]);

export const statementMatches = (row: Txn, key: StatementKey) =>
  row.account === key.account &&
  row.currency === key.currency &&
  row.statement === key.statement &&
  (key.format === undefined || row.format === key.format);

const pad = (n: number) => String(n).padStart(2, '0');

/** Inclusive ISO range for a period, relative to `today` (ISO date). */
export function periodRange(
  period: Period,
  today: string,
): { from?: string; to?: string } {
  const year = +today.slice(0, 4);
  const month = +today.slice(5, 7);

  switch (period.kind) {
    case 'all':
      return {};
    case 'this-month':
      return {
        from: `${year}-${pad(month)}-01`,
        to: `${year}-${pad(month)}-31`,
      };

    case 'last-month': {
      const y = month === 1 ? year - 1 : year;
      const m = month === 1 ? 12 : month - 1;

      return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-31` };
    }

    case 'this-year':
      return { from: `${year}-01-01`, to: `${year}-12-31` };
    case 'custom':
      return { from: period.from || undefined, to: period.to || undefined };
  }
}

export const inPeriod = (row: Txn, period: Period, today: string) => {
  const { from, to } = periodRange(period, today);

  return (!from || row.bookingDate >= from) && (!to || row.bookingDate <= to);
};

export const matchesQuery = (row: Txn, query: string) => {
  const q = query.trim().toLowerCase();

  return (
    !q ||
    row.description.toLowerCase().includes(q) ||
    row.reference.toLowerCase().includes(q)
  );
};

export const matchesDirection = (row: Txn, direction: Direction) =>
  direction === 'all' || (direction === 'out') === isOut(row.amount);

/** Every filter except the account: what the summary strip totals. */
export function filterExceptAccount(
  rows: Txn[],
  filters: Filters,
  today: string,
): Txn[] {
  return rows.filter(
    row =>
      inPeriod(row, filters.period, today) &&
      matchesQuery(row, filters.query) &&
      matchesDirection(row, filters.direction) &&
      (!filters.uncategorised || !row.category) &&
      (!filters.statement || statementMatches(row, filters.statement)),
  );
}

export function applyFilters(
  rows: Txn[],
  filters: Filters,
  today: string,
): Txn[] {
  return filterExceptAccount(rows, filters, today).filter(
    row =>
      !filters.account ||
      accountKey(row.account, row.currency) === filters.account,
  );
}

/** Newest booking first; rows of one day keep their import order. */
export function sortNewestFirst(rows: Txn[]): Txn[] {
  return rows
    .map((row, index) => ({ row, index }))
    .sort((a, b) =>
      a.row.bookingDate === b.row.bookingDate
        ? a.index - b.index
        : a.row.bookingDate < b.row.bookingDate
          ? 1
          : -1,
    )
    .map(({ row }) => row);
}

export interface AccountOption {
  key: string;
  account: string;
  currency: string;
  count: number;
}

/** Distinct account + currency pairs, most rows first. */
export function accounts(rows: Txn[]): AccountOption[] {
  const map = new Map<string, AccountOption>();

  for (const row of rows) {
    const key = accountKey(row.account, row.currency);
    const entry = map.get(key);
    if (entry) entry.count++;
    else
      map.set(key, {
        key,
        account: row.account,
        currency: row.currency,
        count: 1,
      });
  }

  return [...map.values()].sort((a, b) => b.count - a.count);
}

/** This month when it has rows, otherwise all periods: never open on nothing. */
export function defaultPeriod(rows: Txn[], today: string): Period {
  const month: Period = { kind: 'this-month' };

  return rows.some(row => inPeriod(row, month, today))
    ? month
    : { kind: 'all' };
}

export const noFilters = (period: Period): Filters => ({
  account: '',
  query: '',
  period,
  direction: 'all',
  uncategorised: false,
});

export const hasNarrowingFilters = (filters: Filters) =>
  Boolean(
    filters.query.trim() ||
    filters.period.kind !== 'all' ||
    filters.direction !== 'all' ||
    filters.uncategorised ||
    filters.statement ||
    filters.account,
  );

/** The latest booking date among the rows, for the status pill. */
export const latestDate = (rows: Txn[]) =>
  rows.reduce<string>(
    (max, r) => (r.bookingDate > max ? r.bookingDate : max),
    '',
  );

/** Categories already used in the table, most used first (combobox source). */
export function categories(rows: Txn[]): string[] {
  const counts = new Map<string, number>();
  for (const row of rows)
    if (row.category)
      counts.set(row.category, (counts.get(row.category) ?? 0) + 1);

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .map(([name]) => name);
}
