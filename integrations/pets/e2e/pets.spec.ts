// @wc-ignore-file
/**
 * Split out of atomic-server's `browser/e2e/tests/plugins.spec.ts` (deleted there by
 * atomic-server#1621) so this repo's `pets` CI lane can be gated on
 * `integrations/pets/**` alone — see `integrations/PARALLEL_LANES.md`.
 * The tests left behind there drive the generic plugin editor and sandbox
 * rather than any one integration, and stay upstream — the `e2e-plugin-system`
 * CI job runs them.
 *
 * Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs pets --tier e2e
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
    // Failed all three attempts on develop run 4326, reported as the 60s test
    // timeout and naming the `Last synced` wait below. That name is an
    // artefact: the wall prints whichever assertion was in flight, and the
    // longest ceiling in a test is the most likely one to be holding it. The
    // step is not slow. Timed under four-worker load, three copies:
    //
    //   step                            budget   run A    run B    run C
    //   integrations link through connect    -    5.7s     5.9s     4.9s
    //   complete install, open folder        -    4.5s     5.1s     5.6s
    //   `Last synced`                      60s    8.2s     7.1s     7.2s
    //   open the Pets table            default    0.9s     0.6s     0.5s
    //   rows and datatypes             default    2.5s     1.7s     0.5s
    //   ------------------------------------- sum 21.9s   20.5s    18.8s
    //   whole test                         60s   43.6s    38.6s    36.6s
    //
    // `Last synced` never passes 8.2s, and 18 to 22 seconds of each run are
    // spent in `beforeEach` before the first step here begins. So the test is
    // marginal as a whole, at 73% of its wall on the worst sample, and the
    // wall lands wherever it happens to land.
    //
    // 120s for the test, matching the rest of this file. And `Last synced`
    // comes DOWN to 30s: a ceiling equal to the wall can never fire, so it
    // could only ever be reported as a wall casualty. At 30s against an 8.2s
    // worst sample it can finally fail on its own terms and name itself.
    test.setTimeout(120_000);
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
    ).toBeVisible({ timeout: 30000 });
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
    // Column names come from localthought/schema.ts's displayName
    // (`updated_at` -> `Updated at`), capitalized since atomic-server 5dc880bf1.
    expect(datatypes).toMatchObject({
      Age: 'https://atomicdata.dev/datatypes/integer',
      Vaccinated: 'https://atomicdata.dev/datatypes/boolean',
      Weight: 'https://atomicdata.dev/datatypes/float',
      'Updated at': 'https://atomicdata.dev/datatypes/timestamp',
    });
  });
});
