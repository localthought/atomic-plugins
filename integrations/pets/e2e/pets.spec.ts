// @wc-ignore-file
/**
 * Split out of atomic-server's `browser/e2e/tests/plugins.spec.ts` (pinned
 * commit 02cac45c) so this repo's `pets` CI lane can be gated on
 * `integrations/pets/**` alone — see `integrations/PARALLEL_LANES.md`. The
 * six tests left behind there exercise the generic plugin editor/sandbox,
 * not any one integration, and stay upstream.
 *
 * Run with the repo-local config, not atomic-server's:
 *   browser/e2e/node_modules/.bin/playwright \
 *     test --config=integrations/tooling/playwright.config.ts --project=chromium \
 *     integrations/pets/e2e/pets.spec.ts
 */
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { test, expect } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

test.describe('pets integration', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page, true);
  });

  test('Pets imports in the background after account connection', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );

    // CI's browser and server are in different containers. Forward the mock's
    // loopback address to the server container before catalog loading starts.
    if (process.env.ATOMIC_SERVICE_URL)
      await page.route('http://127.0.0.1:19090/**', async route => {
        const target = new URL(route.request().url());
        target.hostname = new URL(process.env.ATOMIC_SERVICE_URL!).hostname;
        const response = await route.fetch({
          url: target.href,
          maxRedirects: 0,
        });
        await route.fulfill({ response });
      });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    const pets = page.locator('[data-integration="proxy:pets"]');
    await expect(
      pets.getByRole('heading', { name: 'Pets', exact: true }),
    ).toBeVisible();
    await pets.getByRole('button', { name: 'Set up connection' }).click();

    const setup = page.locator('dialog[open]');
    await expect(
      setup.getByRole('button', { name: 'Install and connect', exact: true }),
    ).toBeVisible();
    await setup
      .getByRole('button', { name: 'Install and connect', exact: true })
      .click();

    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Pets with your Atomic Data Hub',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=/);
    await page.getByRole('button', { name: 'Complete installation' }).click();
    await page.getByRole('link', { name: 'Open folder', exact: true }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toBeVisible({ timeout: 60000 });
    await page
      .locator('[data-test="folder-list"]')
      .getByRole('link', { name: 'Pets', exact: true })
      .click();
    const main = page.getByRole('main');
    await expect(
      main.getByRole('heading', { name: 'Pets', exact: true }),
    ).toBeVisible();
    for (const name of ['Rex', 'Whiskers', 'Tweety', 'Nibbles', 'Bubbles'])
      await expect(main.getByText(name, { exact: true }).first()).toBeVisible();
    // Numeric and boolean properties must retain their Atomic datatype, not become JSON blobs.
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
      age: 'https://atomicdata.dev/datatypes/integer',
      vaccinated: 'https://atomicdata.dev/datatypes/boolean',
      weight: 'https://atomicdata.dev/datatypes/float',
      'updated at': 'https://atomicdata.dev/datatypes/timestamp',
    });
  });
});
