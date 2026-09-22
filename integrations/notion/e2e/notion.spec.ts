// @wc-ignore-file
/**
 * Split out of atomic-server's `browser/e2e/tests/plugins.spec.ts` (deleted there by
 * atomic-server#1621) so this repo's `notion` CI lane can be gated on
 * `integrations/notion/**` alone — see `integrations/PARALLEL_LANES.md`.
 * The tests left behind there drive the generic plugin editor and sandbox
 * rather than any one integration, and stay upstream — the `e2e-plugin-system`
 * CI job runs them.
 *
 * Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs notion --tier e2e
 */
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { test, expect } from '@playwright/test';
import {
  before,
  getDevDriveSecret,
} from '../../../browser/e2e/tests/test-utils';
import { Agent } from '@tomic/lib';

test.describe('notion integration', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page, true);
  });

  test('Notion discovers databases through the proxy and reports revoked access without server OAuth', async ({
    page,
  }) => {
    // Two 45s waits below on the suite's 60s default, so neither could ever
    // fire: the wall always reported first and named itself instead of the
    // step. The test next door already says why, in its own words, and every
    // other test in this file carrying a 45s wait raises its budget. This was
    // the one that did not.
    //
    // Timed step by step under four-worker load, three copies:
    //
    //   step                       budget   run A    run B    run C
    //   setup through the alert         -    5.0s     4.2s     1.9s
    //   approve-enabled               45s   29.9s    33.4s     8.3s
    //   proxy-task visible       default     49ms     32ms      6ms
    //   sync-complete                 45s     4.3s    (wall)    1.0s
    //   whole test                    60s  (wall)   (wall)    34.0s
    //
    // The assertion budgets are not the problem: the worst `approve-enabled`
    // sample is 33.4s of its 45s. Run B is the one that settles it, reaching
    // the sync with 33s already spent and dying mid-step with its budget
    // untouched. Only the wall was ever failing this test.
    //
    // 45s stays on both waits deliberately. At a 120s wall it can fire for the
    // first time, so a future failure names the step that was slow rather than
    // reporting the wall; 33.4s against 45s keeps eleven seconds of headroom on
    // a box harsher than the shard.
    test.setTimeout(120_000);
    const actor = Agent.fromSecret(await getDevDriveSecret(page), 'js').subject;
    const drive = new URL(page.url()).searchParams.get('subject')!;
    const origin = 'https://notion-proxy.test';
    const connection = 'notion-fixture';
    const dataSource = '11111111-1111-4111-8111-111111111111';
    const notionPage = {
      object: 'page',
      id: '22222222-2222-4222-8222-222222222222',
      parent: { data_source_id: dataSource },
      properties: {
        Name: {
          id: 'title',
          type: 'title',
          title: [{ type: 'text', text: { content: 'Proxy task' } }],
        },
      },
    };
    await page.evaluate(
      ({
        actor: storedActor,
        drive: storedDrive,
        origin: storedOrigin,
        connection: storedConnection,
      }) => {
        localStorage.setItem('integration-proxy-url', storedOrigin);
        window.dispatchEvent(new Event('integration-proxy-change'));
        localStorage.setItem(
          `localthought-browser:${JSON.stringify([storedOrigin, storedDrive, storedActor, 'notion'])}`,
          JSON.stringify({
            actor: storedActor,
            drive: storedDrive,
            platform: 'notion',
            connection: storedConnection,
          }),
        );
        localStorage.setItem(
          `localthought-browser-v1:${storedConnection}`,
          JSON.stringify({
            actor: storedActor,
            drive: storedDrive,
            origin: storedOrigin,
            platform: 'notion',
            ready: true,
            expires: Date.now() + 600000,
            code: 'fixture-code',
          }),
        );
      },
      { actor, drive, origin, connection },
    );
    const forbidden: string[] = [];
    page.on('request', req => {
      if (
        req.url().includes('/integration-oauth/') ||
        req.url().includes('/plugin-secret')
      )
        forbidden.push(req.url());
    });
    await page.route(`${origin}/catalog`, route =>
      route.fulfill({
        json: ['notion'],
        headers: { 'Access-Control-Allow-Origin': '*' },
      }),
    );
    await page.route(`${origin}/proxy/notion/**`, async route => {
      const path = new URL(route.request().url()).pathname;
      if (route.request().method() === 'PATCH')
        notionPage.properties.Name.title = route
          .request()
          .postDataJSON().properties.title.title;
      await route.fulfill({
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Connection-Code',
          'X-Connection-Code': 'next-code',
        },
        json: path.endsWith('/query')
          ? { results: [notionPage], has_more: false, next_cursor: null }
          : path.includes('/pages/')
            ? notionPage
            : path.endsWith('/views')
              ? { results: [], has_more: false, next_cursor: null }
              : {
                  id: dataSource,
                  properties: {
                    Name: { id: 'title', name: 'Name', type: 'title' },
                  },
                },
      });
    });
    let revoked = false;
    await page.route(`${origin}/proxy/notion/v1/search`, async route => {
      expect(route.request().postDataJSON().query).toBe('Project');
      await route.fulfill({
        status: revoked ? 401 : 200,
        headers: {
          'X-Connection-Code': 'rotated-fixture-code',
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Expose-Headers': 'X-Connection-Code',
        },
        json: revoked
          ? { message: 'Unauthorized' }
          : {
              results: [
                {
                  object: 'data_source',
                  id: '11111111-1111-4111-8111-111111111111',
                  title: [{ plain_text: 'Project tasks' }],
                  icon: { emoji: '✅' },
                },
              ],
              has_more: false,
              next_cursor: null,
            },
      });
    });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await page
      .locator('[data-integration=notion]')
      .getByRole('button', { name: 'Set up connection' })
      .click();
    await page.getByLabel('Find a database', { exact: true }).fill('Project');
    await page
      .getByRole('button', { name: 'Find databases', exact: true })
      .click();
    await page
      .getByLabel('Database', { exact: true })
      .selectOption({ label: '✅ Project tasks' });
    await expect(
      page.getByRole('button', { name: 'Preview sync', exact: true }),
    ).toBeEnabled();
    revoked = true;
    await page
      .getByRole('button', { name: 'Find databases', exact: true })
      .click();
    await expect(page.locator('dialog[open]').getByRole('alert')).toContainText(
      'Notion',
    );
    revoked = false;
    await page
      .getByRole('button', { name: 'Preview sync', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Approve and sync', exact: true }),
    ).toBeEnabled({ timeout: 45000 });
    await expect(
      page
        .locator('dialog[open]')
        .getByText('Proxy task', { exact: true })
        .first(),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Approve and sync', exact: true })
      .click();
    await expect(page.getByText('Sync complete.', { exact: true })).toBeVisible(
      { timeout: 45000 },
    );
    const rowSubject = await page.evaluate(
      async ({ dataSource: installationDataSource, drive: queryDrive }) => {
        const key = Object.keys(localStorage).find(k =>
          k.includes('notion-proxy-installations-v1'),
        )!;
        const config = JSON.parse(localStorage.getItem(key)!)[
          installationDataSource
        ];
        const result = await window.store!.queryLocalDb({
          drive: queryDrive,
          property: 'https://atomicdata.dev/properties/parent',
          value: config.table,
        });
        // Not `subjects[0]`: a table also holds draft placeholder rows, which
        // carry the same parent and can come back first. Editing one of those
        // left the imported row untouched, the sync had nothing to push, and
        // Notion still read "Proxy task" — about half the time.
        const NAME = 'https://atomicdata.dev/properties/name';
        let row:
          | Awaited<ReturnType<typeof window.store.getLocalResource>>
          | undefined;

        for (const subject of result!.subjects) {
          const candidate = await window.store!.getLocalResource(subject);

          if (candidate.get(NAME) === 'Proxy task') {
            row = candidate;
            break;
          }
        }

        if (!row) throw new Error('imported Notion row not found in the table');

        await row.set(NAME, 'Edited locally');
        await row.save();

        return row.subject;
      },
      { dataSource, drive },
    );
    await page
      .getByRole('button', { name: 'Sync this table', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Approve and sync', exact: true })
      .click();
    await expect(
      page.getByText('Sync complete.', { exact: true }),
    ).toBeVisible();
    expect(notionPage.properties.Name.title[0].text.content).toBe(
      'Edited locally',
    );
    notionPage.properties.Name.title[0].text.content = 'Edited in Notion';
    await page
      .getByRole('button', { name: 'Sync this table', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Approve and sync', exact: true })
      .click();
    await expect(
      page.getByText('Sync complete.', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        async subject => (await window.store!.getLocalResource(subject)).title,
        rowSubject,
      ),
    ).toBe('Edited in Notion');
    expect(forbidden).toEqual([]);
  });
});
