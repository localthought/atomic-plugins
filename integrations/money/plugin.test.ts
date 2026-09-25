// @wc-ignore-file
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { fixture } from './parser.test';
import { manifest, run } from './plugin';

const properties = Object.fromEntries(
  manifest.destination.schema.properties.map(p => [
    p.shortname,
    `https://example.com/${p.shortname}`,
  ]),
);
const config = {
  table: 'https://example.com/table',
  rowClass: 'https://example.com/bank-transaction',
  properties,
  tables: {
    statements: {
      table: 'https://example.com/statements',
      rowClass: 'https://example.com/bank-statement-record',
    },
  },
};

describe('host declaration (atomic-server#1653)', () => {
  it('accepts one text file up to the camt.053 limit', () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.accepts).toEqual([
      expect.objectContaining({ as: 'text', maxBytes: 5_000_000 }),
    ]);
    for (const extension of manifest.accepts[0].extensions)
      expect(extension).toMatch(/^\.[a-z0-9][a-z0-9._-]*$/);
    // No network, no credentials: the file is the only input.
    expect(manifest.operations).toEqual([]);
    expect(manifest.secrets).toEqual([]);
  });

  it('declares a destination whose config is exactly what run() reads', () => {
    const { schema, table } = manifest.destination;
    const shortnames = new Set(schema.properties.map(p => p.shortname));
    expect(schema.classes.map(c => c.shortname)).toContain(table.rowClass);
    for (const column of table.columns) expect(shortnames).toContain(column);
    for (const klass of schema.classes)
      for (const name of [
        ...(klass.requires ?? []),
        ...(klass.recommends ?? []),
      ])
        expect(shortnames).toContain(name);
    // The host stores { table, rowClass, properties } under config.key.
    expect(manifest.config.key).toBe('money');
    expect(manifest.config.required).toEqual([
      'table',
      'rowClass',
      'properties',
      'tables',
    ]);
    // A second table for the statements (atomic-server#1768).
    const statements = manifest.destination.tables.statements;
    expect(schema.classes.map(c => c.shortname)).toContain(statements.rowClass);
    for (const column of statements.columns)
      expect(shortnames).toContain(column);
  });

  it('keeps the declaration JSON: the host reads it without running code', () => {
    const json = JSON.parse(JSON.stringify(manifest));
    expect(json).toEqual(manifest);
  });

  it('ships the declaration in the committed bundle', () => {
    const bundle = readFileSync(
      new URL('./plugin.js', import.meta.url),
      'utf8',
    );
    expect(bundle).toContain('accepts:');
    expect(bundle).toContain('destination:');
    // schema.ts must stay type-only against the lib, or the sandbox bundle
    // carries the whole client.
    expect(bundle).not.toMatch(/class Store\b|class Client\b/);
  });
});

describe('input', () => {
  const host = {
    config,
    query: () => [] as string[],
    read: () => ({}),
  };

  it('reads the file the host hands over as ctx.upload', () => {
    const result = run({
      ...host,
      upload: { name: 'statement.sta', size: fixture.length, text: fixture },
    });
    // Two transactions and their statement.
    expect(result.intents).toHaveLength(3);
  });

  it('still reads the legacy ctx.text and trigger payload', () => {
    expect(run({ ...host, text: fixture }).intents).toHaveLength(3);
    expect(
      run({ ...host, trigger: { payload: { text: fixture } } }).intents,
    ).toHaveLength(3);
  });

  it('says where to choose a file when none was given', () => {
    expect(() => run(host)).toThrow('under Import');
  });
});

describe('annotations (money-category, money-note)', () => {
  const category = properties['money-category'];
  const note = properties['money-note'];
  const host = {
    config,
    query: () => [] as string[],
    read: () => ({}),
  };

  it('are declared on the row class but never written by the importer', () => {
    const [klass] = manifest.destination.schema.classes;
    expect(klass.recommends).toEqual(
      expect.arrayContaining(['money-category', 'money-note']),
    );
    expect(klass.requires).not.toContain('money-category');

    for (const intent of run({ ...host, text: fixture }).intents as {
      set: Record<string, unknown>;
    }[]) {
      expect(intent.set).not.toHaveProperty(category);
      expect(intent.set).not.toHaveProperty(note);
    }
  });

  it('survive a reimport of the same statement, which proposes nothing', () => {
    const first = run({ ...host, text: fixture }).intents as {
      parent: string;
      isA?: string[];
      set: Record<string, unknown>;
    }[];
    const saved = new Map(
      first.map((intent, n) => [
        `row-${n}`,
        {
          ...intent.set,
          'https://atomicdata.dev/properties/parent': intent.parent,
          'https://atomicdata.dev/properties/isA': intent.isA,
        } as Record<string, unknown>,
      ]),
    );
    // The person categorises one row and writes a note on it.
    saved.get('row-0')![category] = 'Lunch';
    saved.get('row-0')![note] = 'Client lunch, invoice 2026-031';
    const again = run({
      ...host,
      text: fixture,
      query: (prop: string, value: string) =>
        [...saved].filter(([, v]) => v[prop] === value).map(([id]) => id),
      read: (id: string) => saved.get(id)!,
    });
    expect(again.intents).toHaveLength(0);
    expect(again.problems.filter(p => p.severity === 'error')).toEqual([]);
    expect(saved.get('row-0')![category]).toBe('Lunch');
    expect(saved.get('row-0')![note]).toBe('Client lunch, invoice 2026-031');
  });
});

describe('statements (atomic-server#1768 destination.tables)', () => {
  const host = {
    config,
    query: () => [] as string[],
    read: () => ({}),
  };
  const set = (intent: unknown) =>
    (intent as { set: Record<string, unknown>; parent: string }).set;

  it('writes one statement row with its reconciled balances beside the transactions', () => {
    const { intents } = run({ ...host, text: fixture }) as {
      intents: {
        parent: string;
        isA?: string[];
        set: Record<string, unknown>;
      }[];
    };
    const statements = intents.filter(
      i => i.parent === config.tables.statements.table,
    );
    expect(statements).toHaveLength(1);
    expect(statements[0].isA).toEqual([config.tables.statements.rowClass]);
    expect(set(statements[0])).toMatchObject({
      [properties['bank-account']]: 'NL00BUNQ0000000000',
      [properties['bank-currency']]: 'EUR',
      [properties['bank-statement']]: '1/1',
      [properties['bank-period-start']]: '2026-09-01',
      [properties['bank-period-end']]: '2026-09-03',
      [properties['bank-opening-balance']]: '100',
      [properties['bank-closing-balance']]: '107.66',
      [properties['bank-entry-count']]: '2',
      [properties['bank-format']]: 'mt940',
    });
    expect(set(statements[0])[properties['bank-imported-date']]).toMatch(
      /^\d{4}-\d{2}-\d{2}$/,
    );
  });

  it('asks for Set up again when the statements table is missing', () => {
    expect(() =>
      run({
        ...host,
        config: { ...config, tables: undefined as never },
        text: fixture,
      }),
    ).toThrow('missing tables.statements');
  });
});
