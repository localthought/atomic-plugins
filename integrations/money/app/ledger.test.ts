// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  accountKey,
  accounts,
  applyFilters,
  categories,
  closingBalance,
  defaultPeriod,
  filterExceptAccount,
  importedStatements,
  noFilters,
  periodRange,
  sortNewestFirst,
  type Filters,
} from './ledger.js';
import {
  dayLabel,
  groupAccount,
  periodLabel,
  rangeLabel,
  shortAccount,
} from './format.js';
import type { Txn } from './rows.js';

const TODAY = '2026-09-24';

let n = 0;
const txn = (amount: string, date: string, extra: Partial<Txn> = {}): Txn => ({
  subject: `s${++n}`,
  account: 'NL42BUNQ0123456789',
  currency: 'EUR',
  amount,
  valueDate: date,
  bookingDate: date,
  description: `Payment ${amount}`,
  reference: `REF${n}`,
  code: 'NTRF',
  statement: '31/1',
  sourceId: '',
  fingerprint: '',
  format: 'mt940',
  category: '',
  note: '',
  ...extra,
});

/** 500 rows over two accounts, three currencies and a year and a half. */
function table(): Txn[] {
  const rows: Txn[] = [];

  for (let i = 0; i < 500; i++) {
    const month = (i % 18) + 1;
    const year = month > 12 ? 2026 : 2025;
    const m = month > 12 ? month - 12 + 3 : month;
    const date = `${year}-${String(m).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}`;
    rows.push(
      txn(i % 3 ? `-${i}.25` : `${i * 10}`, date, {
        account: i % 5 ? 'NL42BUNQ0123456789' : 'NL18RABO0301224456',
        currency: i % 7 ? 'EUR' : 'USD',
        description:
          i % 11 === 0 ? `KPN B.V. factuur ${i}` : `/REMI/Albert Heijn ${i}`,
        category: i % 4 ? 'Groceries' : '',
      }),
    );
  }

  return rows;
}

const filters = (patch: Partial<Filters> = {}): Filters => ({
  ...noFilters({ kind: 'all' }),
  ...patch,
});

describe('ledger filters over a 500-row table', () => {
  const rows = table();

  it('all filters off keeps every row', () => {
    expect(applyFilters(rows, filters(), TODAY)).toHaveLength(500);
  });

  it('search is a case-insensitive substring of description or reference', () => {
    const kpn = applyFilters(rows, filters({ query: 'kpn b.v' }), TODAY);
    expect(kpn.length).toBe(rows.filter((_, i) => i % 11 === 0).length);
    expect(kpn.every(r => r.description.startsWith('KPN'))).toBe(true);
    const ref = rows[42].reference;
    expect(
      applyFilters(rows, filters({ query: ref.toLowerCase() }), TODAY).map(
        r => r.subject,
      ),
    ).toContain(rows[42].subject);
  });

  it('periods cover this month, last month, this year and a custom range', () => {
    const count = (period: Filters['period']) =>
      applyFilters(rows, filters({ period }), TODAY).length;
    const expected = (from: string, to: string) =>
      rows.filter(r => r.bookingDate >= from && r.bookingDate <= to).length;
    expect(count({ kind: 'this-month' })).toBe(
      expected('2026-09-01', '2026-09-31'),
    );
    expect(count({ kind: 'last-month' })).toBe(
      expected('2026-08-01', '2026-08-31'),
    );
    expect(count({ kind: 'this-year' })).toBe(
      expected('2026-01-01', '2026-12-31'),
    );
    expect(
      count({ kind: 'custom', from: '2025-03-01', to: '2025-04-15' }),
    ).toBe(expected('2025-03-01', '2025-04-15'));
    expect(count({ kind: 'custom', from: '2026-06-01' })).toBe(
      expected('2026-06-01', '9999'),
    );
  });

  it('last month wraps to December of the previous year in January', () => {
    expect(periodRange({ kind: 'last-month' }, '2026-01-10')).toEqual({
      from: '2025-12-01',
      to: '2025-12-31',
    });
  });

  it('direction splits by sign; in + out is everything', () => {
    const ins = applyFilters(rows, filters({ direction: 'in' }), TODAY);
    const outs = applyFilters(rows, filters({ direction: 'out' }), TODAY);
    expect(ins.every(r => !r.amount.startsWith('-'))).toBe(true);
    expect(outs.every(r => r.amount.startsWith('-'))).toBe(true);
    expect(ins.length + outs.length).toBe(500);
  });

  it('uncategorised keeps only rows without a category', () => {
    const open = applyFilters(rows, filters({ uncategorised: true }), TODAY);
    expect(open.length).toBe(rows.filter((_, i) => i % 4 === 0).length);
  });

  it('the account filter is account + currency; the strip ignores it', () => {
    const key = accountKey('NL18RABO0301224456', 'USD');
    const only = applyFilters(rows, filters({ account: key }), TODAY);
    expect(only.length).toBeGreaterThan(0);
    expect(
      only.every(
        r => r.account === 'NL18RABO0301224456' && r.currency === 'USD',
      ),
    ).toBe(true);
    expect(
      filterExceptAccount(rows, filters({ account: key }), TODAY),
    ).toHaveLength(500);
  });

  it('combines filters with AND', () => {
    const f = filters({
      query: 'albert',
      direction: 'out',
      period: { kind: 'this-year' },
      account: accountKey('NL42BUNQ0123456789', 'EUR'),
      uncategorised: true,
    });
    const result = applyFilters(rows, f, TODAY);
    expect(result.length).toBeGreaterThan(0);

    for (const r of result) {
      expect(r.description).toMatch(/Albert/);
      expect(r.amount.startsWith('-')).toBe(true);
      expect(r.bookingDate.startsWith('2026')).toBe(true);
      expect(r.category).toBe('');
      expect(r.account).toBe('NL42BUNQ0123456789');
    }
  });

  it('lists accounts by row count and categories by use', () => {
    const list = accounts(rows);
    expect(list).toHaveLength(4);
    expect(list[0]).toMatchObject({
      account: 'NL42BUNQ0123456789',
      currency: 'EUR',
    });
    expect(categories(rows)).toEqual(['Groceries']);
  });

  it('sorts newest booking first and keeps import order within a day', () => {
    const a = txn('1', '2026-09-01');
    const b = txn('2', '2026-09-03');
    const c = txn('3', '2026-09-01');
    expect(sortNewestFirst([a, b, c]).map(r => r.amount)).toEqual([
      '2',
      '1',
      '3',
    ]);
  });

  it('opens on this month only when this month has rows', () => {
    expect(defaultPeriod(rows, TODAY)).toEqual({ kind: 'this-month' });
    expect(defaultPeriod(rows, '2030-01-01')).toEqual({ kind: 'all' });
  });
});

describe('display helpers', () => {
  it('formats dates without shifting the day', () => {
    expect(dayLabel('2026-09-22', 'en-GB')).toMatch(/^Tue 22 Sep/);
    expect(rangeLabel('2026-09-01', '2026-09-22', 'en-GB')).toMatch(
      /^1\s?[–-]\s?22 Sept? 2026$/,
    );
    expect(periodLabel({ kind: 'last-month' }, TODAY, 'en-GB')).toBe(
      'August 2026',
    );
    expect(periodLabel({ kind: 'all' }, TODAY)).toBe('all periods');
  });

  it('groups IBAN-shaped identifiers and leaves others alone', () => {
    expect(groupAccount('NL42BUNQ0123456789')).toBe('NL42 BUNQ 0123 4567 89');
    expect(shortAccount('NL42BUNQ0123456789')).toBe('bunq …4567 89');
    expect(shortAccount('NL18RABO0301224456')).toBe('Rabo …2244 56');
    expect(groupAccount('12345678/EUR')).toBe('12345678/EUR');
    expect(shortAccount('ACC-9')).toBe('ACC-9');
    expect(shortAccount('00012345678901234')).toBe('…9012 34');
  });
});

describe('imported statements (Imports tab)', () => {
  it('groups rows by format, account, currency and statement number, newest first', () => {
    const rows = [
      txn('-1', '2026-08-03', { statement: '30/1' }),
      txn('-2', '2026-09-02', { statement: '31/1' }),
      txn('-3', '2026-09-22', { statement: '31/1' }),
      txn('-4', '2026-09-16', {
        statement: '9/1',
        account: 'NL18RABO0301224456',
      }),
      txn('-5', '2026-09-20', { statement: '31/1', format: 'camt053' }),
    ];
    const list = importedStatements(rows);
    expect(
      list.map(s => [s.key.statement, s.key.format, s.entries, s.start, s.end]),
    ).toEqual([
      ['31/1', 'mt940', 2, '2026-09-02', '2026-09-22'],
      ['31/1', 'camt053', 1, '2026-09-20', '2026-09-20'],
      ['9/1', 'mt940', 1, '2026-09-16', '2026-09-16'],
      ['30/1', 'mt940', 1, '2026-08-03', '2026-08-03'],
    ]);
  });
});

describe('closing balance for the strip (M-12)', () => {
  const s = (end: string, closing: string, account = 'A') => ({
    account,
    currency: 'EUR',
    end,
    closing,
  });

  it('takes the latest statement ending in the period, never a computed one', () => {
    const list = [
      s('2026-08-31', '10'),
      s('2026-09-15', '20'),
      s('2026-09-22', '30'),
      s('2026-09-30', '99', 'B'),
    ];
    expect(
      closingBalance(list, 'A', 'EUR', { kind: 'this-month' }, TODAY),
    ).toEqual({ amount: '30', date: '2026-09-22' });
    expect(
      closingBalance(list, 'A', 'EUR', { kind: 'last-month' }, TODAY),
    ).toEqual({ amount: '10', date: '2026-08-31' });
    expect(
      closingBalance(list, 'A', 'USD', { kind: 'all' }, TODAY),
    ).toBeUndefined();
    expect(
      closingBalance(
        list,
        'A',
        'EUR',
        { kind: 'custom', from: '2026-07-01', to: '2026-07-31' },
        TODAY,
      ),
    ).toBeUndefined();
  });
});
