// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { run } from '../plugin.js';
import { compare, decodeStatement, read, tooLarge } from './check.js';
import {
  createController,
  type ChosenFile,
  type ImportPort,
  type State,
} from './controller.js';
import { fakeStore, property, TABLE, type SeedRow } from './fakeStore.js';
import { readRow, type Txn } from './rows.js';

const mt940 = readFileSync(
  new URL('../fixtures/synthetic.mt940', import.meta.url),
  'utf8',
);
const camt = readFileSync(
  new URL('../fixtures/synthetic.camt053.xml', import.meta.url),
  'utf8',
);

/** What the sandbox importer would store for `text`, as seed rows. */
function imported(text: string): SeedRow[] {
  const shortnames = [
    'bank-account',
    'bank-currency',
    'bank-amount',
    'bank-value-date',
    'bank-booking-date',
    'bank-description',
    'bank-reference',
    'bank-transaction-code',
    'bank-statement',
    'bank-source-id',
    'bank-fingerprint',
  ];
  const properties = Object.fromEntries(shortnames.map(s => [s, property(s)]));
  const { intents } = run({
    text,
    config: { table: TABLE, rowClass: 'x', properties },
    query: () => [],
    read: () => ({}),
  }) as { intents: { set: Record<string, string> }[] };

  return intents.map(
    intent =>
      Object.fromEntries(
        shortnames.map(s => [s, intent.set[property(s)]]),
      ) as SeedRow,
  );
}

const asTxn = (rows: SeedRow[]): Txn[] => {
  const fields = Object.fromEntries(
    Object.keys(rows[0]).map(s => [s, property(s)]),
  );

  return rows.map(
    (row, i) =>
      readRow(
        {
          subject: `row-${i}`,
          get: p => Object.entries(row).find(([s]) => property(s) === p)?.[1],
        },
        fields,
      )!,
  );
};

describe('checking a file against the table (same rules as the importer)', () => {
  it('everything is new in an empty table', () => {
    const parsed = read(mt940);
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    const result = compare(parsed.format, parsed.statements, []);
    expect(result.ok && result.preview.fresh.map(r => r.amount)).toEqual([
      '20',
      '-12.34',
    ]);
  });

  it('a reimport is all "already imported", and camt.053 of the same period is new', () => {
    const table = asTxn(imported(mt940));
    const again = read(mt940);
    if (!again.ok) throw new Error('unreadable');
    const result = compare(again.format, again.statements, table);
    expect(result.ok && result.preview.fresh).toEqual([]);
    expect(result.ok && result.preview.already).toHaveLength(2);
    const other = read(camt);
    if (!other.ok) throw new Error('unreadable');
    const second = compare(other.format, other.statements, table);
    expect(second.ok && second.preview.fresh).toHaveLength(2);
  });

  it('a changed transaction blocks the file, naming what differs', () => {
    const table = asTxn(imported(mt940));
    const parsed = read(mt940.replace('Fixture lunch', 'Fixture dinner'));
    if (!parsed.ok) throw new Error('unreadable');
    const result = compare(parsed.format, parsed.statements, table);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problem.code).toBe('CHANGED_TRANSACTION');
    expect(result.problem.count).toBe(1);
    expect(result.problem.changed?.fields).toEqual(['description']);
    expect(result.problem.changed?.mine.description).toBe('Fixture lunch');
    expect(result.problem.changed?.file.description).toBe('Fixture dinner');
  });

  it('reference-free overlap with an earlier import is refused, as the importer does', () => {
    const noRefs = mt940.replace(/\/\/TEST-\d/g, '');
    const table = asTxn(imported(noRefs));
    // Same rows, other statement metadata: other identities, same content.
    const parsed = read(noRefs.replace(':28C:1/1', ':28C:2/1'));
    if (!parsed.ok) throw new Error('unreadable');
    const result = compare(parsed.format, parsed.statements, table);
    expect(!result.ok && result.problem.code).toBe(
      'OVERLAP_WITHOUT_REFERENCES',
    );
    // The same file again is safe.
    const same = read(noRefs);
    if (!same.ok) throw new Error('unreadable');
    const safe = compare(same.format, same.statements, table);
    expect(safe.ok && safe.preview.already).toHaveLength(2);
    expect(safe.ok && safe.preview.withoutReference).toBe(2);
  });

  it('reports reader failures with their codes', () => {
    expect(read(mt940.replace('107,66', '107,67'))).toMatchObject({
      ok: false,
      problem: { code: 'BALANCE_MISMATCH' },
    });
    expect(read('hello')).toMatchObject({
      ok: false,
      problem: { code: 'INVALID_FIELD' },
    });
    expect(tooLarge(5_000_001)?.code).toBe('FILE_TOO_LARGE');
    expect(tooLarge(5_000_000)).toBeUndefined();
  });

  it('decodes UTF-8, and Windows-1252 when the bytes are not UTF-8', () => {
    expect(decodeStatement(new TextEncoder().encode('Café'))).toBe('Café');
    expect(decodeStatement(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toBe(
      'Café',
    );
  });
});

describe('import sheet states', () => {
  const file = (text: string, name = 'bunq-2026-09.sta'): ChosenFile => ({
    name,
    size: text.length,
    text: async () => text,
  });

  function sheet(options: { rows?: SeedRow[]; importer?: ImportPort } = {}) {
    const store = fakeStore({ rows: options.rows ?? [] });
    const seen: State[] = [];
    const controller = createController(store, s => seen.push(s), {
      importer: options.importer,
      tick: async () => {},
    });

    return { store, controller, seen };
  }

  it('ticks the three checklist lines in order, then previews', async () => {
    const { controller, seen } = sheet();
    await controller.load();
    await controller.importFile(file(mt940));
    const lines = seen
      .map(s => s.importing)
      .filter(s => s?.step === 'checking')
      .map(s => (s!.step === 'checking' ? s!.lines.join(' ') : ''));
    expect([...new Set(lines)]).toEqual([
      'now todo todo',
      'done now todo',
      'done done now',
    ]);
    const preview = controller.state().importing;
    expect(preview?.step).toBe('preview');
    if (preview?.step !== 'preview') return;
    expect(preview.file).toEqual({
      name: 'bunq-2026-09.sta',
      size: mt940.length,
      format: 'mt940',
    });
    expect(preview.tab).toBe('new');
    expect(preview.preview.fresh).toHaveLength(2);
    expect(controller.state().canApply).toBe(false);
  });

  it('opens on "Already imported" when nothing is new', async () => {
    const { controller } = sheet({ rows: imported(mt940) });
    await controller.load();
    await controller.importFile(file(mt940));
    const preview = controller.state().importing;
    expect(preview?.step === 'preview' && preview.tab).toBe('already');
    expect(preview?.step === 'preview' && preview.preview.fresh).toEqual([]);
  });

  it('cancelling during the check leaves no sheet behind', async () => {
    const store = fakeStore();
    let release!: () => void;
    const controller = createController(store, () => {}, {
      tick: () => new Promise(resolve => (release = resolve)),
    });
    await controller.load();
    const pending = controller.importFile(file(mt940));
    await Promise.resolve();
    await Promise.resolve();
    expect(controller.state().importing?.step).toBe('checking');
    controller.closeImport();
    release();
    await pending;
    expect(controller.state().importing).toBeUndefined();
  });

  it('balance errors fail; conflicts and oversized files block', async () => {
    const { controller } = sheet({ rows: imported(mt940) });
    await controller.load();
    await controller.importFile(file(mt940.replace('107,66', '107,67')));
    expect(controller.state().importing).toMatchObject({
      step: 'error',
      problem: { code: 'BALANCE_MISMATCH' },
    });
    await controller.importFile(file(mt940.replace('Fixture lunch', 'Other')));
    expect(controller.state().importing).toMatchObject({
      step: 'blocked',
      problem: { code: 'CHANGED_TRANSACTION' },
    });
    await controller.importFile({
      name: 'huge.xml',
      size: 6_000_000,
      text: async () => {
        throw new Error('must not be read');
      },
    });
    expect(controller.state().importing).toMatchObject({
      step: 'blocked',
      problem: { code: 'FILE_TOO_LARGE' },
    });
  });

  it('applies through the import port when the host offers one', async () => {
    const applied: string[] = [];
    const { controller } = sheet({
      importer: {
        apply: async (text, info) => {
          applied.push(`${info.name}:${text.length}`);

          return { created: 2 };
        },
      },
    });
    await controller.load();
    expect(controller.state().canApply).toBe(true);
    await controller.importFile(file(mt940));
    await controller.applyImport();
    expect(applied).toEqual([`bunq-2026-09.sta:${mt940.length}`]);
    expect(controller.state().importing).toBeUndefined();
    expect(controller.state().arrived).toEqual({ count: 2 });
  });

  it('keeps the preview and says why when applying fails', async () => {
    const { controller } = sheet({
      importer: {
        apply: async () => {
          throw new Error('Refused by the host');
        },
      },
    });
    await controller.load();
    await controller.importFile(file(mt940));
    await controller.applyImport();
    expect(controller.state().importing).toMatchObject({
      step: 'preview',
      applying: false,
      failure: 'Refused by the host',
    });
  });
});
