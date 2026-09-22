import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hostedAssets, createDevServer, root } from './dev-server.mjs';

async function withFixture(fn) {
  const base = mkdtempSync(join(tmpdir(), 'atomic-dev-server-'));

  try {
    mkdirSync(join(base, 'integrations/alpha'), { recursive: true });
    mkdirSync(join(base, 'integrations/beta/nested'), { recursive: true });
    writeFileSync(join(base, 'integrations/catalog.json'), '{"ok":true}');
    writeFileSync(join(base, 'integrations/alpha/plugin.js'), 'alpha-bundle');
    writeFileSync(join(base, 'integrations/alpha/README.md'), 'not hosted');
    writeFileSync(
      join(base, 'integrations/alpha/plugin.test.ts'),
      'not hosted',
    );
    writeFileSync(
      join(base, 'integrations/beta/nested/plugin.js'),
      'beta-bundle',
    );
    writeFileSync(join(base, 'integrations/beta/catalog.json'), 'not root');

    return await fn(base);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
}

async function withServers(assetsRoot, run) {
  const dev = createDevServer({ assetsRoot });
  await new Promise(r => dev.listen(0, r));
  const devUrl = `http://localhost:${dev.address().port}`;

  try {
    await run({ devUrl });
  } finally {
    dev.closeAllConnections();
    await new Promise(r => dev.close(r));
  }
}

test('hostedAssets collects only plugin.js files and the root catalog.json', () => {
  withFixture(base => {
    const assets = hostedAssets(base);
    assert.deepEqual(
      new Set(assets.keys()),
      new Set(['catalog.json', 'alpha/plugin.js', 'beta/nested/plugin.js']),
    );
  });
});

test('serves catalog.json and plugin.js, 404s everything else under /integrations', async () => {
  await withFixture(async base => {
    await withServers(base, async ({ devUrl }) => {
      const catalog = await fetch(`${devUrl}/integrations/catalog.json`);
      assert.equal(catalog.status, 200);
      assert.equal(catalog.headers.get('content-type'), 'application/json');
      assert.equal(await catalog.text(), '{"ok":true}');

      const alpha = await fetch(`${devUrl}/integrations/alpha/plugin.js`);
      assert.equal(alpha.status, 200);
      assert.equal(alpha.headers.get('content-type'), 'text/javascript');
      assert.equal(await alpha.text(), 'alpha-bundle');

      const nested = await fetch(
        `${devUrl}/integrations/beta/nested/plugin.js`,
      );
      assert.equal(await nested.text(), 'beta-bundle');

      assert.equal(
        (await fetch(`${devUrl}/integrations/alpha/README.md`)).status,
        404,
      );
      assert.equal(
        (await fetch(`${devUrl}/integrations/alpha/plugin.test.ts`)).status,
        404,
      );
      assert.equal(
        (await fetch(`${devUrl}/integrations/beta/catalog.json`)).status,
        404,
      );
      assert.equal(
        (await fetch(`${devUrl}/integrations/nope/plugin.js`)).status,
        404,
      );
    });
  });
});

/*
 * Everything outside /integrations is a 404 now, not a proxy hop. Fronting
 * atomic-server is what forced a choice between signed auth proofs (which
 * need the client's Host forwarded) and resource lookups (which need the
 * server's own origin) — see the module docstring. Clients talk to
 * atomic-server directly instead.
 */
test('404s anything outside /integrations instead of proxying it', async () => {
  await withFixture(async base => {
    await withServers(base, async ({ devUrl }) => {
      const res = await fetch(`${devUrl}/some/atomic-data/resource?x=1`);
      assert.equal(res.status, 404);
    });
  });
});

/* The SPA loads from atomic-server's origin, so every catalog read is cross-origin. */
test('serves the catalog with permissive CORS, and answers preflight', async () => {
  await withFixture(async base => {
    await withServers(base, async ({ devUrl }) => {
      const res = await fetch(`${devUrl}/integrations/catalog.json`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('access-control-allow-origin'), '*');

      const preflight = await fetch(`${devUrl}/integrations/catalog.json`, {
        method: 'OPTIONS',
      });
      assert.equal(preflight.status, 204);
      assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    });
  });
});

test('createDevServer needs no upstream', () => {
  assert.doesNotThrow(() => createDevServer());
});

test('hosts the certified integration bundles in this repository', () => {
  const assets = hostedAssets(root);
  assert.ok(assets.has('catalog.json'));
  assert.ok(assets.has('notion/plugin.js'));
});
