// @wc-ignore-file
/**
 * Bank statements (`integrations/money/`), end to end on the generic host
 * file entry point (atomic-server#1653): the importer is discovered on the
 * Integrations page, set up, and fed synthetic MT940 and camt.053 files
 * through the host's file picker, preview and approval.
 *
 * Publication is test-side: a maintainer's step (publish `plugin.js` from a
 * draft to this server's integration store) that has no generic
 * catalog-to-store path yet (atomic-plugins#94). Everything after it is what
 * a person does: find "Bank statements" among the community plugins, create
 * a draft, set it up, import, reload, import again.
 *
 * A second test adds the Money drive app (`app/`) as a view of the same
 * table, imports through it with the host's review (atomic-server#1774),
 * reads the statements table (#1768) and saves a category after the
 * person allows editing in the host's bar (#1788).
 *
 * Needs an atomic-server with manifest `accepts`/`destination` and the
 * PluginPage Import tab (atomic-server#1691, for #1653; in the pinned
 * `.atomic-server-ref`); against a host without them, publishing fails on
 * the unknown manifest field. Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs money --tier e2e
 */
import { readFileSync } from 'node:fs';
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
  waitForSynced,
} from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';

const read = (name: string) =>
  readFileSync(new URL(`../${name}`, import.meta.url), 'utf8');
const bundle = read('plugin.js');
const mt940 = read('fixtures/synthetic.mt940');
const camt = read('fixtures/synthetic.camt053.xml');

test.describe('money integration', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('Bank statements: discover, set up, import, reimport and refuse bad files', async ({
    page,
  }) => {
    // Set up creates eleven properties, a class, a table and a view, each its
    // own signed commit; the removed mt940.spec.ts measured 25–35s for that
    // step under load.
    test.setTimeout(300_000);
    const main = page.getByRole('main');

    // Maintainer: publish the committed bundle to this server's store.
    const release = await publishBundle(page);

    // User: discover it and create a draft from the release.
    await page
      .getByRole('checkbox', { name: 'Show experimental plugins' })
      .check();
    const card = releaseCard(page, release);
    await expect(card.getByText('Unverified', { exact: true })).toBeVisible();
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Create draft', exact: true })
      .click();
    await expect(
      main.getByRole('heading', { name: 'Bank statements', level: 1 }),
    ).toBeVisible({ timeout: 45_000 });
    const importer = page.url();

    // A file importer has no Run button, schedule or trigger: only Import.
    await expect(
      page.getByRole('tab', { name: 'Import', exact: true }),
    ).toBeVisible();
    await expect(
      main.getByRole('button', { name: 'Run', exact: true }),
    ).toHaveCount(0);
    await main.getByRole('button', { name: 'Set up', exact: true }).click();
    const file = main.getByLabel('File to import');
    await expect(file).toBeVisible({ timeout: 120_000 });

    // Refused before anything is planned, let alone written.
    for (const [name, text, message] of [
      [
        'unbalanced.mt940',
        mt940.replace('107,66', '107,67'),
        'does not reconcile',
      ],
      ['notes.txt', 'Not a bank statement\n', 'MT940'],
      ['broken.xml', '<Document><Stmt></Document>', 'Malformed camt.053'],
      ['long.mt940', `:20:X\n${'x'.repeat(600_000)}\n`, 'smaller than 512 KB'],
      ['many.mt940', manyTransactions(501), 'at most 500 transactions'],
      ['huge.xml', 'x'.repeat(5_000_001), 'accepts at most'],
    ] as const) {
      await file.setInputFiles({
        name,
        mimeType: 'text/plain',
        buffer: Buffer.from(text),
      });
      await preview(page);
      await expect(main.getByRole('alert')).toContainText(message, {
        timeout: 60_000,
      });
      await expect(page.locator('dialog[open]')).toHaveCount(0);
    }

    // Nothing above was written: the first real import still proposes both.
    await choose(page, 'statement.mt940', mt940);
    await preview(page);
    const dialog = page.locator('dialog[open]');
    // Two transactions, and the statement they came from (#1768).
    await expect(
      dialog.getByRole('button', { name: 'Apply 3 changes' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(dialog.getByText(/1 statements reconciled/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply 3 changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    // Persisted: the rows are there after a full reload.
    await page.reload();
    await main.getByRole('link', { name: 'Open workspace' }).click();
    await expect(
      main.getByText('Fixture lunch', { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      main.getByText('-12.34', { exact: true }).first(),
    ).toBeVisible();

    // Edit one imported row locally.
    const lunch = await rowNamed(page, 'Fixture lunch');
    await page.goto(showUrl(page, lunch));
    const edited = await page.evaluate(async subject => {
      const store = window.store!;
      const row = await store.getResource(subject);
      const [property] = Object.entries(row.getPropVals()).find(
        ([key, value]) =>
          value === 'Fixture lunch' &&
          key !== 'https://atomicdata.dev/properties/name',
      )!;
      await row.set(property, 'Lunch with a client (edited here)');
      await row.save();

      return property;
    }, lunch);
    // The edit must be on the server before this page goes; see installApp.
    await waitForSynced(page);

    // Reimport: nothing new, and the local edit survives.
    await page.goto(importer);
    await choose(page, 'statement.mt940', mt940);
    await preview(page);
    await expect(
      dialog.getByText(/2 previously imported transactions skipped/),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      dialog.getByRole('button', { name: /^Apply \d+ changes?$/ }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await valueOf(page, lunch, edited)).toBe(
      'Lunch with a client (edited here)',
    );

    // The bank changing a transaction it already sent is a conflict, shown
    // and blocked, not an overwrite.
    await choose(
      page,
      'changed.mt940',
      mt940.replace('Fixture lunch', 'Fixture dinner'),
    );
    await preview(page);
    await expect(dialog.getByText('This import is paused')).toBeVisible({
      timeout: 60_000,
    });
    await expect(dialog.getByText(/Source value/).first()).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: /^Apply \d+ changes?$/ }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await valueOf(page, lunch, edited)).toBe(
      'Lunch with a client (edited here)',
    );

    // camt.053 of the same period: identities are per format, so two new
    // rows, and a statement row of its own.
    await choose(page, 'statement.xml', camt);
    await preview(page);
    await expect(
      dialog.getByRole('button', { name: 'Apply 3 changes' }),
    ).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Apply 3 changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await choose(page, 'statement.xml', camt);
    await preview(page);
    await expect(
      dialog.getByText(/2 previously imported transactions skipped/),
    ).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // An older MT940 export in Windows-1252: the host decodes it, so the
    // narrative arrives as "Café", not as a replacement character.
    const legacy = mt940
      .replace(/TEST-1/g, 'CP-1')
      .replace(/TEST-2/g, 'CP-2')
      .replace('Fixture lunch', 'Café lunch');
    await page
      .getByRole('main')
      .getByLabel('File to import')
      .setInputFiles({
        name: 'legacy.sta',
        mimeType: 'text/plain',
        buffer: Buffer.from(legacy, 'latin1'),
      });
    await preview(page);
    await expect(
      dialog.getByRole('button', { name: 'Apply 2 changes' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText('"Café lunch"').first()).toBeVisible();
  });

  test('Money app: a view of the Bank transactions table: import, statements, row editing, in-app check', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const main = page.getByRole('main');

    // The importer, published and set up; nothing imported yet.
    const release = await publishBundle(page);
    await page
      .getByRole('checkbox', { name: 'Show experimental plugins' })
      .check();
    await releaseCard(page, release)
      .getByRole('button', { name: 'Open', exact: true })
      .click();
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Create draft', exact: true })
      .click();
    await expect(
      main.getByRole('heading', { name: 'Bank statements', level: 1 }),
    ).toBeVisible({ timeout: 45_000 });
    await main.getByRole('button', { name: 'Set up', exact: true }).click();
    await expect(main.getByLabel('File to import')).toBeVisible({
      timeout: 120_000,
    });
    const sidebar = page.getByRole('navigation').last();
    await sidebar
      .getByRole('button', { name: 'Expand folder' })
      .first()
      .click();
    await sidebar
      .getByRole('button', { name: 'Bank transactions', exact: true })
      .click();
    await expect(
      main.getByRole('heading', { name: 'Bank transactions' }),
    ).toBeVisible({ timeout: 30_000 });
    const table = new URL(page.url()).searchParams.get('subject')!;
    const rowClass = await page.evaluate(
      async subject =>
        (await window.store!.getResource(subject)).get(
          'https://atomicdata.dev/properties/classtype',
        ) as string,
      table,
    );

    // A new App running the Money bundle, told it renders bank transactions
    // (test-side: no catalog entry installs it yet).
    await createFromCatalog(page, 'App');
    await expect(main.locator('iframe[title="App"]')).toBeVisible({
      timeout: 45_000,
    });
    const moneyApp = (
      (await import('../app/build.mjs' as string)) as {
        build(): Promise<{ text: string }>;
      }
    ).build;
    await installApp(page, (await moneyApp()).text, rowClass);

    // The person adds it as a view, read-only for now (#1788).
    await page.goto(showUrl(page, table));
    await main.getByRole('button', { name: 'Add view' }).click();
    await page.getByRole('menuitem', { name: 'New app' }).click();
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Read-only' })
      .click();
    const app = page.frameLocator('iframe[title="App"]');
    await expect(
      app.getByRole('heading', { name: 'Bring in your bank transactions' }),
    ).toBeVisible({ timeout: 45_000 });

    // Import from inside the app: check, preview, then the host's own
    // review (#1774). Nothing is written before Apply.
    const input = app.locator('input[type="file"]');
    await input.setInputFiles({
      name: 'statement.mt940',
      mimeType: 'text/plain',
      buffer: Buffer.from(mt940),
    });
    const sheet = app.getByRole('dialog', { name: 'Import statement' });
    await expect(sheet.getByRole('tab', { name: 'New 2' })).toBeVisible({
      timeout: 30_000,
    });
    await sheet.getByRole('tab', { name: /Already imported/ }).click();
    await expect(
      sheet.getByRole('tab', { name: /Already imported/ }),
    ).toHaveAttribute('aria-selected', 'true');
    await sheet.getByRole('tab', { name: /^New/ }).click();
    await sheet.getByRole('button', { name: 'Import 2 transactions' }).click();
    const ask = page.getByRole('group', { name: 'Import with this app' });
    await expect(ask).toContainText('statement.mt940');
    await ask.getByRole('button', { name: 'Preview import' }).click();
    const review = page.locator('dialog[open]');
    await review
      .getByRole('button', { name: 'Apply 3 changes' })
      .click({ timeout: 120_000 });
    await expect(review).toBeHidden({ timeout: 30_000 });
    await expect(sheet).toBeHidden({ timeout: 30_000 });
    await expect(app.getByRole('status').first()).toContainText('Imported 2', {
      timeout: 60_000,
    });
    const lunch = app.getByRole('button', { name: /Fixture lunch/ });
    await expect(lunch).toBeVisible();
    await expect(
      app.getByText('−€12.34', { exact: true }).first(),
    ).toBeVisible();

    // The statement row, with its balances: the strip and the Imports tab.
    await expect(app.getByRole('group', { name: /^Accounts/ })).toContainText(
      /€107\.66\s*on /,
      { timeout: 30_000 },
    );
    await app.getByRole('tab', { name: /^Imports/ }).click();
    await expect(app.getByRole('table')).toContainText(/€100\.00 →\s*€107\.66/);
    await app.getByRole('tab', { name: /^Transactions/ }).click();

    // Detail: the category is the person's. Saving asks, in the host's bar.
    await lunch.click();
    const details = app.getByLabel('Transaction details');
    await expect(details).toContainText('NL00 BUNQ 0000 0000 00 · EUR');
    await expect(details).toContainText('allow it to edit them');
    await details.getByLabel('Category').fill('Meals');
    await details.getByLabel('Category').press('Tab');
    const allow = page.getByRole('group', { name: 'Let this app edit rows' });
    await expect(details).toContainText('Waiting for you to allow editing');
    await expect(details.getByLabel('Category')).toHaveValue('Meals');
    await allow.getByRole('button', { name: 'Allow editing' }).click();
    await expect(details).toContainText('Saved', { timeout: 30_000 });
    await page.keyboard.press('Escape');

    // Stored on the row itself: after a reload the ledger shows it.
    await page.reload();
    await expect(
      app.getByRole('button', { name: /Fixture lunch/ }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(app.getByRole('table')).toContainText('Meals');

    // The in-app check agrees with the importer: nothing new in the same
    // file, and a changed transaction blocks the file.
    await input.setInputFiles({
      name: 'statement.mt940',
      mimeType: 'text/plain',
      buffer: Buffer.from(mt940),
    });
    await expect(sheet).toContainText(
      'Nothing new in this file. All 2 transactions were imported before.',
      { timeout: 30_000 },
    );
    await sheet.getByRole('button', { name: 'Close' }).first().click();
    await input.setInputFiles({
      name: 'changed.mt940',
      mimeType: 'text/plain',
      buffer: Buffer.from(mt940.replace('Fixture lunch', 'Fixture dinner')),
    });
    await expect(sheet).toContainText(
      'This file changes a transaction you already have',
      { timeout: 30_000 },
    );
  });
});

/**
 * Loads `source` into the App on screen and lets it render `rowClass`, as an
 * install from the catalog would. The entry point and `renders` are found by
 * value: their property subjects are minted per drive.
 */
async function installApp(page: Page, source: string, rowClass: string) {
  await page.evaluate(
    async args => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;
      const app = await store.getResource(subject);
      let loaded = false;

      for (const [property, value] of Object.entries(app.getPropVals())) {
        if (Array.isArray(value)) {
          // `renders`: the drive's own property listing the classes this app
          // can show (Atomic's own, like isA, are not it).
          if (property.startsWith('https://atomicdata.dev/')) continue;
          const first = await store
            .getResource(String(value[0]))
            .catch(() => undefined);
          const isA = first?.get('https://atomicdata.dev/properties/isA');
          if (
            Array.isArray(isA) &&
            isA.includes('https://atomicdata.dev/classes/Class')
          )
            await app.set(property, [...value, args.rowClass]);
          continue;
        }

        if (typeof value !== 'string' || !value.includes(':')) continue;
        const child = await store.getResource(value).catch(() => undefined);
        const sourceProp =
          child &&
          Object.entries(child.getPropVals()).find(
            ([, v]) =>
              typeof v === 'string' && v.includes('export async function view'),
          )?.[0];
        if (!child || !sourceProp) continue;
        await child.set(sourceProp, args.source);
        await child.save();
        loaded = true;
      }

      await app.set('https://atomicdata.dev/properties/name', 'New app');
      await app.save();
      if (!loaded) throw new Error('could not find the app’s entry point');
    },
    { source, rowClass },
  );
  // `save()` can resolve before the commit is acknowledged and mirrored to the
  // local database. Navigating away before then gives the next page an app
  // without the `renders` set here, and the table's "Add view" menu, which
  // reads the drive's apps once when it mounts, never lists it. CI showed
  // that: the app's commits arrived by sync push after the menu had opened.
  await waitForSynced(page);
}

async function publishBundle(page: Page): Promise<string> {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });
  await page.evaluate(async source => {
    const store = window.store!;
    const subject = new URL(location.href).searchParams.get('subject')!;
    const plugin = await store.getResource(subject);
    const sourceProp = Object.entries(plugin.getPropVals()).find(
      ([, value]) =>
        typeof value === 'string' && value.includes('export function run'),
    )?.[0];
    if (!sourceProp) throw new Error('plugin has no source property');
    await plugin.set(sourceProp, source);
    await plugin.set(
      'https://atomicdata.dev/properties/name',
      'Bank statements',
    );
    await plugin.set(
      'https://atomicdata.dev/properties/description',
      'Import bank transactions from MT940 and camt.053 statement exports.',
    );
    await plugin.save();
  }, bundle);
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  const publication = page.waitForResponse(
    response =>
      response.url().endsWith('/plugin-release') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Publish to integration store' })
    .click();
  const published = await publication;
  expect(published.ok(), await published.text()).toBe(true);
  const { id } = (await published.json()) as { id: string };
  await expect(
    page.getByRole('heading', { name: 'Integrations', exact: true }),
  ).toBeVisible();

  return id;
}

/**
 * The store card of the release just published. Matched by its
 * content-addressed id, not by name: a lane store kept from an earlier run
 * (or an earlier test in this one) lists more "Bank statements" cards, and
 * publishing the same bundle again lists the same release once more.
 */
function releaseCard(page: Page, id: string) {
  return page
    .locator(`[data-release="${id}"]`)
    .filter({
      has: page.getByRole('heading', { name: 'Bank statements', exact: true }),
    })
    .first();
}

async function choose(page: Page, name: string, text: string) {
  await page
    .getByRole('main')
    .getByLabel('File to import')
    .setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(text) });
}

async function preview(page: Page) {
  await page
    .getByRole('main')
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
}

/** A balanced MT940 statement with `count` one-euro credits. */
function manyTransactions(count: number): string {
  const lines = [':20:LIMIT', ':25:NL00BUNQ0000000000', ':28C:1/1'];
  lines.push(':60F:C260901EUR0,00');
  for (let i = 1; i <= count; i++)
    lines.push(`:61:2609020902C1,00NTRFNONREF//LIMIT-${i}`, `:86:Entry ${i}`);
  lines.push(`:62F:C260902EUR${count},00`);

  return `${lines.join('\n')}\n`;
}

function showUrl(page: Page, subject: string): string {
  return `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(subject)}`;
}

/** The imported row carrying `name`, from the table the workspace link opened. */
async function rowNamed(page: Page, name: string): Promise<string> {
  const table = new URL(page.url()).searchParams.get('subject')!;
  let found = '';
  // The search index can trail the commits by a moment.
  await expect
    .poll(
      async () => {
        found = await page.evaluate(
          async args => {
            const store = window.store!;

            for (const hit of await store.search(args.name, {
              parents: args.table,
            })) {
              const row = await store.getResource(hit);
              if (
                row.get('https://atomicdata.dev/properties/name') === args.name
              )
                return hit;
            }

            return '';
          },
          { table, name },
        );

        return found;
      },
      { timeout: 30_000 },
    )
    .not.toBe('');

  return found;
}

async function valueOf(
  page: Page,
  subject: string,
  property: string,
): Promise<unknown> {
  return page.evaluate(
    async args => {
      await window.store!.reloadResource(args.subject);

      return (await window.store!.getResource(args.subject)).get(args.property);
    },
    { subject, property },
  );
}
