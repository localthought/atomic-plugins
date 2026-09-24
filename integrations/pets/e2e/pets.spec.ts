// @wc-ignore-file
/**
 * The Pets drive app (`integrations/pets/app/`), end to end: the app runs in
 * its own null-origin iframe, connects Pets through the host's consent bar
 * and the (mock) integration proxy, and imports the five pets through the
 * host's proxy relay into its own table. No credential ever reaches the
 * frame or the drive.
 *
 * The app is installed test-side: `New app` from the catalog, then its entry
 * point's source is replaced with `app/build.mjs`'s bundle, the way
 * atomic-server's own apps.spec.ts does. There is no catalog install flow for
 * drive apps yet.
 *
 * Needs an atomic-server with the host proxy relay (atomic-server#1657, for
 * #1624, merged into `feat/plugin-debug`; the pin has it). Run it the way CI
 * does:
 *   node integrations/tooling/run-lane.mjs pets --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from '../app/build.mjs';

test.describe('pets integration', () => {
  test.beforeEach(before);

  test('Pets connects through the host and imports into its own table', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(180_000);
    const { text } = (await build()) as { text: string };

    await createFromCatalog(page, 'App');
    const main = page.getByRole('main');
    await expect(main.locator('iframe[title="App"]')).toBeVisible({
      timeout: 45_000,
    });
    await setAppSource(page, text);
    await page.reload();

    const app = page.frameLocator('iframe[title="App"]');
    await expect(app.getByRole('heading', { name: 'Pets' })).toBeVisible();
    await expect(app.getByRole('status')).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Pets' }).click();

    // Drawn by the host page, outside the frame: only a click here navigates.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Pets');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();

    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Pets with your Atomic Data Hub',
        exact: true,
      })
      .click();

    // Back on the app page, with the handoff redeemed and out of the URL.
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 pets (5 added', { timeout: 30_000 });

    // The frame never saw the rotating code; the page keeps it, and nothing
    // in the drive does.
    const stored = await page.evaluate(() =>
      Object.keys(localStorage).filter(k =>
        k.startsWith('atomic-proxy-connection-v1:'),
      ),
    );
    expect(stored).toHaveLength(1);

    // Rows are an ordinary table: open it outside the app.
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(await tableOf(page))}`,
    );
    await expect(
      main.getByRole('heading', { name: 'Pets', exact: true }),
    ).toBeVisible();
    for (const name of ['Rex', 'Whiskers', 'Tweety', 'Nibbles', 'Bubbles'])
      await expect(main.getByText(name, { exact: true }).first()).toBeVisible();

    // Numeric and boolean properties keep their Atomic datatype.
    const datatypes = await page.evaluate(async () => {
      const store = window.store!;
      const table = await store.getResource(
        new URL(location.href).searchParams.get('subject')!,
      );
      const klass = await store.getResource(
        table.get('https://atomicdata.dev/properties/classtype') as string,
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
 * from atomic-server's `browser/e2e/tests/apps.spec.ts` (not exported there).
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
