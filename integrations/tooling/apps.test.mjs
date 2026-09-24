import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  appEntries,
  blobId,
  check,
  integrityOf,
  modulePath,
  moduleUrl,
  readCatalog,
  root,
  staticProblems,
  terms,
  write,
} from './apps.mjs';

const TEXT = 'export async function view() {}';

function fixture({
  version = '1.2.3',
  pkgVersion = version,
  text = TEXT,
  committed = TEXT,
} = {}) {
  const base = mkdtempSync(join(tmpdir(), 'atomic-apps-'));
  mkdirSync(join(base, 'integrations/gamma/app'), { recursive: true });
  writeFileSync(
    join(base, 'integrations/gamma/app/build.mjs'),
    `export async function build() { return { text: ${JSON.stringify(text)} }; }\n`,
  );
  writeFileSync(
    join(base, 'integrations/gamma/package.json'),
    JSON.stringify({ name: '@x/gamma', version: pkgVersion }),
  );

  if (committed !== undefined) {
    mkdirSync(join(base, `apps/gamma/${version}`), { recursive: true });
    writeFileSync(join(base, modulePath('gamma', version)), committed);
  }

  writeFileSync(
    join(base, 'integrations/catalog.json'),
    `${JSON.stringify(
      [
        { [terms.shortname]: 'not-an-app' },
        {
          [terms.shortname]: 'gamma',
          [terms.name]: 'Gamma',
          [terms.version]: version,
          [terms.module]: moduleUrl('gamma', version),
          [terms.integrity]: integrityOf(TEXT),
        },
      ],
      null,
      2,
    )}\n`,
  );

  return base;
}

const using = async (options, run) => {
  const base = fixture(options);

  try {
    await run(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
};

/** Commits the fixture as it is, standing in for what main has published. */
function commitAsMain(base) {
  const git = (...args) =>
    execFileSync('git', ['-C', base, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('add', '-A');
  git(
    '-c',
    'user.name=t',
    '-c',
    'user.email=t@example.com',
    'commit',
    '-q',
    '-m',
    'published',
  );

  return 'main';
}

test('integrity is the SRI sha384 of the UTF-8 bytes', () => {
  // printf 'abc' | openssl dgst -sha384 -binary | base64
  assert.equal(
    integrityOf('abc'),
    'sha384-ywB1P0WjXou1oD1pmsZQBycsMqsO3tFjGotgWkP/W+2AhgcroefMI1i67KE0yCWn',
  );
});

test('blobId is the git blob id', () => {
  // printf 'abc' | git hash-object --stdin
  assert.equal(
    blobId(Buffer.from('abc')),
    'f2ba8f84ab5c1bce84a7b441cb1959cfc7093b7f',
  );
});

test('the module URL is the committed path on GitHub Pages', () => {
  assert.equal(modulePath('gamma', '1.2.3'), 'apps/gamma/1.2.3/ui.js');
  assert.equal(
    moduleUrl('gamma', '1.2.3'),
    'https://ontola.github.io/atomic-plugins/apps/gamma/1.2.3/ui.js',
  );
});

test('a matching app entry passes check', () =>
  using({}, async base => {
    assert.equal(appEntries(readCatalog(base)).length, 1);
    assert.deepEqual(await check({ base }), []);
  }));

test('a fresh build that differs from the committed module fails check', () =>
  using({ text: `${TEXT}\n// changed` }, async base => {
    const [problem] = await check({ base });
    assert.match(problem, /gamma: a fresh build is sha384-.*bump the version/);
  }));

test('the committed module must exist and match the pinned integrity', () =>
  using({ committed: 'tampered' }, async base => {
    const entry = appEntries(readCatalog(base))[0];
    assert.deepEqual(staticProblems(entry, base), [
      `gamma: apps/gamma/1.2.3/ui.js is ${integrityOf('tampered')}, the catalog pins ${integrityOf(TEXT)}`,
    ]);
    rmSync(join(base, 'apps'), { recursive: true });
    assert.match(
      staticProblems(entry, base)[0],
      /apps\/gamma\/1\.2\.3\/ui\.js is not committed; run `node integrations\/tooling\/apps\.mjs write gamma`/,
    );
  }));

test('version must match package.json, and the URL must be the Pages one', () =>
  using({ pkgVersion: '1.2.4' }, async base => {
    const entry = appEntries(readCatalog(base))[0];
    assert.deepEqual(staticProblems(entry, base), [
      'gamma: catalog version 1.2.3 does not match integrations/gamma/package.json 1.2.4',
    ]);
    entry[terms.module] = 'https://cdn.example.com/ui.js';
    assert.deepEqual(staticProblems(entry, base), [
      'gamma: app-module is https://cdn.example.com/ui.js, expected https://ontola.github.io/atomic-plugins/apps/gamma/1.2.3/ui.js',
      'gamma: catalog version 1.2.3 does not match integrations/gamma/package.json 1.2.4',
    ]);
    entry[terms.version] = '../x';
    assert.match(
      staticProblems(entry, base)[0],
      /version \.\.\/x cannot be a URL path segment/,
    );
  }));

test('an app-only folder records its version in app/package.json', () =>
  using({}, async base => {
    rmSync(join(base, 'integrations/gamma/package.json'));
    const entry = appEntries(readCatalog(base))[0];
    assert.match(staticProblems(entry, base)[0], /records a version/);
    writeFileSync(
      join(base, 'integrations/gamma/app/package.json'),
      JSON.stringify({ private: true, version: '1.2.3' }),
    );
    assert.deepEqual(staticProblems(entry, base), []);
  }));

test('apps/ holds only <id>/<version>/ui.js', () =>
  using({}, async base => {
    writeFileSync(join(base, 'apps/gamma/notes.txt'), 'x');
    assert.deepEqual(await check({ base }), [
      'apps/gamma/notes.txt: apps/ holds only apps/<id>/<version>/ui.js (see integrations/README.md, "Publishing a drive app")',
    ]);
  }));

test('write builds into apps/<id>/<version>/ui.js and sets URL and integrity, keeping the rest', () =>
  using(
    {
      version: '2.0.0',
      text: 'export const view = () => 1;',
      committed: undefined,
    },
    async base => {
      const before = readFileSync(
        join(base, 'integrations/catalog.json'),
        'utf8',
      );
      const [written] = await write({ only: 'gamma', base });
      assert.deepEqual(written, {
        path: 'apps/gamma/2.0.0/ui.js',
        bytes: 28,
        integrity: integrityOf('export const view = () => 1;'),
      });
      assert.equal(
        readFileSync(join(base, 'apps/gamma/2.0.0/ui.js'), 'utf8'),
        'export const view = () => 1;',
      );
      const after = readCatalog(base);
      assert.equal(after[1][terms.integrity], written.integrity);
      assert.equal(after[1][terms.module], moduleUrl('gamma', '2.0.0'));
      assert.deepEqual(after[0], JSON.parse(before)[0]);
      assert.deepEqual(await check({ base }), []);
      await assert.rejects(write({ only: 'nope', base }), /not an app entry/);
    },
  ));

test('a published version file may not change or disappear', () =>
  using({}, async base => {
    const main = commitAsMain(base);
    assert.deepEqual(await check({ base, published: main }), []);

    writeFileSync(join(base, 'apps/gamma/1.2.3/ui.js'), `${TEXT} `);
    assert.ok(
      (await check({ base, published: main })).includes(
        `apps/gamma/1.2.3/ui.js is published at ${main} and was changed. Published versions are immutable: restore it and release a new version.`,
      ),
    );

    rmSync(join(base, 'apps'), { recursive: true });
    assert.ok(
      (await check({ base, published: main })).includes(
        `apps/gamma/1.2.3/ui.js is published at ${main} and was deleted. Published versions stay available: restore it.`,
      ),
    );
  }));

test('write refuses to rebuild a published version with different bytes', () =>
  using({}, async base => {
    const main = commitAsMain(base);
    // Same bytes: harmless.
    await write({ only: 'gamma', base, published: main });
    writeFileSync(
      join(base, 'integrations/gamma/app/build.mjs'),
      "export async function build() { return { text: 'changed' }; }\n",
    );
    await assert.rejects(
      write({ only: 'gamma', base, published: main }),
      /apps\/gamma\/1\.2\.3\/ui\.js is published at main with different bytes/,
    );
    assert.equal(
      readFileSync(join(base, 'apps/gamma/1.2.3/ui.js'), 'utf8'),
      TEXT,
    );
  }));

test('a new version beside a published one passes', () =>
  using({}, async base => {
    const main = commitAsMain(base);
    writeFileSync(
      join(base, 'integrations/gamma/package.json'),
      JSON.stringify({ name: '@x/gamma', version: '1.3.0' }),
    );
    const catalog = readCatalog(base);
    catalog[1][terms.version] = '1.3.0';
    writeFileSync(
      join(base, 'integrations/catalog.json'),
      JSON.stringify(catalog),
    );
    writeFileSync(
      join(base, 'integrations/gamma/app/build.mjs'),
      "export async function build() { return { text: 'v1.3' }; }\n",
    );
    await write({ only: 'gamma', base, published: main });
    assert.deepEqual(await check({ base, published: main }), []);
    assert.equal(
      readFileSync(join(base, 'apps/gamma/1.2.3/ui.js'), 'utf8'),
      TEXT,
    );
  }));

test("this repository's app entries are well-formed", () => {
  for (const entry of appEntries(readCatalog(root)))
    assert.deepEqual(staticProblems(entry, root), []);
});
