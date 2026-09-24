import { describe, expect, it } from 'vitest';
import { parseMT940 } from './parser';
import { run } from './plugin';

export const fixture = `:20:SYNTHETIC
:25:NL00BUNQ0000000000
:28C:1/1
:60F:C260901EUR100,00
:61:2609020902D12,34NTRFNONREF//TEST-1
:86:Lunch
Second line
:61:2609030903C20,00NTRFNONREF//TEST-2
:86:Refund
:62F:C260903EUR107,66
`;
const p = Object.fromEntries(
  [
    'account',
    'currency',
    'amount',
    'value-date',
    'booking-date',
    'description',
    'reference',
    'transaction-code',
    'statement',
    'source-id',
    'fingerprint',
  ].map(k => [`bank-${k}`, `https://example.com/${k}`]),
);
const config = {
  table: 'https://example.com/table',
  rowClass: 'https://example.com/transaction',
  properties: p,
};
const host = {
  text: fixture,
  config,
  query: () => [] as string[],
  read: () => ({}),
};
interface Intent {
  parent: string;
  isA?: string[];
  set: Record<string, unknown>;
}
describe('MT940 parser and import proposals', () => {
  it('rejects JSON-shaped narratives rather than letting legacy persistence reinterpret text', () => {
    expect(() =>
      parseMT940(fixture.replace('Lunch\nSecond line', '["literal text"]')),
    ).toThrow('JSON-shaped');
  });
  it('preserves exact debits, credits, dates and multiline descriptions', () => {
    const [statement] = parseMT940(fixture.replace(/\n/g, '\r\n'));
    expect(statement.transactions[0]).toMatchObject({
      amount: '-12.34',
      date: '2026-09-02',
      description: 'Lunch\nSecond line',
    });
    expect(statement.closing).toBe('107.66');
  });
  it('reconciles reversals and large exact amounts', () => {
    const sample = fixture
      .replace('D12,34', 'RC12,34')
      .replace('C20,00N', 'RD20,00N');
    expect(parseMT940(sample)[0].transactions.map(t => t.amount)).toEqual([
      '-12.34',
      '20',
    ]);
    expect(
      parseMT940(
        fixture
          .replace('EUR100,00', 'EUR900719925474099,00')
          .replace('EUR107,66', 'EUR900719925474106,66'),
      )[0].closing,
    ).toBe('900719925474106.66');
  });
  it('rejects wrong balances, invalid dates, truncation and unsupported fields', () => {
    for (const invalid of [
      fixture.replace('107,66', '107,67'),
      fixture.replace('260902', '260230'),
      fixture.split(':62F:')[0],
      fixture + ':99:unknown',
    ])
      expect(() => parseMT940(invalid)).toThrow();
  });
  it('supports multiple accounts and booking year rollover', () => {
    expect(
      parseMT940(fixture + fixture.replace('0000000000', '0000000001')),
    ).toHaveLength(2);
    expect(
      parseMT940(fixture.replace('2609020902', '2601011231'))[0].transactions[0]
        .bookingDate,
    ).toBe('2025-12-31');
  });
  it('nests rows under the table and skips identical reimports', () => {
    const verdict = run(host);
    const first = verdict.intents[0] as Intent;
    expect(first.parent).toBe(config.table);
    expect(first.set[p['bank-amount']]).toBe('-12.34');
    const saved = new Map(
      (verdict.intents as Intent[]).map((i, n) => [
        String(n),
        {
          ...i.set,
          'https://atomicdata.dev/properties/parent': i.parent,
          'https://atomicdata.dev/properties/isA': i.isA,
        },
      ]),
    );
    expect(
      run({
        ...host,
        query: (prop, value) =>
          [...saved].filter(([, v]) => v[prop] === value).map(([id]) => id),
        read: id => saved.get(id)!,
      }).intents,
    ).toHaveLength(0);
  });
  it('blocks changed referenced transactions and ambiguous reference-free overlap', () => {
    const first = run(host).intents[0] as Intent;
    const saved: Record<string, unknown> = {
      ...first.set,
      'https://atomicdata.dev/properties/parent': config.table,
      'https://atomicdata.dev/properties/isA': [config.rowClass],
    };
    const changed = run({
      ...host,
      text: fixture.replace('Lunch', 'Changed lunch'),
      query: (property, value) => (saved[property] === value ? ['saved'] : []),
      read: () => saved,
    });
    expect(changed.problems.some(problem => problem.severity === 'error')).toBe(
      true,
    );
    expect(() =>
      run({
        ...host,
        text: fixture.replace(/\/\/TEST-\d/g, ''),
        query: prop => (prop === p['bank-fingerprint'] ? ['saved'] : []),
        read: () => ({
          'https://atomicdata.dev/properties/parent': config.table,
        }),
      }),
    ).toThrow('overlaps');
  });
  it('preserves identical legitimate reference-free transactions within one statement', () => {
    const sample = fixture
      .replace(/\/\/TEST-\d/g, '')
      .replace(
        ':62F:C260903EUR107,66',
        ':61:2609020902D12,34NTRFNONREF\n:86:Lunch\nSecond line\n:62F:C260903EUR95,32',
      );
    expect(run({ ...host, text: sample }).intents).toHaveLength(3);
  });
  it('bounds files and transaction counts', () => {
    expect(() => parseMT940('x'.repeat(512001))).toThrow('512 KB');
    expect(() =>
      parseMT940(
        ':25:test\n:28C:1\n:60F:C260901EUR0,\n' +
          ':61:260901C0,NTRFNONREF\n'.repeat(501) +
          ':62F:C260901EUR0,',
      ),
    ).toThrow('500');
  });
});

describe('structured errors (code + data, same message)', () => {
  const caught = (read: () => unknown) => {
    try {
      read();
    } catch (error) {
      return error as { code?: string; data?: unknown; message: string };
    }

    throw new Error('expected a throw');
  };

  it('BALANCE_MISMATCH carries the figures of the failing statement', () => {
    const error = caught(() => parseMT940(fixture.replace('107,66', '107,67')));
    expect(error.message).toBe(
      'Statement balance does not reconcile; no transactions will be imported',
    );
    expect(error.code).toBe('BALANCE_MISMATCH');
    expect(error.data).toEqual({
      statement: '1/1',
      account: 'NL00BUNQ0000000000',
      currency: 'EUR',
      opening: '100',
      entries: 2,
      entriesSum: '7.66',
      expectedClosing: '107.66',
      closing: '107.67',
      start: '2026-09-01',
      end: '2026-09-03',
    });
  });

  it('JSON_NARRATIVE counts every affected row', () => {
    const error = caught(() =>
      parseMT940(
        fixture
          .replace('Lunch\nSecond line', '["literal text"]')
          .replace('Refund', '{"a":1}'),
      ),
    );
    expect(error.code).toBe('JSON_NARRATIVE');
    expect(error.data).toEqual({ count: 2 });
    expect(error.message).toMatch(/JSON-shaped/);
  });

  it('INVALID_FIELD names the tag and the 1-based line', () => {
    const unknown = caught(() => parseMT940(fixture + ':99:unknown'));
    expect(unknown.code).toBe('INVALID_FIELD');
    expect(unknown.data).toEqual({ tag: '99', line: 11 });
    expect(unknown.message).toBe('Unsupported MT940 field :99:');
    const date = caught(() =>
      parseMT940(fixture.replace('2609020902', '2602300230')),
    );
    expect(date.code).toBe('INVALID_FIELD');
    expect(date.data).toEqual({ tag: '61', line: 5 });
    expect(date.message).toBe('Invalid MT940 date');
  });

  it('FILE_TOO_LARGE, TOO_MANY_ENTRIES and MISSING_BALANCE', () => {
    expect(caught(() => parseMT940('x'.repeat(512001)))).toMatchObject({
      code: 'FILE_TOO_LARGE',
      data: { limit: 512000, format: 'mt940' },
    });
    expect(
      caught(() =>
        parseMT940(
          ':25:test\n:28C:1\n:60F:C260901EUR0,\n' +
            ':61:260901C0,NTRFNONREF\n'.repeat(501) +
            ':62F:C260901EUR0,',
        ),
      ),
    ).toMatchObject({ code: 'TOO_MANY_ENTRIES', data: { limit: 500 } });
    expect(caught(() => parseMT940(fixture.split(':62F:')[0]))).toMatchObject({
      code: 'MISSING_BALANCE',
      data: { statement: '1/1' },
    });
  });

  it('REPEATED_REFERENCE, CONFLICTING_REFERENCE and OVERLAP_WITHOUT_REFERENCES from the importer', () => {
    const twice = fixture.replace(
      ':62F:C260903EUR107,66',
      ':61:2609020902D12,34NTRFNONREF//TEST-1\n:86:Lunch\nSecond line\n:62F:C260903EUR95,32',
    );
    expect(caught(() => run({ ...host, text: twice }))).toMatchObject({
      code: 'REPEATED_REFERENCE',
      data: { reference: 'TEST-1' },
      message:
        'Repeated bank transaction reference in this file; export non-overlapping statements',
    });
    const changed = twice.replace('Lunch\nSecond line\n:62F', 'Dinner\n:62F');
    expect(caught(() => run({ ...host, text: changed }))).toMatchObject({
      code: 'CONFLICTING_REFERENCE',
      data: { reference: 'TEST-1' },
    });
    const overlap = caught(() =>
      run({
        ...host,
        text: fixture.replace(/\/\/TEST-\d/g, ''),
        query: prop => (prop === p['bank-fingerprint'] ? ['saved'] : []),
        read: () => ({
          'https://atomicdata.dev/properties/parent': config.table,
          [p['bank-value-date']]: '2026-08-30',
        }),
      }),
    );
    expect(overlap).toMatchObject({
      code: 'OVERLAP_WITHOUT_REFERENCES',
      data: {
        statement: '1/1',
        account: 'NL00BUNQ0000000000',
        thisPeriod: { start: '2026-09-01', end: '2026-09-03' },
        overlappingDate: '2026-08-30',
      },
    });
    expect(overlap.message).toMatch(/overlaps/);
  });
});
