// @wc-ignore-file
/**
 * The Clockify timesheets drive app (`integrations/timesheets/app/`), end to
 * end in a real host: the app runs in its null-origin iframe, connects
 * Clockify through the host's consent bar and the (mock) integration proxy,
 * is set up in the frame (workspace, account, 7/30-day look-back), and
 * imports through the integration proxy into its own table, with the
 * Properties it creates under its own ontology. Then: reload (no
 * duplicates), a changed entry, a wider window, and a proxy failure that
 * leaves the rows readable and recovers.
 *
 * The install is test-side, as in the Pets and Notion specs: `New app`, then
 * its entry point's source is replaced with `app/build.mjs`'s bundle. There
 * is no catalog install flow for drive apps yet (#94).
 *
 * Provider data changes and failures go through the mock proxy's local-only
 * fixture driver (`POST /__fixture/clockify`, see
 * `../fixtures/clockify/scenario.mjs`). Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs timesheets --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from '../app/build.mjs';

const APP_FRAME = 'iframe[title="App"]';

/** Sends a command to the mock proxy's Clockify fixture. */
async function fixture(command: Record<string, unknown>) {
  const base = process.env.INTEGRATION_PROXY_URL;
  if (!base) throw new Error('INTEGRATION_PROXY_URL is not set');
  const response = await fetch(`${base}/__fixture/clockify`, {
    method: 'POST',
    body: JSON.stringify(command),
  });
  expect(response.status).toBe(200);

  return (await response.json()) as Record<string, unknown>;
}

/** `start` of every time-entries request the mock has seen, in order. */
async function windowStarts(): Promise<string[]> {
  const { requests } = (await fixture({ action: 'requests' })) as {
    requests: string[];
  };

  return requests
    .filter(r => r.includes('/time-entries?'))
    .map(r => new URL(r.slice(r.indexOf(' ') + 1), 'http://x'))
    .map(u => u.searchParams.get('start')!);
}

test.describe('timesheets drive app', () => {
  test.beforeEach(before);

  test('connects, sets up and imports Clockify entries through the host relay', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await fixture({ action: 'reset' });
    const { text } = (await build()) as { text: string };

    await createFromCatalog(page, 'App');
    await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
      timeout: 45_000,
    });
    await setAppSource(page, text);
    await page.reload();
    const appUrl = page.url();

    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    await expect(
      app.getByRole('heading', { name: 'Clockify timesheets' }),
    ).toBeVisible();
    await expect(status).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Clockify' }).click();

    // Drawn by the host page, outside the frame: only a click here navigates.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Clockify');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    // An API-key platform: the key is pasted on the proxy's own page and
    // stays there, sealed in the connection; the drive never sees it.
    await page.getByLabel('API key').fill('synthetic-clockify-key');
    await page
      .getByRole('button', { name: 'Connect Clockify', exact: true })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // Setup, in the frame: the account and its workspaces come through the proxy.
    await expect(status).toContainText('Choose the workspace', {
      timeout: 30_000,
    });
    await expect(app.getByText('Clockify account: Test Person')).toBeVisible();
    await app
      .getByRole('combobox', { name: 'Workspace' })
      .selectOption({ label: 'Test workspace' });
    await app
      .getByRole('combobox', { name: 'Look-back' })
      .selectOption({ label: 'the last 7 days' });
    await app.getByRole('button', { name: 'Save and import' }).click();

    // Two completed entries; the running timer and the break are not rows.
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '2 created, 0 updated, 0 unchanged, last 7 days.',
      {
        timeout: 60_000,
      },
    );
    const table = await tableOf(page);

    // The drive holds settings, never the connection or the key.
    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app; the page keeps nothing credential-like.
    const connections = await proxyConnections('clockify');
    expect(connections).toHaveLength(1);
    expect(connections[0].owner).toBe(await signedInAgent(page));
    expect(connections[0].delegations).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atomic-proxy-connect|connection-v1/),
      ]),
    );
    const appValues = await page.evaluate(async () => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;

      return JSON.stringify((await store.getResource(subject)).getPropVals());
    });
    expect(appValues).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(appValues).not.toMatch(
      /connection[-_]?code|bearer|capabilit|synthetic-clockify-key/i,
    );

    // Columns are Properties the app created, with Atomic datatypes.
    expect(await columnDatatypes(page, table)).toMatchObject({
      Start: 'https://atomicdata.dev/datatypes/timestamp',
      End: 'https://atomicdata.dev/datatypes/timestamp',
      Billable: 'https://atomicdata.dev/datatypes/boolean',
      Project: 'https://atomicdata.dev/datatypes/string',
      'Clockify entry id': 'https://atomicdata.dev/datatypes/string',
    });

    // Reload: the app finds its connection and settings and syncs on open,
    // without creating duplicates.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 2 unchanged',
      { timeout: 60_000 },
    );

    // A changed entry in Clockify updates its row in place.
    await fixture({
      action: 'update',
      id: 'entry-1',
      patch: { description: 'Fix plugin source loading (renamed)' },
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 1 updated, 1 unchanged',
      { timeout: 60_000 },
    );

    // The window is recomputed on every run, so it moves with the clock.
    const starts = await windowStarts();
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(Date.parse(starts.at(-1)!)).toBeGreaterThan(Date.parse(starts[0]));

    // Widening to 30 days brings in the older entry, and only that one.
    await app.getByRole('button', { name: 'Change settings' }).click();
    await app
      .getByRole('combobox', { name: 'Look-back' })
      .selectOption({ label: 'the last 30 days' });
    await app.getByRole('button', { name: 'Save and import' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '1 created, 0 updated, 2 unchanged, last 30 days.',
      {
        timeout: 60_000,
      },
    );

    // A proxy failure: the error is shown and nothing is written.
    await fixture({ action: 'fail', status: 503, count: 1 });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status).toContainText('Import failed: Clockify request', {
      timeout: 60_000,
    });
    await expect(status).toContainText('failed with 503');
    await expect(status).toContainText('Rows already in the table are kept.');

    // The rows stay an ordinary, readable table outside the app: each entry
    // once, no running timer, no break.
    await expectRows(page, table);

    // Reopening the app recovers: it syncs on open, without duplicates.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 3 unchanged',
      { timeout: 60_000 },
    );
    await expectRows(page, table);
  });
});

async function expectRows(page: Page, table: string) {
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
  );
  const main = page.getByRole('main');

  for (const name of [
    'Fix plugin source loading (renamed)',
    'Weekly sync',
    'Plugin catalog evidence',
  ])
    await expect(main.getByText(name, { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });

  for (const skipped of ['Still running', 'Lunch'])
    await expect(main.getByText(skipped, { exact: true })).toHaveCount(0);
}

async function columnDatatypes(
  page: Page,
  table: string,
): Promise<Record<string, string>> {
  return page.evaluate(async (subject: string) => {
    const store = window.store!;
    const tableResource = await store.getResource(subject);
    const klass = await store.getResource(
      tableResource.get(
        'https://atomicdata.dev/properties/classtype',
      ) as string,
    );
    const fields = klass.get(
      'https://atomicdata.dev/properties/recommends',
    ) as string[];
    const properties = await Promise.all(fields.map(s => store.getResource(s)));

    return Object.fromEntries(
      properties.map(p => [
        p.get('https://atomicdata.dev/properties/name'),
        p.get('https://atomicdata.dev/properties/datatype'),
      ]),
    );
  }, table);
}

interface MockConnection {
  connection_id: string;
  platform: string;
  owner: string;
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

/** The signed-in agent as the proxy names it: `atomic:agent:<base64url>`. */
async function signedInAgent(page: Page): Promise<string> {
  const key = await page.evaluate(() =>
    window.store!.getAgent()!.getPublicKey(),
  );

  return `atomic:agent:${Buffer.from(key, 'base64').toString('base64url')}`;
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
 * Replaces the source of the app on screen, through `window.store`. Copied
 * from atomic-server's `browser/e2e/tests/apps.spec.ts` (not exported there),
 * as the Pets and Notion specs do.
 */
async function setAppSource(page: Page, source: string) {
  await page.evaluate(async (next: string) => {
    const store = window.store!;
    const subject = decodeURIComponent(
      new URL(location.href).searchParams.get('subject')!,
    );
    const app = await store.getResource(subject);

    for (const value of Object.values(app.getPropVals())) {
      if (typeof value !== 'string' || !value.includes(':')) continue;
      const child = await store.getResource(value).catch(() => undefined);
      if (!child) continue;
      const sourceProp = Object.entries(child.getPropVals()).find(
        ([, v]) =>
          typeof v === 'string' && v.includes('export async function view'),
      )?.[0];
      if (!sourceProp) continue;
      await child.set(sourceProp, next);
      await child.save();

      return;
    }

    throw new Error('could not find the app’s entry point');
  }, source);
}
