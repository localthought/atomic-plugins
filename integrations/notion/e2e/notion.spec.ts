// @wc-ignore-file
/**
 * The Notion drive plugin (`../app/`) end to end: an app in the drive runs
 * `dist/ui.js` in its null-origin frame, connects through the host's consent
 * bar and the mock integration proxy, and imports the mock proxy's notion
 * fixture through syncables/browser, cursor in the POST body included.
 *
 * The connect flow is the proxy's 0.2 one (#54 phase 2): the page redeems the
 * handoff signed with the user's key and delegates the connection to the
 * app's agent; the frame calls the proxy itself with a capability and its
 * own key (atomic-server#1697, in the pin). This spec
 * replaces the old one, which drove the `[data-integration=notion]` card that
 * atomic-server 4bab16ee6 removed (#68). Its two-way, PATCH and
 * revoked-access checks have no read-only counterpart, so they are gone.
 *
 * The app is installed from the catalog, as in the pets spec: the
 * Integrations page's Drive apps section, with the lane's dev-server serving
 * the committed `apps/notion/<version>/ui.js` in place of GitHub Pages and
 * the host checking it against the catalog's integrity hash.
 *
 * Run it the way CI would:
 *   node integrations/tooling/run-lane.mjs notion --tier e2e
 */
import { test, expect, type Page, type TestInfo } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

const APP_FRAME = 'iframe[title="App"]';
/** The catalog's version of this app (integrations/catalog.json). */
const VERSION = '0.1.0';

test.describe('notion drive plugin', () => {
  test.beforeEach(before);
  // No integration-discovery settings: a drive app needs none, and that
  // helper's signature differs between the pinned and newer atomic-server.

  test('imports every shared Notion page through the integration proxy', async ({
    page,
  }, testInfo) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(300_000);
    await driver('setScenario', ['default']);
    await installFromCatalog(page);

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
        name: 'Use LocalThought to sync Notion with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // Back on the app, which finds its connection and imports on open
    // (#89: the rows show in the app, and warnings are in Sync details).
    await expect(app.getByRole('status')).toContainText('Synced', {
      timeout: 60_000,
    });
    const appUrl = page.url();
    const imported = app.getByRole('table');
    for (const title of ['Launch plan', 'Write changelog', 'Retrospective'])
      await expect(
        imported.getByRole('cell', { name: title, exact: true }),
      ).toBeVisible();
    await app.getByRole('button', { name: 'Sync details' }).click();
    await expect(
      app.getByRole('dialog', { name: 'Sync details' }),
    ).toContainText('1 page has formatting in Notes');
    await page.keyboard.press('Escape');

    // The rows are ordinary rows of the app's table, named by the catalog
    // entry's `app-row-name-plural` ("Pages"). After the connect round trip
    // the app's folder is usually still expanded in the sidebar; expand it
    // only when it is not.
    const sidebar = page.getByRole('navigation').last();
    const items = sidebar.getByRole('button', { name: 'Pages', exact: true });

    if (!(await items.isVisible()))
      await sidebar
        .locator('[data-sidebar-id]')
        .filter({
          has: page.getByRole('button', { name: 'Notion', exact: true }),
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

    // Back to the app for each state of #89's design, against the fixture's
    // scenarios. One connection serves them all.
    await page.goto(appUrl);
    await statesTour(page, testInfo);
  });
});

/** Calls a mock-proxy test driver of the notion fixture. */
async function driver(name: string, args: unknown[]) {
  const base = process.env.INTEGRATION_PROXY_URL;
  if (!base) return null;
  const response = await fetch(`${base}/fixture/notion/${name}`, {
    method: 'POST',
    body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`driver ${name}: HTTP ${response.status}`);

  return response.json();
}

const DONE_OPTION = 'b1f5a3c2-0001-4000-8000-000000000003';

/**
 * DESIGN.md §6 states S6–S13 in the real frame: text and roles, not pixels.
 * Screenshots go to the test's output folder as artefacts.
 */
async function statesTour(page: Page, testInfo: TestInfo) {
  const app = page.frameLocator(APP_FRAME);
  const status = app.getByRole('status');
  const banner = app.locator('.pl-banner');
  const shot = (name: string) =>
    page.screenshot({ path: testInfo.outputPath(`${name}.png`) });

  const syncNow = async () => {
    await expect(app.getByRole('button', { name: 'Sync now' })).toBeEnabled({
      timeout: 60_000,
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
  };

  try {
    // S6, N6: a second database; its "Status" has another property id.
    await driver('setScenario', ['two-sources']);
    await expect(status).toContainText('Synced', { timeout: 60_000 });
    await syncNow();
    const chips = app.getByRole('group', { name: 'Databases' });
    await expect(
      chips.getByRole('button', { name: /Reading list/ }),
    ).toBeVisible({
      timeout: 60_000,
    });
    await chips.getByRole('button', { name: /Roadmap/ }).click();
    const table = app.getByRole('table');
    await expect(table.getByRole('columnheader')).toHaveText([
      'Name',
      'Status',
      'Done',
      'Points',
      'Tags',
      'Notes',
      'Last edited in Notion',
    ]);
    // N7: option names, not ids.
    await expect(table.getByRole('row', { name: /Launch plan/ })).toContainText(
      'In progress',
    );
    await shot('s6-table');

    // S7: side peek, Esc closes.
    await table.getByRole('cell', { name: 'Launch plan', exact: true }).click();
    const peek = app.getByRole('complementary', { name: 'Row details' });
    await expect(peek).toContainText('Launch plan');
    await expect(peek).toContainText('Read-only copy');
    await shot('s7-peek');
    // "Open in Notion" goes through store.openExternal: the host names the
    // destination and asks first. Cancel, so the test opens no tab.
    await peek.getByRole('button', { name: 'Open in Notion' }).click();
    const linkBar = page.getByRole('group', { name: 'Open a link' });
    await expect(linkBar).toContainText('www.notion.so');
    await shot('s7-open-link');
    await linkBar.getByRole('button', { name: 'Cancel' }).click();
    await expect(linkBar).toBeHidden();
    await expect(app.locator('.pl-copy')).toHaveCount(0);
    // Focus went to the host's bar; Esc from inside the peek closes it.
    await peek.getByRole('button', { name: 'Open in Notion' }).press('Escape');
    await expect(peek).toBeHidden();

    // S8: board by status.
    await app.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(
      app.getByRole('list', { name: 'Grouped by Status' }),
    ).toContainText('In progress');
    await shot('s8-board');
    await app.getByRole('button', { name: 'Table', exact: true }).click();

    // S10: sync details list what was not copied, per database.
    await app.getByRole('button', { name: 'Sync details' }).click();
    const details = app.getByRole('dialog', { name: 'Sync details' });
    await expect(details).toContainText('Reading list');
    await expect(details).toContainText('Recommended by people');
    await shot('s10-details');
    await page.keyboard.press('Escape');

    // N7: a rename in Notion shows after one sync, rows untouched.
    await driver('renameOption', [DONE_OPTION, 'Shipped']);
    await syncNow();
    await expect(
      table.getByRole('row', { name: /Write changelog/ }),
    ).toContainText('Shipped', { timeout: 60_000 });

    // S12: rate limited, with the retry time.
    await driver('setScenario', ['rate-limited']);
    await syncNow();
    await expect(banner).toContainText('Notion asked Atomic to slow down', {
      timeout: 60_000,
    });
    await expect(status).toContainText('Paused until');
    await shot('s12-rate-limited');

    // S13: any other failure, with technical details.
    await driver('setScenario', ['bad-gateway']);
    await banner.getByRole('button', { name: 'Try now' }).click();
    await expect(banner).toContainText('Notion didn’t answer properly', {
      timeout: 60_000,
    });
    await expect(banner.getByText('Technical details')).toBeVisible();
    await expect(status).toHaveText('Sync failed');
    await shot('s13-failed');

    // S5 over kept rows: nothing shared any more.
    await driver('setScenario', ['empty']);
    await banner.getByRole('button', { name: 'Try again' }).click();
    await expect(banner).toContainText('no longer shares any databases', {
      timeout: 60_000,
    });
    await expect(
      table.getByRole('cell', { name: 'Launch plan', exact: true }),
    ).toBeVisible();

    // S11: Notion revoked access; rows are kept.
    await driver('setScenario', ['unauthorized']);
    await syncNow();
    await expect(banner).toContainText('Notion no longer gives Atomic access', {
      timeout: 60_000,
    });
    await expect(
      banner.getByRole('button', { name: 'Reconnect Notion' }),
    ).toBeVisible();
    await shot('s11-reauth');

    // "Open data table" (store.openResource) shows the table in the host.
    await driver('setScenario', ['default']);
    const appUrl = page.url();
    await app.getByRole('button', { name: 'More' }).click();
    await app.getByRole('menuitem', { name: 'Open data table' }).click();
    await expect(page).not.toHaveURL(appUrl);
    await expect(
      page.getByRole('main').getByText('Launch plan', { exact: true }).first(),
    ).toBeVisible();
    await page.goto(appUrl);

    // "Disconnect Notion…" (store.proxy.disconnect), after a confirmation:
    // the rows stay, and the app offers to connect again. (The last saved
    // record is the "nothing shared" one, so the pill says so.)
    await expect(status).toHaveText('No databases shared', { timeout: 60_000 });
    await app.getByRole('button', { name: 'More' }).click();
    await app.getByRole('menuitem', { name: 'Disconnect Notion…' }).click();
    await expect(banner).toContainText('Disconnect Notion from this app?');
    await banner
      .getByRole('button', { name: 'Disconnect', exact: true })
      .click();
    await expect(banner).toContainText('Notion is not connected to this app', {
      timeout: 30_000,
    });
    await expect(status).toHaveText('Not connected');
    await expect(
      table.getByRole('cell', { name: 'Launch plan', exact: true }),
    ).toBeVisible();
    await shot('disconnected');
  } finally {
    await driver('setScenario', ['default']);
    await driver('renameOption', [DONE_OPTION, 'Done']).catch(() => {});
  }
}

/**
 * Installs the app the way a user does: Integrations page, experimental
 * plugins shown, Drive apps, Install. The host downloads the catalog's
 * `app-module` (the lane's dev-server serves the committed
 * `apps/notion/<version>/ui.js` in place of GitHub Pages) and refuses it
 * unless its bytes match `app-module-integrity`, then opens the new app.
 * Returns the card, for its "Installed <version>" line.
 */
async function installFromCatalog(page: Page) {
  await page.goto(new URL('/app/integrations', page.url()).href);
  const experimental = page.getByRole('checkbox', {
    name: 'Show experimental plugins',
  });
  await experimental.check();
  // Disabled while the setting is still saving to the private drive.
  await expect(experimental).toBeEnabled({ timeout: 30_000 });
  const entry = page
    .getByRole('region', { name: 'Drive apps' })
    .locator('[data-catalog-app="notion"]');
  await expect(entry).toContainText(`Version ${VERSION}`);
  await entry.getByRole('button', { name: 'Install Notion' }).click();
  await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
    timeout: 45_000,
  });

  return entry;
}
