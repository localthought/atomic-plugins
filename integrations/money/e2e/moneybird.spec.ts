// @wc-ignore-file
/**
 * The Moneybird drive app (`integrations/money/moneybird/`, read-only
 * contacts, atomic-plugins#102), end to end against the mock integration
 * proxy serving the SYNTHETIC Moneybird fixture
 * (`integrations/money/fixtures/moneybird/`, not a recording).
 *
 * The app is installed test-side, the way the Pets spec does it: `New app`
 * from the catalog, then its entry point's source is replaced with
 * `moneybird/build.mjs`'s bundle. There is no catalog install flow for drive
 * apps yet (#94).
 *
 * Journey: connect through the host's consent bar and the mock proxy, choose
 * an administration, import typed rows, reload (the fixture fails that
 * refresh on purpose: every second read of an administration fails on page
 * 2), see the error and the rows still there, then sync again.
 *
 *   node integrations/tooling/run-lane.mjs money --tier e2e
 */
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from '../moneybird/build.mjs';

test.describe('moneybird integration', () => {
  test.beforeEach(before);

  test('Moneybird: connect, choose an administration, import contacts, survive a failed refresh', async ({
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
    await expect(app.getByRole('heading', { name: 'Moneybird' })).toBeVisible();
    await expect(app.getByRole('status')).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Moneybird' }).click();

    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Moneybird');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync Moneybird with your Atomic Data Hub',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // Administration selection.
    await expect(app.getByRole('status')).toContainText(
      'Choose the Moneybird administration',
      { timeout: 30_000 },
    );
    await app
      .getByLabel('Administration')
      .selectOption({ label: 'Synthetic Studio B.V.' });
    await app.getByRole('button', { name: 'Import contacts' }).click();
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 contacts (5 added', { timeout: 30_000 });

    // Reload: the stored administration is used again, and this second read
    // fails in the synthetic fixture. The error says the rows are kept.
    await page.reload();
    await expect(app.getByRole('status')).toContainText('Refresh failed', {
      timeout: 30_000,
    });
    await expect(app.getByRole('status')).toContainText('503');
    await expect(app.getByRole('status')).toContainText('kept');

    // The next refresh succeeds and finds all five rows still there: none
    // added again, none changed.
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(
      app.getByRole('status').filter({ hasText: 'Last synced' }),
    ).toContainText('5 contacts (0 added, 0 updated, 5 unchanged)', {
      timeout: 30_000,
    });

    // Typed rows: an ordinary table outside the app.
    const table = await tableOf(page);
    await page.goto(
      `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
    );
    for (const name of [
      'Fictief Bakkerij B.V.',
      'Anna Voorbeeld',
      'Bram Proef',
    ])
      await expect(main.getByText(name, { exact: true }).first()).toBeVisible();
    const datatypes = await page.evaluate(async subject => {
      const store = window.store!;
      const t = await store.getResource(subject);
      const klass = await store.getResource(
        t.get('https://atomicdata.dev/properties/classtype') as string,
      );
      const fields = klass.get(
        'https://atomicdata.dev/properties/recommends',
      ) as string[];
      const properties = await Promise.all(
        fields.map(s => store.getResource(s)),
      );

      return Object.fromEntries(
        properties.map(p => [
          p.get('https://atomicdata.dev/properties/shortname'),
          p.get('https://atomicdata.dev/properties/datatype'),
        ]),
      );
    }, table);
    expect(datatypes).toMatchObject({
      'moneybird-archived': 'https://atomicdata.dev/datatypes/boolean',
      'moneybird-version': 'https://atomicdata.dev/datatypes/integer',
      'moneybird-email': 'https://atomicdata.dev/datatypes/string',
    });
  });
});

/** The app's table: the value on the app that is a Table. */
async function tableOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.store!;
    const subject = new URL(location.href).searchParams.get('subject')!;
    const app = await store.getResource(subject);

    for (const candidate of Object.values(app.getPropVals()).filter(
      (v): v is string => typeof v === 'string' && v.includes(':'),
    )) {
      const child = await store.getResource(candidate).catch(() => undefined);
      const classes = child?.get('https://atomicdata.dev/properties/isA');
      if (
        Array.isArray(classes) &&
        classes.some(c => String(c).endsWith('/classes/Table'))
      )
        return candidate;
    }

    throw new Error('could not find the app’s table');
  });
}

/** Replaces the app's entry-point source; copied from `pets/e2e/pets.spec.ts`. */
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
