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
    await publishBundle(page);

    // User: discover it and create a draft from the release.
    await page
      .getByRole('checkbox', { name: 'Show experimental plugins' })
      .check();
    const card = page.locator('[data-release]').filter({
      has: page.getByRole('heading', { name: 'Bank statements', exact: true }),
    });
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
    await expect(
      dialog.getByRole('button', { name: 'Apply 2 changes' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(dialog.getByText(/1 statements reconciled/)).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply 2 changes' }).click();
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

    // camt.053 of the same period: identities are per format, so two new rows.
    await choose(page, 'statement.xml', camt);
    await preview(page);
    await expect(
      dialog.getByRole('button', { name: 'Apply 2 changes' }),
    ).toBeVisible({ timeout: 60_000 });
    await dialog.getByRole('button', { name: 'Apply 2 changes' }).click();
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
});

async function publishBundle(page: Page) {
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
  await expect(
    page.getByRole('heading', { name: 'Integrations', exact: true }),
  ).toBeVisible();
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
