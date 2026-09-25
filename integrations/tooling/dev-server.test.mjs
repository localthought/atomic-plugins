import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from 'node:fs';
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

const APP = 'https://atomicdata.dev/integrations/properties/';

test('serves committed drive app modules where Pages does, and points the catalog at them', async () => {
  await withFixture(async base => {
    mkdirSync(join(base, 'apps/gamma/1.0.0'), { recursive: true });
    writeFileSync(
      join(base, 'apps/gamma/1.0.0/ui.js'),
      'export async function view() {}',
    );
    writeFileSync(
      join(base, 'integrations/catalog.json'),
      JSON.stringify([
        {
          'https://atomicdata.dev/properties/shortname': 'gamma',
          [`${APP}version`]: '1.0.0',
          [`${APP}app-module`]:
            'https://ontola.github.io/atomic-plugins/apps/gamma/1.0.0/ui.js',
          [`${APP}app-module-integrity`]: 'sha384-pinned',
        },
        {
          'https://atomicdata.dev/properties/shortname': 'elsewhere',
          [`${APP}app-module`]: 'https://example.com/ui.js',
        },
      ]),
    );

    await withServers(base, async ({ devUrl }) => {
      const served = await (
        await fetch(`${devUrl}/integrations/catalog.json`)
      ).text();
      // Byte for byte the committed file, apart from the one URL prefix.
      assert.equal(
        served,
        readFileSync(join(base, 'integrations/catalog.json'), 'utf8').replace(
          '"https://ontola.github.io/atomic-plugins/apps/',
          `"${devUrl}/apps/`,
        ),
      );
      const [entry, elsewhere] = JSON.parse(served);
      assert.equal(
        entry[`${APP}app-module`],
        `${devUrl}/apps/gamma/1.0.0/ui.js`,
      );
      // The pin is left alone: the host still checks the module against it.
      assert.equal(entry[`${APP}app-module-integrity`], 'sha384-pinned');
      // Only Pages URLs move.
      assert.equal(elsewhere[`${APP}app-module`], 'https://example.com/ui.js');

      const module = await fetch(entry[`${APP}app-module`]);
      assert.equal(module.status, 200);
      assert.equal(module.headers.get('access-control-allow-origin'), '*');
      assert.equal(module.headers.get('content-type'), 'text/javascript');
      assert.equal(await module.text(), 'export async function view() {}');

      for (const missing of [
        '/apps/gamma/2.0.0/ui.js',
        '/apps/gamma/1.0.0/other.js',
        '/apps/gamma/..%2F..%2Fintegrations/ui.js',
      ])
        assert.equal((await fetch(`${devUrl}${missing}`)).status, 404, missing);
    });
  });
});

test('hosts the certified integration bundles in this repository', () => {
  const assets = hostedAssets(root);
  assert.ok(assets.has('catalog.json'));
  assert.ok(assets.has('notion/plugin.js'));
});

test('serves the committed ontology terms like Pages, with subjects on its own origin', async () => {
  await withFixture(async base => {
    const published = 'https://vocab.example/ontology';
    mkdirSync(join(base, 'ontology-kit'), { recursive: true });
    mkdirSync(join(base, 'ontology/classes'), { recursive: true });
    writeFileSync(
      join(base, 'ontology-kit/base.json'),
      JSON.stringify({ base: published }),
    );
    writeFileSync(
      join(base, 'ontology/classes/thing-v1'),
      JSON.stringify({
        '@id': `${published}/classes/thing-v1`,
        parent: `${published}/v1`,
      }),
    );

    await withServers(base, async ({ devUrl }) => {
      const res = await fetch(`${devUrl}/ontology/classes/thing-v1`);
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('content-type'), 'application/octet-stream');
      assert.equal(res.headers.get('access-control-allow-origin'), '*');
      assert.deepEqual(await res.json(), {
        '@id': `${devUrl}/ontology/classes/thing-v1`,
        parent: `${devUrl}/ontology/v1`,
      });

      // Pages can't pass a CORS preflight; neither does this.
      const preflight = await fetch(`${devUrl}/ontology/classes/thing-v1`, {
        method: 'OPTIONS',
        headers: {
          origin: 'http://localhost:1',
          'access-control-request-method': 'GET',
          'access-control-request-headers': 'x-atomic-agent',
        },
      });
      assert.equal(preflight.status, 405);
      assert.equal(preflight.headers.get('access-control-allow-origin'), null);

      for (const path of [
        '/ontology/classes/missing-v1',
        '/ontology/classes/thing-v1.json',
        '/ontology/classes/%2e%2e/%2e%2e/ontology-kit/base.json',
        '/ontology/Classes/thing-v1',
        '/ontology/',
      ])
        assert.equal((await fetch(`${devUrl}${path}`)).status, 404, path);
    });
  });
});

test('serves this repository’s shared ontology', async () => {
  await withServers(root, async ({ devUrl }) => {
    const res = await fetch(`${devUrl}/ontology/classes/event-v1`);
    assert.equal(res.status, 200);
    const event = await res.json();
    assert.equal(event['@id'], `${devUrl}/ontology/classes/event-v1`);
    assert.deepEqual(event['https://atomicdata.dev/properties/isA'], [
      'https://atomicdata.dev/classes/Class',
    ]);
  });
});
