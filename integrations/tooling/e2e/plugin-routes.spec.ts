// @wc-ignore-file
/**
 * The plugin-routes gates (docs/design/server-plugin-routes.md, section 0)
 * against atomic-server built with `--features plugin-routes`
 * (atomic-server#1726) and manifest v3 (atomic-server#1732), using the
 * gated fixture plugin in ../fixtures/gated-plugin/: a version-3 manifest
 * with one anonymous `GET /hello` route, which needs `read-only`.
 *
 * The `plugin-routes` lane runs this spec once per level it declares, on a
 * fresh server each time, and says which in PLUGIN_ROUTES_LEVEL:
 *
 *   node integrations/tooling/run-lane.mjs plugin-routes --tier e2e
 *
 * What it checks at every level: publishing to this node's marketplace is
 * not gated (a public release is for any node), and `/plugin-catalog` shows
 * the release's derived `requires` and the node's `hostFeatures`. Then the
 * gate itself: pinning the release to run here is refused with the typed
 * `host-feature-unavailable` problem and the design 0.4 message below
 * `read-only`, and allowed at `read-only` and above.
 *
 * Not checked: a route answering (no host serves routes yet, AS-04/AS-05);
 * the refusal of an Installation commit, which carries only the message
 * (atomic-server's own installation test covers it); the install review UI.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { Agent, signRequest } from '@tomic/lib';
import {
  before,
  createFromCatalog,
  getDevDriveSecret,
  SERVER_URL,
} from '../../../browser/e2e/tests/test-utils';

// Playwright loads this spec as CommonJS (no package.json above it), so
// __dirname rather than import.meta.
const source = readFileSync(
  resolve(__dirname, '../fixtures/gated-plugin/plugin.js'),
  'utf8',
);
const LEVEL = process.env.PLUGIN_ROUTES_LEVEL ?? '';
const ROUTES_ORIGIN = process.env.PLUGIN_ROUTES_ORIGIN ?? null;
const RANK = ['off', 'read-only', 'read-write'];

/** What the host derives from the fixture's manifest (catalog-requires.test.mjs agrees). */
const REQUIRES = [
  'persistent-host',
  'plugin-routes:read-only',
  'public-origin',
  'wasm-sandbox',
];
const REFUSAL =
  "This plugin opens public endpoints on the server (route `GET /hello`). The server operator hasn't enabled them. To allow it, start AtomicServer with `--plugin-routes read-only` (or `ATOMIC_PLUGIN_ROUTES=read-only`).";

test.describe('plugin-routes gates', () => {
  test.skip(
    !RANK.includes(LEVEL),
    'run through run-lane.mjs, which sets PLUGIN_ROUTES_LEVEL',
  );
  test.beforeEach(before);

  test(`a gated plugin at --plugin-routes ${LEVEL || '(unset)'}`, async ({
    page,
  }) => {
    test.setTimeout(180_000);
    const target = await createGatedPlugin(page);
    const agent = Agent.fromSecret(await getDevDriveSecret(page), 'js');

    // Publishing to this node's marketplace is never gated.
    const published = await post(agent, '/plugin-release', target);
    expect(published.status, published.text).toBe(200);
    const releaseId = (published.json as { id: string }).id;

    const catalog = await (await fetch(`${SERVER_URL}/plugin-catalog`)).json();
    expect(catalog.hostFeatures?.pluginRoutes).toEqual({
      compiled: true,
      level: LEVEL,
      routesOrigin: ROUTES_ORIGIN,
      listeners: [],
      sidecars: [],
    });
    const entry = catalog.entries.find(
      (e: { releaseId?: string }) => e.releaseId === releaseId,
    );
    expect(entry, JSON.stringify(catalog.entries)).toBeTruthy();
    expect(entry.requires).toEqual(REQUIRES);

    // Pinning the release to run on this node is where the gate applies.
    const pinned = await post(agent, '/plugin-release-pin', target);

    if (RANK.indexOf(LEVEL) < RANK.indexOf('read-only')) {
      expect(pinned.status, pinned.text).toBe(409);
      expect(pinned.contentType).toContain('application/problem+json');
      expect(pinned.json).toMatchObject({
        type: 'host-feature-unavailable',
        feature: 'plugin-routes',
        needed: 'read-only',
        compiled: true,
        level: LEVEL,
        surfaces: ['route `GET /hello`'],
        listeners: [],
        sidecars: [],
        status: 409,
        detail: REFUSAL,
      });
    } else {
      expect(pinned.status, pinned.text).toBe(200);
      const { release } = pinned.json as {
        release: { manifest: { schemaVersion: number; http?: unknown } };
      };
      expect(release.manifest.schemaVersion).toBe(3);
      expect(release.manifest.http).toMatchObject({
        routes: [{ id: 'hello', path: '/hello', methods: ['GET'] }],
      });
    }
  });
});

/**
 * A Plugin draft in the test's drive whose source is the fixture, created
 * the way willow-drop.spec.ts creates one.
 */
async function createGatedPlugin(page: Page) {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });

  return page.evaluate(async code => {
    const store = window.store!;
    const plugin = new URL(location.href).searchParams.get('subject')!;
    const resource = await store.getResource(plugin);
    const sourceProp = Object.entries(resource.getPropVals()).find(
      ([, value]) =>
        typeof value === 'string' && value.includes('export function run'),
    )?.[0];
    if (!sourceProp) throw new Error('plugin has no source property');
    await resource.set(sourceProp, code);
    await resource.set(
      'https://atomicdata.dev/properties/name',
      'Gated fixture',
    );
    await resource.set(
      'https://atomicdata.dev/properties/description',
      'Tooling fixture with one read-only route.',
    );
    await resource.save();
    const drive = store.getDrive();
    if (!drive) throw new Error('no drive');

    return { drive, plugin };
  }, source);
}

/** A POST signed as the test's agent, as `@tomic/lib`'s plugin-connection does. */
async function post(agent: Agent, path: string, body: unknown) {
  const url = `${SERVER_URL}${path}`;
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      ...(await signRequest(url, agent, {})),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  const text = await response.text();
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }

  return {
    status: response.status,
    contentType: response.headers.get('content-type') ?? '',
    text,
    json,
  };
}
