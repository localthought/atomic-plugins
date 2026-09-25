// @wc-ignore-file
/** Real host importer path: bundle publication, QuickJS /plugin-run, user
 * approval and persisted Atomic reads after page reload. No mock host adapter.
 * This tests text atom imports, not remoteStorage bearer HTTP writes or blobs.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';

const bundle = readFileSync(resolve(__dirname, '../plugin.js'), 'utf8');
const NAME = 'https://atomicdata.dev/properties/name';
const PARENT = 'https://atomicdata.dev/properties/parent';
const DESCRIPTION = 'https://atomicdata.dev/properties/description';
const BASELINE = 'https://atomicdata.dev/properties/importBaseline';
const PATH = '/notes/remotestorage-e2e.txt';
const TITLE = 'remoteStorage text import';
const initial = 'Exact UTF-8: Grüße 🌿\r\nSecond line.\n';
const updated = 'Updated remote source: café 🌍\r\n';

interface RuntimeVerdict {
  intents: Array<{ op: string; localId?: string; subject?: string }>;
  problems: Array<{ severity: string; message: string }>;
}

test.describe('remoteStorage importer', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page);
  });

  test('real QuickJS import persists exact atoms, repeats idempotently and protects local edits', async ({
    page,
  }) => {
    test.setTimeout(300_000);
    const importer = await publishBundle(page);
    // The unchanged v3 release correctly requires the optional plugin-routes
    // feature for installation. Its original source draft can still exercise
    // the independent file importer through the real QuickJS /plugin-run API.
    await page.goto(importer);
    await expect(
      page.getByRole('main').getByRole('heading', { name: TITLE, level: 1 }),
    ).toBeVisible({ timeout: 45_000 });
    const parent = await configureParent(page);
    await page.reload();
    await expect(page.getByLabel('File to import')).toBeVisible({
      timeout: 45_000,
    });

    const first = await preview(page, initial);
    expect(first.problems).toEqual([]);
    expect(first.intents).toHaveLength(1);
    expect(first.intents[0].op).toBe('create');
    // Preview alone must not persist the proposed document.
    expect(await matchingRows(page, parent)).toEqual([]);
    await apply(page);
    await page.reload();
    const subject = await persistedRow(page, parent);
    await expectStored(page, subject, initial);

    const duplicate = await preview(page, initial);
    expect(duplicate.intents).toEqual([]);
    expect(duplicate.problems).toEqual([]);
    const dialog = page.locator('dialog[open]');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Apply / })).toHaveCount(
      0,
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    expect(await matchingRows(page, parent)).toEqual([subject]);

    const change = await preview(page, updated);
    expect(change.problems).toEqual([]);
    expect(change.intents).toEqual([
      expect.objectContaining({ op: 'set', subject }),
    ]);
    await expectStored(page, subject, initial);
    await apply(page);
    await page.reload();
    await expectStored(page, subject, updated);
    expect(await matchingRows(page, parent)).toEqual([subject]);

    // A real signed local edit must survive the next attempted source update.
    await page.evaluate(
      async ({ id, property }) => {
        const resource = await window.store!.getResource(id);
        await resource.set(property, 'Edited locally in Atomic');
        await resource.save();
      },
      { id: subject, property: DESCRIPTION },
    );
    await page.goto(importer);
    const refused = await preview(page, 'Conflicting remote change');
    expect(refused.intents).toEqual([]);
    expect(refused.problems).toEqual([
      expect.objectContaining({
        severity: 'error',
        message: expect.stringContaining('Local document edits'),
      }),
    ]);
    await expect(
      dialog.getByText(/Local document edits require review/),
    ).toBeVisible();
    await expect(dialog.getByRole('button', { name: /^Apply / })).toHaveCount(
      0,
    );
    await dialog.getByRole('button', { name: 'Close', exact: true }).click();
    await page.reload();
    const stored = await readAtoms(page, subject);
    expect(stored.description).toBe('Edited locally in Atomic');
    expect(stored.baseline).toEqual({
      protocol: 'remoteStorage-text-v1',
      path: PATH,
      text: updated,
      contentType: 'text/plain; charset=utf-8',
    });
    expect(await matchingRows(page, parent)).toEqual([subject]);
  });
});

async function publishBundle(page: Page): Promise<string> {
  await createFromCatalog(page, 'Plugin');
  await expect(
    page
      .getByRole('main')
      .getByRole('heading', { name: 'New plugin', level: 1 }),
  ).toBeVisible({ timeout: 45_000 });
  await page.evaluate(
    async ({ source, title }) => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;
      const plugin = await store.getResource(subject);
      const sourceProperty = Object.entries(plugin.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('export function run'),
      )?.[0];
      if (!sourceProperty) throw new Error('Plugin source property not found');
      await plugin.set(sourceProperty, source);
      await plugin.set('https://atomicdata.dev/properties/name', title);
      await plugin.save();
    },
    { source: bundle, title: TITLE },
  );
  const sourceDraft = page.url();
  await page.getByRole('tab', { name: 'Code', exact: true }).click();
  const published = page.waitForResponse(
    response =>
      response.url().endsWith('/plugin-release') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('button', { name: 'Publish to integration store' })
    .click();
  const response = await published;
  expect(response.ok(), await response.text()).toBe(true);
  await expect(
    page.getByRole('heading', { name: 'Integrations', exact: true }),
  ).toBeVisible();

  return sourceDraft;
}

async function configureParent(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.store!;
    const plugin = await store.getResource(
      new URL(location.href).searchParams.get('subject')!,
    );
    // Drive-local ontology subjects are resolved through their actual shortnames;
    // never guess a URL for plugin-schemas or write arbitrary fixture properties.
    let schemasProperty = '';

    for (const property of Object.keys(plugin.getPropVals())) {
      const definition = await store.getResource(property);
      if (
        definition.get('https://atomicdata.dev/properties/shortname') ===
        'plugin-schemas'
      )
        schemasProperty = property;
    }

    if (!schemasProperty) throw new Error('Source draft lacks plugin-schemas');
    const folder = await store.newResource({
      parent: plugin.subject,
      isA: 'https://atomicdata.dev/classes/Folder',
      propVals: {
        'https://atomicdata.dev/properties/name': 'remoteStorage E2E documents',
      },
    });
    await folder.save();
    await plugin.set(schemasProperty, {
      remotestorage: { table: folder.subject },
    });
    await plugin.save();

    return folder.subject;
  });
}

async function preview(page: Page, text: string): Promise<RuntimeVerdict> {
  await page.getByLabel('File to import').setInputFiles({
    name: 'remote-storage.json',
    mimeType: 'application/json',
    buffer: Buffer.from(
      JSON.stringify({
        documents: [
          { path: PATH, contentType: 'text/plain; charset=utf-8', text },
        ],
      }),
    ),
  });
  const responsePromise = page.waitForResponse(
    response =>
      response.url().endsWith('/plugin-run') &&
      response.request().method() === 'POST',
  );
  await page
    .getByRole('main')
    .getByRole('button', { name: 'Preview import', exact: true })
    .click();
  const response = await responsePromise;
  expect(response.ok(), await response.text()).toBe(true);
  const body = await response.json();
  expect(body.error).toBeNull();
  expect(typeof body.verdict).toBe('string');

  return JSON.parse(body.verdict);
}

async function apply(page: Page) {
  const dialog = page.locator('dialog[open]');
  await expect(
    dialog.getByRole('button', { name: 'Apply 1 changes', exact: true }),
  ).toBeVisible({ timeout: 60_000 });
  await dialog
    .getByRole('button', { name: 'Apply 1 changes', exact: true })
    .click();
  await expect(dialog).toBeHidden({ timeout: 30_000 });
}

async function matchingRows(
  page: Page,
  parentSubject: string,
): Promise<string[]> {
  return page.evaluate(
    async ({ parent, nameProperty, parentProperty }) => {
      const store = window.store!;
      const found = await store.search('remotestorage-e2e.txt', {
        parents: parent,
        serverOnly: true,
      });
      const rows: string[] = [];

      for (const subject of found) {
        await store.reloadResource(subject);
        const row = await store.getResource(subject);
        if (
          row.get(parentProperty) === parent &&
          row.get(nameProperty) === 'remotestorage-e2e.txt'
        )
          rows.push(subject);
      }

      return rows.sort();
    },
    { parent: parentSubject, nameProperty: NAME, parentProperty: PARENT },
  );
}

async function persistedRow(page: Page, parent: string): Promise<string> {
  let rows: string[] = [];
  await expect
    .poll(
      async () => {
        rows = await matchingRows(page, parent);

        return rows.length;
      },
      { timeout: 30_000 },
    )
    .toBe(1);

  return rows[0];
}

async function readAtoms(page: Page, resourceSubject: string) {
  return page.evaluate(
    async ({ subject, description, baseline }) => {
      await window.store!.reloadResource(subject);
      const row = await window.store!.getResource(subject);

      return { description: row.get(description), baseline: row.get(baseline) };
    },
    { subject: resourceSubject, description: DESCRIPTION, baseline: BASELINE },
  );
}

async function expectStored(page: Page, subject: string, text: string) {
  const stored = await readAtoms(page, subject);
  expect(stored.description).toBe(text);
  expect(stored.baseline).toEqual({
    protocol: 'remoteStorage-text-v1',
    path: PATH,
    text,
    contentType: 'text/plain; charset=utf-8',
  });
}
