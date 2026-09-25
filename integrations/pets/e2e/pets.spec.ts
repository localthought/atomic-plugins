// @wc-ignore-file
/**
 * The Pets drive app (`integrations/pets/app/`), end to end, from the catalog:
 * discover it on the Integrations page, install it (the host downloads the
 * module the catalog entry names and checks it against the entry's integrity
 * hash), connect Pets through the host's consent bar and the (mock)
 * integration proxy, import the five pets into the app's own table, and
 * reopen it. Then move it to the catalog's version from an older one, keeping
 * its rows. No credential ever reaches the frame or the drive, and no test
 * helper touches the app's source.
 *
 * The connect flow is the integration proxy's 0.2 one (#54 phase 2): consent
 * bar → proxy `/connect` → back to `/app/integrations`, where the page
 * redeems the handoff signed with the user's key (the user owns the
 * connection) and delegates it to the app's agent; the frame then gets a
 * capability from the page and calls the proxy itself, signing each request
 * with its own key. The mock proxy checks every signature the way the real
 * one does. Revoking the delegation and picking "Use existing connection"
 * gets the app back without a second trip through the proxy.
 *
 * The lane's dev-server stands in for GitHub Pages: it serves the committed
 * `apps/pets/<version>/ui.js` at `/apps/pets/<version>/ui.js` and points the
 * catalog's `app-module` there, leaving `app-module-integrity` as committed
 * (integrations/tooling/apps.mjs).
 *
 * Needs an atomic-server with frame capabilities (atomic-server#1697) and
 * catalog app installation (atomic-server#1689, for #94). Run it the way CI
 * does:
 *   node integrations/tooling/run-lane.mjs pets --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

/** The catalog's version of the Pets app (integrations/catalog.json). */
const VERSION = '0.1.2';

test.describe('pets integration', () => {
  test.beforeEach(before);

  test('Pets installs from the catalog, connects, imports, reopens and updates', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    const main = page.getByRole('main');
    const app = page.frameLocator('iframe[title="App"]');
    const card = await openCatalogCard(page);

    // Discovery: the catalog's version, not installed yet.
    await expect(card.getByRole('heading', { name: 'Pets' })).toBeVisible();
    await expect(card).toContainText(`Version ${VERSION}`);

    // Installation: app, entry point, table and ontology from the catalog.
    await card.getByRole('button', { name: 'Install Pets' }).click();
    await expect(main.locator('iframe[title="App"]')).toBeVisible({
      timeout: 45_000,
    });
    const appUrl = page.url();
    await expect(app.getByRole('heading', { name: 'Pets' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(app.getByRole('status')).toContainText('Not connected');

    // Connection: drawn by the host page, outside the frame.
    await app.getByRole('button', { name: 'Connect Pets' }).click();
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Pets');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Pets with this destination',
        exact: true,
      })
      .click();

    // First import, back on the app page with the handoff out of the URL.
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 pets (5 added', { timeout: 30_000 });

    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app. The page keeps nothing credential-like: not
    // even the PKCE state of the finished handoff.
    const [connection] = await proxyConnections('pets');
    expect(connection.owner).toBe(await signedInAgent(page));
    expect(connection.delegations).toHaveLength(1);
    expect(connection.last_used_at).not.toBeNull();
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atomic-proxy-connect|connection-v1/),
      ]),
    );
    const table = await tableOf(page);

    // Revoked at the proxy (say, from another device): the app is no longer
    // connected. Using the existing connection again delegates it anew,
    // with no trip through the proxy's consent page.
    await revoke(connection.connection_id, connection.delegations[0].agent);
    await page.reload();
    await expect(app.getByRole('status')).toContainText('Not connected', {
      timeout: 30_000,
    });
    await app.getByRole('button', { name: 'Connect Pets' }).click();
    await consent
      .getByRole('button', { name: 'Use existing connection' })
      .click();
    await expect(consent).toBeHidden();
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 pets (0 added, 0 updated, 5 unchanged)', {
      timeout: 30_000,
    });
    expect(page.url()).toBe(appUrl);
    const again = await proxyConnections('pets');
    expect(again).toHaveLength(1);
    expect(again[0].delegations.map(d => d.agent)).toEqual(
      connection.delegations.map(d => d.agent),
    );

    // Reopen from the catalog card: installed at the catalog's version, still
    // connected, and a re-sync finds nothing new.
    const reopened = await openCatalogCard(page);
    await expect(reopened).toContainText(`Installed ${VERSION}`);
    await expect(
      reopened.getByRole('button', { name: /^Update to/ }),
    ).toHaveCount(0);
    await reopened.getByRole('button', { name: 'Open Pets' }).click();
    await expect(page).toHaveURL(appUrl);
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 pets (0 added, 0 updated, 5 unchanged)', {
      timeout: 30_000,
    });

    // Update: an app installed at an older version is offered the catalog's
    // one. Only the recorded version is rewound here; the update itself
    // downloads and checks the module again, and must keep the rows.
    await setInstalledVersion(page, VERSION, '0.0.1');
    const outdated = await openCatalogCard(page);
    await expect(outdated).toContainText('Installed 0.0.1');
    await outdated
      .getByRole('button', { name: `Update to ${VERSION}` })
      .click();
    await expect(outdated).toContainText(`Installed ${VERSION}`, {
      timeout: 30_000,
    });
    await outdated.getByRole('button', { name: 'Open Pets' }).click();
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 pets (0 added, 0 updated, 5 unchanged)', {
      timeout: 30_000,
    });

    // Rows are an ordinary table: open it outside the app.
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
    );
    await expect(
      main.getByRole('heading', { name: 'Pets', exact: true }),
    ).toBeVisible();
    for (const name of ['Rex', 'Whiskers', 'Tweety', 'Nibbles', 'Bubbles'])
      await expect(main.getByText(name, { exact: true }).first()).toBeVisible();

    // Numeric and boolean properties keep their Atomic datatype.
    const datatypes = await page.evaluate(async () => {
      const store = window.store!;
      const rows = await store.getResource(
        new URL(location.href).searchParams.get('subject')!,
      );
      const klass = await store.getResource(
        rows.get('https://atomicdata.dev/properties/classtype') as string,
      );
      const fields = klass.get(
        'https://atomicdata.dev/properties/recommends',
      ) as string[];
      const properties = await Promise.all(
        fields.map(s => store.getResource(s)),
      );

      return Object.fromEntries(
        properties.map(p => [
          p.get('https://atomicdata.dev/properties/name'),
          p.get('https://atomicdata.dev/properties/datatype'),
        ]),
      );
    });
    expect(datatypes).toMatchObject({
      Age: 'https://atomicdata.dev/datatypes/integer',
      Vaccinated: 'https://atomicdata.dev/datatypes/boolean',
      Weight: 'https://atomicdata.dev/datatypes/float',
      'Updated at': 'https://atomicdata.dev/datatypes/timestamp',
    });
  });
});

interface MockConnection {
  connection_id: string;
  platform: string;
  owner: string;
  last_used_at: string | null;
  delegations: { agent: string; label: string | null }[];
}

/** The mock proxy's connections for `platform` (test-side introspection). */
async function proxyConnections(platform: string): Promise<MockConnection[]> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/__mock/connections`,
  );
  const { connections } = (await response.json()) as {
    connections: MockConnection[];
  };

  return connections.filter(c => c.platform === platform);
}

/** Drops one delegation at the mock proxy, as the owner would elsewhere. */
async function revoke(connectionId: string, agent: string) {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/__mock/revoke`,
    {
      method: 'POST',
      body: JSON.stringify({ connection_id: connectionId, agent }),
    },
  );
  expect(response.status).toBe(200);
}

/** The signed-in agent as the proxy names it: `atomic:agent:<base64url>`. */
async function signedInAgent(page: Page): Promise<string> {
  const key = await page.evaluate(() =>
    window.store!.getAgent()!.getPublicKey(),
  );

  return `atomic:agent:${Buffer.from(key, 'base64').toString('base64url')}`;
}

/** The Integrations page's Pets card, with experimental plugins shown. */
async function openCatalogCard(page: Page) {
  await page.goto(new URL('/app/integrations', page.url()).href);
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  // Disabled while the setting is still saving to the private drive.
  await expect(experimental).toBeEnabled({ timeout: 30_000 });

  return page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="pets"]');
}

/** The app's table: the value on the app that is a Table (`app-data`). */
async function tableOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.store!;
    const subject = new URL(location.href).searchParams.get('subject')!;
    const app = await store.getResource(subject);
    const candidates = Object.values(app.getPropVals()).filter(
      (v): v is string => typeof v === 'string' && v.includes(':'),
    );

    for (const candidate of candidates) {
      const child = await store.getResource(candidate).catch(() => undefined);
      if (!child) continue;
      const classes = child.get('https://atomicdata.dev/properties/isA');

      if (
        Array.isArray(classes) &&
        classes.some(c => String(c).endsWith('/classes/Table'))
      )
        return candidate;
    }

    throw new Error('could not find the app’s table');
  });
}

/**
 * Rewinds the version the app on screen records as installed, the way an app
 * installed before a catalog release would look. The recorded version is the
 * app's only property holding exactly `from` (the host's drive-local
 * `app-version`, whose subject is minted per drive).
 */
async function setInstalledVersion(page: Page, from: string, to: string) {
  await page.evaluate(
    async ([current, rewound]) => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;
      const app = await store.getResource(subject);
      const matches = Object.entries(app.getPropVals()).filter(
        ([, v]) => v === current,
      );
      if (matches.length !== 1)
        throw new Error(`expected one property holding ${current}`);
      await app.set(matches[0][0], rewound);
      await app.save();
    },
    [from, to] as const,
  );
}
