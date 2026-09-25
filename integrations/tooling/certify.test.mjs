import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  rmSync,
  symlinkSync,
  readFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  discover,
  root,
  bundleArguments,
  evaluateJs,
  evaluateRust,
  formatFailureSummary,
  parseArgs,
  sandboxFeatures,
  summarizeFailure,
} from './certify.mjs';
test('the js layer is the default; sandbox and all stay selectable', () => {
  assert.equal(parseArgs([]).layer, 'js');
  assert.equal(parseArgs(['--integration', 'notion']).layer, 'js');
  assert.equal(parseArgs(['--integration', 'notion']).only, 'notion');
  assert.equal(parseArgs(['--layer', 'all']).layer, 'all');
  assert.equal(parseArgs(['--layer', 'sandbox']).layer, 'sandbox');
  assert.throws(() => parseArgs(['--layer']), /--layer defaults to js/);
  assert.throws(() => parseArgs(['--bogus', 'x']), /Usage/);
});
test('zero executed tests cannot certify an integration', () => {
  assert.equal(
    evaluateJs({ success: true, numPassedTests: 0, numFailedTests: 0 }),
    false,
  );
  assert.equal(
    evaluateJs({ success: true, numPassedTests: 2, numFailedTests: 0 }),
    true,
  );
  assert.equal(
    evaluateJs({ success: false, numPassedTests: 2, numFailedTests: 1 }),
    false,
  );
  assert.equal(
    evaluateRust('test result: ok. 0 passed; 0 failed; 0 ignored;'),
    false,
  );
  assert.equal(
    evaluateRust('test result: ok. 1 passed; 0 failed; 0 ignored;'),
    true,
  );
  assert.equal(
    evaluateRust('test result: ok. 0 passed; 0 failed; 1 ignored;'),
    false,
  );
});
test('new packages cannot silently escape certification', () => {
  const base = mkdtempSync(join(tmpdir(), 'atomic-certification-'));

  try {
    mkdirSync(join(base, 'integrations/new-provider'), { recursive: true });
    writeFileSync(join(base, 'integrations/new-provider/package.json'), '{}');
    assert.throws(() => discover(base), /missing certification metadata/);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test('failed certification checks surface a concise useful diagnostic', () => {
  assert.equal(
    summarizeFailure({
      error: 'spawnSync /browser/node_modules/.bin/esbuild ENOENT',
      stderr: 'ignored stderr',
      stdout: 'ignored stdout',
    }),
    'spawnSync /browser/node_modules/.bin/esbuild ENOENT',
  );
  assert.equal(
    formatFailureSummary([
      { name: 'typecheck', status: 'passed' },
      {
        name: 'reproducible-bundle',
        status: 'failed',
        detail: 'generated bundle differs from committed plugin.js',
      },
      { name: 'fixtures', status: 'failed' },
    ]),
    'reproducible-bundle: generated bundle differs from committed plugin.js; fixtures',
  );
});
test('a catalog card whose shortname matches the package id must carry the same version', () => {
  const base = mkdtempSync(join(tmpdir(), 'atomic-catalog-version-'));

  try {
    const providerDir = join(base, 'integrations/fixture-provider');
    mkdirSync(providerDir, { recursive: true });
    writeFileSync(
      join(providerDir, 'package.json'),
      JSON.stringify({
        version: '1.0.0',
        atomicCertification: {
          owner: 'Fixture',
          support: 'experimental',
          apiVersion: 'fixture-v1',
          capabilities: ['fixture:import'],
          sandboxTests: ['plugins::fixture_tests::fixture_test'],
        },
      }),
    );
    for (const file of [
      'plugin.ts',
      'plugin.js',
      'tsconfig.json',
      'vitest.config.ts',
      'README.md',
    ])
      writeFileSync(join(providerDir, file), '');
    const catalogEntry = shortnameVersion => ({
      'https://atomicdata.dev/properties/shortname': 'fixture-provider',
      ...(shortnameVersion !== undefined
        ? {
            'https://atomicdata.dev/integrations/properties/version':
              shortnameVersion,
          }
        : {}),
    });
    writeFileSync(
      join(base, 'integrations/catalog.json'),
      JSON.stringify([catalogEntry('0.9.0')]),
    );
    assert.throws(
      () => discover(base),
      /catalog\.json version \(0\.9\.0\) does not match package\.json version \(1\.0\.0\)/,
    );
    writeFileSync(
      join(base, 'integrations/catalog.json'),
      JSON.stringify([catalogEntry('1.0.0')]),
    );
    assert.ok(discover(base).some(p => p.id === 'fixture-provider'));
    writeFileSync(
      join(base, 'integrations/catalog.json'),
      JSON.stringify([catalogEntry(undefined)]),
    );
    assert.throws(
      () => discover(base),
      /catalog\.json version \(missing\) does not match package\.json version \(1\.0\.0\)/,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});
test('sandbox-hosted providers are discovered with exact sandbox tests', () => {
  const ids = discover().map(p => p.id);
  assert.ok(ids.includes('notion'));
  assert.ok(
    !ids.includes('issue-tracker'),
    'issue-tracker runs entirely in-browser via Devonian and is not a Rust-sandbox-certified package',
  );
  assert.equal(new Set(ids).size, ids.length);
});

test('store evidence rejects partial, failed and changed bundles; labels old evidence', async () => {
  const { assessEvidence } = await import('./evidence.mjs');
  const now = Date.now();
  const report = {
    schemaVersion: 1,
    layer: 'all',
    status: 'passed',
    generatedAt: new Date(now).toISOString(),
    integrations: [
      {
        id: 'test',
        owner: 'Fixture',
        version: '1.0.0',
        status: 'passed',
        bundleSha256: 'expected',
        checks: [
          'reproducible-bundle',
          'typecheck',
          'fixtures',
          'plugins::fixture::test',
        ].map(name => ({ name, status: 'passed' })),
      },
    ],
  };
  assert.ok(assessEvidence(report, 'test', 'expected', now));
  assert.equal(assessEvidence(report, 'test', 'changed', now), null);
  assert.equal(
    assessEvidence({ ...report, integrations: {} }, 'test', 'expected', now),
    null,
  );
  assert.equal(
    assessEvidence(
      {
        ...report,
        integrations: [{ ...report.integrations[0], checks: [null] }],
      },
      'test',
      'expected',
      now,
    ),
    null,
  );
  assert.equal(
    assessEvidence({ ...report, layer: 'js' }, 'test', 'expected', now),
    null,
  );
  assert.equal(
    assessEvidence({ ...report, status: 'failed' }, 'test', 'expected', now),
    null,
  );
  assert.equal(
    assessEvidence(
      { ...report, generatedAt: 'invalid' },
      'test',
      'expected',
      now,
    ),
    null,
  );
  assert.equal(
    assessEvidence(report, 'test', 'expected', now + 31 * 86400000).stale,
    true,
  );
  assert.equal(
    assessEvidence(report, 'test', 'expected', now - 86400000),
    null,
  );
});

test('bundles are reproducible with CI browser and integration symlinks', () => {
  const base = mkdtempSync(join(tmpdir(), 'atomic-bundle-paths-'));

  try {
    symlinkSync(join(root, 'browser'), join(base, 'browser'));
    symlinkSync(join(root, 'integrations'), join(base, 'integrations'));

    for (const provider of discover()) {
      const generated = execFileSync(
        join(root, 'browser/node_modules/.bin/esbuild'),
        bundleArguments(`${provider.path}/plugin.ts`),
        { cwd: base, encoding: 'utf8' },
      );
      assert.equal(
        generated,
        readFileSync(join(root, provider.path, 'plugin.js'), 'utf8'),
        provider.id,
      );
    }
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('a gated package is refused without the derived requires, and certified with it on a plugin-routes build', () => {
  const base = mkdtempSync(join(tmpdir(), 'atomic-certification-gated-'));
  const REQUIRES = 'https://atomicdata.dev/integrations/properties/requires';
  const derived = [
    'persistent-host',
    'plugin-routes:read-only',
    'public-origin',
    'wasm-sandbox',
  ];

  try {
    const dir = join(base, 'integrations/gated');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, 'package.json'),
      JSON.stringify({
        version: '1.0.0',
        atomicCertification: {
          owner: 'Fixture',
          support: 'experimental',
          apiVersion: 'fixture-v1',
          capabilities: ['fixture:serve'],
          sandboxTests: ['plugins::fixture_tests::fixture_test'],
        },
      }),
    );
    for (const file of [
      'plugin.ts',
      'tsconfig.json',
      'vitest.config.ts',
      'README.md',
    ])
      writeFileSync(join(dir, file), '');
    writeFileSync(
      join(dir, 'plugin.js'),
      readFileSync(
        join(root, 'integrations/tooling/fixtures/gated-plugin/plugin.js'),
      ),
    );
    const card = extra => [
      {
        'https://atomicdata.dev/properties/shortname': 'gated',
        'https://atomicdata.dev/integrations/properties/version': '1.0.0',
        ...extra,
      },
    ];

    writeFileSync(
      join(base, 'integrations/catalog.json'),
      JSON.stringify(card({})),
    );
    assert.throws(
      () => discover(base),
      /integrations\/gated: a gated plugin \(needs plugin-routes:read-only\) has no requires in catalog\.json/,
    );

    writeFileSync(
      join(base, 'integrations/catalog.json'),
      JSON.stringify(card({ [REQUIRES]: derived })),
    );
    const [found] = discover(base);
    assert.equal(found.schemaVersion, 3);
    assert.equal(found.pluginRoutes, 'read-only');
    assert.deepEqual(found.requires, derived);
    assert.equal(sandboxFeatures(found), 'light,wasm-plugins,plugin-routes');
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test('ungated packages keep the default sandbox features', () => {
  for (const p of discover()) {
    assert.equal(p.pluginRoutes, 'none', p.id);
    assert.equal(sandboxFeatures(p), 'light,wasm-plugins');
  }
});

test('a gated plugin has no evidence until a plugin-routes build at its level is recorded', async () => {
  const { assessEvidence, neededLevel } = await import('./evidence.mjs');
  const now = Date.now();
  const item = hostFeatures => ({
    id: 'gated',
    owner: 'Fixture',
    version: '1.0.0',
    status: 'passed',
    bundleSha256: 'expected',
    requires: ['plugin-routes:read-write', 'wasm-sandbox'],
    ...(hostFeatures ? { hostFeatures } : {}),
    checks: [
      'reproducible-bundle',
      'typecheck',
      'fixtures',
      'plugins::fixture::test',
    ].map(name => ({ name, status: 'passed' })),
  });
  const report = hostFeatures => ({
    schemaVersion: 1,
    layer: 'all',
    status: 'passed',
    generatedAt: new Date(now).toISOString(),
    integrations: [item(hostFeatures)],
  });
  const assess = hostFeatures =>
    assessEvidence(report(hostFeatures), 'gated', 'expected', now);
  const features = ['light', 'wasm-plugins', 'plugin-routes'];

  assert.equal(neededLevel(item()), 'read-write');
  assert.equal(assess(undefined), null);
  // What certify.mjs records: the feature, but no running level.
  assert.equal(assess({ features, pluginRoutes: null }), null);
  assert.equal(assess({ features, pluginRoutes: 'read-only' }), null);
  assert.equal(
    assess({ features: ['light', 'wasm-plugins'], pluginRoutes: 'read-write' }),
    null,
  );
  assert.ok(assess({ features, pluginRoutes: 'read-write' }));
});
