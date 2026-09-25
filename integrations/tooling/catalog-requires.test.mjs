import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  catalogRequiresProblems,
  packageGating,
  readManifest,
  REQUIRES,
  writeCatalogRequires,
} from './catalog-requires.mjs';
import { root } from './lanes.mjs';

const SHORTNAME = 'https://atomicdata.dev/properties/shortname';
const GATED = join(
  root,
  'integrations/tooling/fixtures/gated-plugin/plugin.js',
);
const DERIVED = [
  'persistent-host',
  'plugin-routes:read-only',
  'public-origin',
  'wasm-sandbox',
];

/** A repo with one package, `gated`, whose plugin.js is `source` (a path or text). */
function tree({ source = GATED, card } = {}) {
  const base = mkdtempSync(join(tmpdir(), 'atomic-catalog-requires-'));
  const dir = join(base, 'integrations/gated');
  mkdirSync(dir, { recursive: true });
  if (source.endsWith('.js')) copyFileSync(source, join(dir, 'plugin.js'));
  else writeFileSync(join(dir, 'plugin.js'), source);
  writeFileSync(
    join(base, 'integrations/catalog.json'),
    JSON.stringify(card ? [{ [SHORTNAME]: 'gated', ...card }] : []),
  );

  return base;
}

test('the fixture plugin is gated at read-only', () => {
  const manifest = readManifest(GATED);
  assert.equal(manifest.schemaVersion, 3);
  const base = tree();

  try {
    const gating = packageGating(base, 'integrations/gated');
    assert.equal(gating.gated, true);
    assert.equal(gating.gate.needed, 'read-only');
    assert.deepEqual(gating.requires, DERIVED);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a gated package with no entry, or an entry without requires, is refused', () => {
  for (const card of [undefined, { enabled: true }]) {
    const base = tree({ card });

    try {
      const [problem, ...rest] = catalogRequiresProblems(base);
      assert.equal(rest.length, 0);
      assert.match(
        problem,
        /integrations\/gated: a gated plugin \(needs plugin-routes:read-only\)/,
      );
      assert.ok(problem.includes(JSON.stringify(DERIVED)), problem);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  }
});

test('requires must equal what the manifest derives, in order', () => {
  const base = tree({ card: { [REQUIRES]: [...DERIVED].reverse() } });

  try {
    assert.match(
      catalogRequiresProblems(base)[0],
      /does not match what the manifest derives/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('write fills in the derived list, after which check passes', () => {
  const base = tree({ card: { enabled: true } });

  try {
    assert.deepEqual(writeCatalogRequires(base), ['gated']);
    const [card] = JSON.parse(
      readFileSync(join(base, 'integrations/catalog.json'), 'utf8'),
    );
    assert.deepEqual(card[REQUIRES], DERIVED);
    assert.deepEqual(catalogRequiresProblems(base), []);
    assert.deepEqual(writeCatalogRequires(base), []);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('an ungated v1/v2 package needs no requires, but one it carries must match', () => {
  const v2 =
    'export const manifest = { schemaVersion: 2, secrets: [{ name: "x", origin: "https://x.example" }], operations: [] };';
  const plain = tree({ source: v2, card: { enabled: true } });
  const wrong = tree({ source: v2, card: { [REQUIRES]: ['wasm-sandbox'] } });
  const none = tree({ source: '', card: { [REQUIRES]: ['wasm-sandbox'] } });

  try {
    assert.deepEqual(catalogRequiresProblems(plain), []);
    assert.match(
      catalogRequiresProblems(wrong)[0],
      /\["host-credentials","wasm-sandbox"\]/,
    );
    assert.match(
      catalogRequiresProblems(none)[0],
      /exports no versioned manifest/,
    );
  } finally {
    for (const base of [plain, wrong, none])
      rmSync(base, { recursive: true, force: true });
  }
});

test('an invalid http block names the package', () => {
  const base = tree({
    source:
      'export const manifest = { schemaVersion: 2, http: { routes: [] } };',
  });

  try {
    assert.throws(
      () => catalogRequiresProblems(base),
      /integrations\/gated: invalid manifest: the http block needs schemaVersion 3/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("this repo's catalog.json matches its packages' manifests", () => {
  assert.deepEqual(catalogRequiresProblems(), []);
});
