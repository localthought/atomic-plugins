// @wc-ignore-file
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { IMPORT_LOCAL_ID } from '../../browser/lib/src/import-records.js';
import { drop } from './fixtures';
import { manifest, run } from './plugin';

const PARENT = 'https://atomicdata.dev/properties/parent';
const IS_A = 'https://atomicdata.dev/properties/isA';

const properties = Object.fromEntries(
  manifest.destination.schema.properties.map(p => [
    p.shortname,
    `https://example.com/${p.shortname}`,
  ]),
);
const config = {
  table: 'https://example.com/table',
  rowClass: 'https://example.com/willow-entry',
  properties,
};

/** What the host hands over for a binary file (see upload.test.ts). */
const hostText = (bytes: Uint8Array) => {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
};

const upload = (name: string) => ({
  upload: { name: `${name}.drop`, text: hostText(drop(name)) },
});

/** A host whose table holds `rows`, looked up the way importRecords does. */
function host(rows: Record<string, Record<string, unknown>> = {}) {
  return {
    config,
    query: (property: string, value: string) =>
      Object.entries(rows)
        .filter(([, row]) => row[property] === value)
        .map(([subject]) => subject),
    read: (subject: string) => rows[subject] ?? {},
  };
}

/** Rows as the host would store them after applying `intents`. */
function apply(intents: Array<{ op: string; localId?: string; set: object }>) {
  return Object.fromEntries(
    intents
      .filter(intent => intent.op === 'create')
      .map(intent => [
        `https://example.com/rows/${intent.localId}`,
        {
          ...intent.set,
          [PARENT]: config.table,
          [IS_A]: [config.rowClass],
        } as Record<string, unknown>,
      ]),
  );
}

describe('host declaration (atomic-server#1653)', () => {
  it('accepts one file, read as text, up to 5,000,000 bytes', () => {
    expect(manifest.schemaVersion).toBe(2);
    expect(manifest.accepts).toEqual([
      expect.objectContaining({ as: 'text', maxBytes: 5_000_000 }),
    ]);
    for (const extension of manifest.accepts[0].extensions)
      expect(extension).toMatch(/^\.[a-z0-9][a-z0-9._-]*$/);
    // No network, no credentials, no routes: the file is the only input.
    expect(manifest.operations).toEqual([]);
    expect(manifest.secrets).toEqual([]);
    expect(manifest).not.toHaveProperty('http');
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
    expect(manifest.config.required).toEqual([
      'table',
      'rowClass',
      'properties',
    ]);
  });

  it('keeps the declaration JSON: the host reads it without running code', () => {
    expect(JSON.parse(JSON.stringify(manifest))).toEqual(manifest);
  });
});

describe('bundle', () => {
  const root = fileURLToPath(new URL('../..', import.meta.url));
  const shipped = readFileSync(new URL('./plugin.js', import.meta.url), 'utf8');

  it('is what esbuild builds from the sources today', () => {
    const fresh = execFileSync(
      `${root}browser/node_modules/.bin/esbuild`,
      [
        'integrations/willow-drop/plugin.ts',
        '--preserve-symlinks',
        '--bundle',
        '--format=esm',
        '--platform=neutral',
        '--target=es2022',
      ],
      { cwd: root, encoding: 'utf8' },
    );
    expect(shipped).toBe(fresh);
  });

  it('carries no lib client and no Node or browser globals', () => {
    expect(shipped).not.toMatch(/class Store\b|class Client\b/);
    expect(shipped).not.toMatch(/\b(TextEncoder|TextDecoder|Buffer|atob)\b/);
  });
});

describe('run', () => {
  it('proposes one row per entry, with exact strings', () => {
    const { intents, problems } = run({ ...host(), ...upload('communal') });
    expect(intents).toHaveLength(7);
    expect(intents.every(intent => intent.op === 'create')).toBe(true);
    const hello = intents.find(
      intent =>
        intent.op === 'create' &&
        intent.set[properties['willow-path']] === '/notes/hello.txt',
    )!;
    expect(hello).toMatchObject({
      parent: config.table,
      isA: [config.rowClass],
      set: {
        'https://atomicdata.dev/properties/name': '/notes/hello.txt',
        [properties['willow-payload']]: 'Hello from Willow\n',
        [properties['willow-timestamp']]: '843480069184000',
        [properties['willow-time']]: '2026-09-24T00:00:00.000000Z',
        [properties['willow-payload-length']]: '18',
        [properties['willow-capability']]: 'communal',
      },
    });
    expect(problems.map(p => p.severity)).toEqual(['warning']);
    expect(problems[0].message).toContain(
      '7 entries decoded and verified (file read as windows-1252)',
    );
  });

  it('imports owned-namespace entries', () => {
    const { intents } = run({ ...host(), ...upload('owned') });
    expect(
      intents.map(
        intent =>
          intent.op === 'create' && intent.set[properties['willow-path']],
      ),
    ).toEqual([
      '/profile',
      '/guestbook/carol',
      '/odd/a%20b/x%2fy',
      '/blog/second-post',
    ]);
  });

  it('keeps only what a Willow store keeps after prefix pruning', () => {
    const { intents, problems } = run({ ...host(), ...upload('pruning') });
    expect(intents).toHaveLength(2);
    expect(problems.map(p => p.message).join(' ')).toContain(
      '1 entries were left out because a newer entry in the same drop',
    );
  });

  it('proposes nothing on a repeat import', () => {
    const first = run({ ...host(), ...upload('communal') });
    const again = run({ ...host(apply(first.intents)), ...upload('communal') });
    expect(again.intents).toEqual([]);
    expect(again.problems[0].message).toContain(
      '7 previously imported entries unchanged',
    );
  });

  it('leaves out an entry when the table already holds a newer one', () => {
    const rows = apply(run({ ...host(), ...upload('communal') }).intents);
    const [subject, row] = Object.entries(rows).find(
      ([, r]) => r[properties['willow-path']] === '/notes/hello.txt',
    )!;
    rows[subject] = {
      ...row,
      [properties['willow-timestamp']]: '999999999999999999',
    };
    // Leave every stored row's baseline alone: only the newer one matters.
    const { intents, problems } = run({ ...host(rows), ...upload('communal') });
    expect(
      intents.some(
        intent =>
          'subject' in intent &&
          (intent as { subject: string }).subject === subject,
      ),
    ).toBe(false);
    expect(problems.map(p => p.message).join(' ')).toContain(
      '1 entries were left out because the table already holds a newer entry',
    );
  });

  it('uses the source identity the table rows carry', () => {
    const [created] = run({ ...host(), ...upload('owned') }).intents;
    expect(
      created.op === 'create' &&
        JSON.parse(created.set[IMPORT_LOCAL_ID] as string),
    ).toEqual([
      'willow25',
      expect.stringMatching(/^[0-9a-f]{64}$/),
      expect.stringMatching(/^[0-9a-f]{64}$/),
      [Buffer.from('profile').toString('hex')],
    ]);
  });

  it('accepts a base64-encoded drop', () => {
    const text = Buffer.from(drop('owned')).toString('base64');
    const { intents, problems } = run({ ...host(), upload: { text } });
    expect(intents).toHaveLength(4);
    expect(problems[0].message).toContain('file read as base64');
  });

  it('validates without writing', () => {
    expect(
      run({
        ...host(),
        ...upload('communal'),
        trigger: { payload: { validate: true } },
      }),
    ).toEqual({ intents: [], problems: [] });
  });

  it('refuses a drop it cannot verify, naming the entry', () => {
    expect(() => run({ ...host(), ...upload('delegated') })).toThrow(
      'Entry 1: its write capability carries delegations',
    );
  });

  it('asks for a file, then for configuration', () => {
    expect(() => run(host())).toThrow('Choose a Willow drop file');
    expect(() =>
      run({ ...host(), config: undefined, ...upload('owned') }),
    ).toThrow('missing table, rowClass, properties');
  });
});
