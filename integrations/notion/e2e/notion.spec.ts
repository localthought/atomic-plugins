// @wc-ignore-file
/**
 * The Notion drive plugin (`../app/`) end to end: an app in the drive runs
 * `dist/ui.js` in its null-origin frame, connects through the host's
 * integration-proxy relay (#52), and imports the mock proxy's notion fixture
 * through syncables/browser, cursor in the POST body included.
 *
 * It needs an atomic-server with #52's relay (`store.proxy`, the host consent
 * bar and the connect return): ontola/atomic-server#1657, merged into
 * `feat/plugin-debug` together with the Notion code removal (#1658). The pin,
 * `bae5cdbe3`, has both. This spec
 * replaces the old one, which drove the `[data-integration=notion]` card that
 * atomic-server 4bab16ee6 removed (#68). Its two-way, PATCH and
 * revoked-access checks have no read-only counterpart, so they are gone.
 *
 * The install is test-side, as in the pets spec: there is no catalog install
 * flow for drive apps yet. So it makes a "New app" and replaces its entry
 * point's source with the built module.
 *
 * Run it the way CI would:
 *   node integrations/tooling/run-lane.mjs notion --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from '../app/build.mjs';

const APP_FRAME = 'iframe[title="App"]';

test.describe('notion drive plugin', () => {
  test.beforeEach(before);
  // No integration-discovery settings: a drive app needs none, and that
  // helper's signature differs between the pinned and newer atomic-server.

  test('imports every shared Notion page through the proxy relay', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(180_000);
    const { text } = (await build()) as { text: string };

    await createFromCatalog(page, 'App');
    await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
      timeout: 45_000,
    });
    await setAppSource(page, text);
    await page.reload();

    const app = page.frameLocator(APP_FRAME);
    await app.getByRole('button', { name: 'Connect Notion' }).click();
    // The consent bar is drawn by the host, outside the frame, so the frame
    // cannot click it for the user.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Notion');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Notion with your Atomic Data Hub',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=/);

    // Back on the app, which finds its connection and imports on open.
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('3 created', { timeout: 60_000 });
    await expect(app.getByRole('status')).toContainText(
      'property "Notes" (rich_text) has no lossless plain value',
    );

    // The rows are ordinary rows of the app's table ("Items" for a new app).
    // After the connect round trip the app's folder is usually still
    // expanded in the sidebar; expand it only when it is not.
    const sidebar = page.getByRole('navigation').last();
    const items = sidebar.getByRole('button', { name: 'Items', exact: true });

    if (!(await items.isVisible()))
      await sidebar
        .locator('[data-sidebar-id]')
        .filter({
          has: page.getByRole('button', { name: 'New app', exact: true }),
        })
        .getByRole('button', { name: 'Expand folder' })
        .click();
    await items.click();
    const main = page.getByRole('main');

    for (const title of ['Launch plan', 'Write changelog', 'Retrospective'])
      await expect(
        main.getByText(title, { exact: true }).first(),
      ).toBeVisible();

    // Columns are named after the Notion properties and keep the lens's
    // datatypes rather than becoming JSON.
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
        fields.map((s: string) => store.getResource(s)),
      );

      return Object.fromEntries(
        properties.map(p => [
          p.get('https://atomicdata.dev/properties/name'),
          p.get('https://atomicdata.dev/properties/datatype'),
        ]),
      );
    });
    expect(datatypes).toMatchObject({
      Done: 'https://atomicdata.dev/datatypes/boolean',
      Points: 'https://atomicdata.dev/datatypes/float',
      Status: 'https://atomicdata.dev/datatypes/string',
      'Last edited in Notion': 'https://atomicdata.dev/datatypes/timestamp',
    });
  });
});

/**
 * Replaces the entry point's source of the app on screen through
 * `window.store`, the way atomic-server's apps.spec.ts does: the entry point
 * is a child of the app whose source property is found by its value.
 */
async function setAppSource(page: Page, source: string) {
  await page.evaluate(async (next: string) => {
    const store = (
      window as unknown as {
        store: {
          getResource(s: string): Promise<{
            getPropVals(): Record<string, unknown>;
            set(p: string, v: unknown): Promise<void>;
            save(): Promise<unknown>;
          }>;
        };
      }
    ).store;
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
