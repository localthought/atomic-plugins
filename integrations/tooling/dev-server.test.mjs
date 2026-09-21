import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
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
  const upstreamHits = [];
  const upstream = createServer((req, res) => {
    upstreamHits.push(req.url);
    res.writeHead(200, { 'x-from': 'upstream' });
    res.end(`upstream:${req.url}`);
  });
  await new Promise(r => upstream.listen(0, r));
  const upstreamUrl = `http://localhost:${upstream.address().port}`;
  const dev = createDevServer({ upstream: upstreamUrl, assetsRoot });
  await new Promise(r => dev.listen(0, r));
  const devUrl = `http://localhost:${dev.address().port}`;
  try {
    await run({ devUrl, upstreamHits });
  } finally {
    dev.closeAllConnections();
    upstream.closeAllConnections();
    await new Promise(r => dev.close(r));
    await new Promise(r => upstream.close(r));
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
    await withServers(base, async ({ devUrl, upstreamHits }) => {
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
      assert.equal(upstreamHits.length, 0);
    });
  });
});

test('proxies every other request straight through to the upstream server', async () => {
  await withFixture(async base => {
    await withServers(base, async ({ devUrl, upstreamHits }) => {
      const res = await fetch(`${devUrl}/some/atomic-data/resource?x=1`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('x-from'), 'upstream');
      assert.equal(
        await res.text(),
        'upstream:/some/atomic-data/resource?x=1',
      );
      assert.deepEqual(upstreamHits, ['/some/atomic-data/resource?x=1']);
    });
  });
});

test('createDevServer requires an upstream', () => {
  assert.throws(() => createDevServer({}), /requires an upstream/);
});

test('hosts the certified integration bundles in this repository', () => {
  const assets = hostedAssets(root);
  assert.ok(assets.has('catalog.json'));
  assert.ok(assets.has('github-issues/plugin.js'));
  assert.ok(assets.has('notion/plugin.js'));
});
