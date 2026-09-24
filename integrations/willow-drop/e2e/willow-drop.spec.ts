// @wc-ignore-file
/**
 * Willow drop importer (`integrations/willow-drop/`), end to end on the
 * generic host file entry point (atomic-server#1653), as money.spec.ts does
 * for bank statements. What this adds over the unit tests: the committed
 * bundle runs in the server's QuickJS sandbox (Ed25519 and WILLIAM3 in plain
 * JavaScript, BigInt), and a binary drop survives the host's text-only file
 * hand-over (the browser decodes it as UTF-8 or windows-1252, and upload.ts
 * undoes that).
 *
 * Publication is test-side, as for money (atomic-plugins#94). Run it the way
 * CI would:
 *   node integrations/tooling/run-lane.mjs willow-drop --tier e2e
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';

// Playwright loads this spec as CommonJS: this folder has no package.json
// (see ../README.md, Commands), so __dirname rather than import.meta.
const bundle = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');
const drop = (name: string) =>
  readFileSync(resolve(__dirname, `../fixtures/${name}.drop`));

test.describe('willow-drop integration', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('Willow drop: discover, set up, import binary and base64 drops, refuse unverifiable ones', async ({
    page,
  }) => {
    // Set up creates thirteen properties, a class, a table and a view, each
    // its own signed commit (see money.spec.ts).
    test.setTimeout(300_000);
    const main = page.getByRole('main');
    await publishBundle(page);

    await page
      .getByRole('checkbox', { name: 'Show experimental plugins' })
      .check();
    const card = page.locator('[data-release]').filter({
      has: page.getByRole('heading', { name: 'Willow drop', exact: true }),
    });
    await card.getByRole('button', { name: 'Open', exact: true }).click();
    await page
      .locator('dialog[open]')
      .getByRole('button', { name: 'Create draft', exact: true })
      .click();
    await expect(
      main.getByRole('heading', { name: 'Willow drop', level: 1 }),
    ).toBeVisible({ timeout: 45_000 });
    const importer = page.url();
    await main.getByRole('button', { name: 'Set up', exact: true }).click();
    const file = main.getByLabel('File to import');
    await expect(file).toBeVisible({ timeout: 120_000 });
    const dialog = page.locator('dialog[open]');

    // Refused in the sandbox, before anything is planned.
    const tampered = Buffer.from(drop('communal'));
    tampered.write('hellp.txt', tampered.indexOf('hello.txt'), 'latin1');

    for (const [name, buffer, message] of [
      ['delegated.drop', drop('delegated'), 'carries delegations'],
      ['tampered.drop', tampered, 'signature does not verify'],
    ] as const) {
      await file.setInputFiles({
        name,
        mimeType: 'application/octet-stream',
        buffer,
      });
      await preview(page);
      await expect(main.getByRole('alert')).toContainText(message, {
        timeout: 60_000,
      });
      await expect(dialog).toHaveCount(0);
    }

    // A raw binary drop: its non-UTF-8 payload makes the browser decode the
    // file as windows-1252, which the plugin undoes.
    await file.setInputFiles({
      name: 'communal.drop',
      mimeType: 'application/octet-stream',
      buffer: drop('communal'),
    });
    await preview(page);
    await expect(
      dialog.getByRole('button', { name: 'Apply 7 changes' }),
    ).toBeVisible({ timeout: 120_000 });
    await expect(
      dialog.getByText(
        /7 entries decoded and verified \(file read as windows-1252\)/,
      ),
    ).toBeVisible();
    await dialog.getByRole('button', { name: 'Apply 7 changes' }).click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    await page.reload();
    await main.getByRole('link', { name: 'Open workspace' }).click();
    await expect(
      main.getByText('Hello from Willow', { exact: false }).first(),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      main.getByText('Grüße ✓', { exact: true }).first(),
    ).toBeVisible();

    // The same drop again proposes nothing.
    await page.goto(importer);
    await file.setInputFiles({
      name: 'communal.drop',
      mimeType: 'application/octet-stream',
      buffer: drop('communal'),
    });
    await preview(page);
    await expect(
      dialog.getByText(/7 previously imported entries unchanged/),
    ).toBeVisible({ timeout: 60_000 });
    await expect(
      dialog.getByRole('button', { name: /^Apply \d+ changes?$/ }),
    ).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();

    // An owned-namespace drop, uploaded base64-encoded.
    await file.setInputFiles({
      name: 'owned.b64',
      mimeType: 'text/plain',
      buffer: Buffer.from(drop('owned').toString('base64')),
    });
    await preview(page);
    await expect(
      dialog.getByRole('button', { name: 'Apply 4 changes' }),
    ).toBeVisible({ timeout: 60_000 });
    await expect(dialog.getByText(/file read as base64/)).toBeVisible();
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
    await plugin.set('https://atomicdata.dev/properties/name', 'Willow drop');
    await plugin.set(
      'https://atomicdata.dev/properties/description',
      'Import entries from a Willow drop file after verifying them.',
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

async function preview(page: Page) {
  await page
    .getByRole('main')
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
}
