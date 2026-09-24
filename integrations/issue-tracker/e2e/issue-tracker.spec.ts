// @wc-ignore-file
/**
 * The GitHub issues drive app (`../app/`) end to end, against the mock
 * integration proxy's github-issues fixture and its seeded repository
 * (`../fixtures/github-issues/scenario.mjs`, `atomic-fixture/tracker`: two
 * issues, one comment):
 *
 * 1. Install test-side (as the pets and notion specs do; there is no catalog
 *    install flow for drive apps yet), connect through the host's consent
 *    bar, choose the repository, import.
 * 2. Reload: the app resumes from the state it saved in the drive, and an
 *    unchanged refresh writes nothing on either side.
 * 3. A reviewed update: a status change made in the table outside the app
 *    waits for review, and only "Send" closes the issue on GitHub.
 * 4. Conflict recovery: the same title edited in the table and on GitHub
 *    pauses sync; "Keep GitHub's version" settles it.
 *
 * GitHub-side reads and edits go straight to the mock proxy with the
 * connection this browser holds (the host page's localStorage, under its
 * Web Lock), standing in for someone working on GitHub. The app never sees
 * that code.
 *
 * Needs an atomic-server with the host relay (atomic-server#1657, in the
 * pin). Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs issue-tracker --tier e2e
 */
import { test, expect, type Page, type FrameLocator } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from '../app/build.mjs';

const APP_FRAME = 'iframe[title="App"]';
const REPOSITORY = 'atomic-fixture/tracker';
const NAME = 'https://atomicdata.dev/properties/name';

test.describe('GitHub issues drive app', () => {
  test.beforeEach(before);

  test('imports, refreshes, sends a reviewed update and recovers from a conflict', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    const { text } = (await build()) as { text: string };

    await createFromCatalog(page, 'App');
    await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
      timeout: 45_000,
    });
    await setAppSource(page, text);
    await page.reload();

    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    await expect(
      app.getByRole('heading', { name: 'GitHub issues' }),
    ).toBeVisible();
    await expect(status).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect GitHub' }).click();

    // Drawn by the host page, outside the frame: only a click here navigates.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    // The host names the platform from its id: "Github Issues".
    await expect(consent).toContainText(/github issues/i);
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    await page
      .getByRole('button', {
        name: 'Use LocalThought to sync GitHub Issues with your Atomic Data Hub',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // 1. Choose the repository and import.
    await expect(status).toContainText('Choose the repository', {
      timeout: 30_000,
    });
    await app.getByLabel('Repository (owner/name)').fill(REPOSITORY);
    await app.getByRole('button', { name: 'Use this repository' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '2 issues and 1 comment in sync with atomic-fixture/tracker',
      { timeout: 60_000 },
    );
    const issues = app.getByRole('list', { name: 'Issues' });
    await expect(issues.getByRole('listitem')).toHaveCount(2);
    await expect(issues).toContainText(
      '#1 Keep the selected calendar after refresh · Todo',
    );
    await expect(issues).toContainText('#2 Export the board as CSV · Doing');

    // 2. Reload: resumes from the saved state; an unchanged refresh writes nothing.
    await page.reload();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 added and 0 updated here, 0 sent to GitHub',
      { timeout: 60_000 },
    );
    await expect(status).toContainText('2 issues and 1 comment');

    // 3. A reviewed update: close #1 from the table, outside the app.
    const first = await subjectOf(app, '#1 ');
    await setStatus(page, first, 'done');
    await app.getByRole('button', { name: 'Sync now' }).click();
    const review = app.getByRole('region', {
      name: 'Changes to send to GitHub',
    });
    await expect(review).toContainText(
      'Update #1: status Todo → Done (close it)',
      { timeout: 30_000 },
    );
    expect((await github(page, 'GET', '/issues/1')).state).toBe('open');
    await review
      .getByRole('button', { name: 'Send 1 change to GitHub' })
      .click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '1 sent to GitHub',
      { timeout: 30_000 },
    );
    expect((await github(page, 'GET', '/issues/1')).state).toBe('closed');
    await expect(review).toBeHidden();

    // 4. Conflict: #2's title edited on both sides since the last sync.
    const second = await subjectOf(app, '#2 ');
    await setName(page, second, 'Export as CSV (edited here)');
    await github(page, 'PATCH', '/issues/2', {
      title: 'Export as CSV (edited on GitHub)',
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status).toContainText(
      'title changed both here and on GitHub',
      { timeout: 30_000 },
    );
    await app.getByRole('button', { name: 'Keep GitHub’s version' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 sent to GitHub',
      { timeout: 30_000 },
    );
    await expect(issues).toContainText('#2 Export as CSV (edited on GitHub)');
    expect((await github(page, 'GET', '/issues/2')).title).toBe(
      'Export as CSV (edited on GitHub)',
    );

    // The frame never saw the rotating code; the page holds it, the drive does not.
    const stored = await page.evaluate(() =>
      Object.keys(localStorage).filter(k =>
        k.startsWith('atomic-proxy-connection-v1:'),
      ),
    );
    expect(stored).toHaveLength(1);
  });
});

async function subjectOf(app: FrameLocator, prefix: string): Promise<string> {
  const subject = await app
    .getByRole('list', { name: 'Issues' })
    .getByRole('listitem')
    .filter({ hasText: prefix })
    .getAttribute('data-subject');
  if (!subject) throw new Error(`No row for ${prefix}`);

  return subject;
}

/** A person renaming a row in the table: the host page's own store. */
async function setName(page: Page, subject: string, name: string) {
  await page.evaluate(
    async ({ row: target, title, property }) => {
      const row = await window.store!.getResource(target);
      await row.set(property, title);
      await row.save();
    },
    { row: subject, title: name, property: NAME },
  );
}

/** A person changing a row's Status select to the tag with this shortname. */
async function setStatus(page: Page, subject: string, shortname: string) {
  await page.evaluate(
    async ({ target, wanted }) => {
      const A = 'https://atomicdata.dev/properties';
      const store = window.store!;
      const row = await store.getResource(target);
      const klass = await store.getResource(
        (row.get(`${A}/isA`) as string[])[0],
      );

      for (const property of klass.get(`${A}/recommends`) as string[]) {
        const p = await store.getResource(property);
        if (p.get(`${A}/shortname`) !== 'issue-status') continue;

        for (const tag of p.get(`${A}/allowsOnly`) as string[]) {
          const t = await store.getResource(tag);
          if (t.get(`${A}/shortname`) !== wanted) continue;
          await row.set(property, [tag]);
          await row.save();

          return;
        }
      }

      throw new Error(`No ${wanted} status`);
    },
    { target: subject, wanted: shortname },
  );
}

/**
 * One GitHub call straight to the mock proxy, spending and rotating the
 * connection code the host page holds, under the same Web Lock the host's
 * relay takes. Stands in for someone working on GitHub directly.
 */
async function github(
  page: Page,
  method: 'GET' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  return page.evaluate(
    async ({ verb, route, payload, repository }) => {
      const key = Object.keys(localStorage).find(k => {
        if (!k.startsWith('atomic-proxy-connection-v1:')) return false;
        const c = JSON.parse(localStorage.getItem(k)!);

        return c.ready && c.platform === 'github-issues';
      });
      if (!key) throw new Error('No github-issues connection in this page');

      return navigator.locks.request(key, async () => {
        const c = JSON.parse(localStorage.getItem(key)!);
        const response = await fetch(
          `${c.origin}/proxy/github-issues/repos/${repository}${route}`,
          {
            method: verb,
            headers: {
              Authorization: `Bearer ${c.code}`,
              ...(payload ? { 'Content-Type': 'application/json' } : {}),
            },
            ...(payload ? { body: JSON.stringify(payload) } : {}),
          },
        );
        const next = response.headers.get('x-connection-code');
        if (!next) throw new Error('The mock proxy did not rotate the code');
        localStorage.setItem(key, JSON.stringify({ ...c, code: next }));

        return response.json();
      });
    },
    { verb: method, route: path, payload: body, repository: REPOSITORY },
  );
}

/**
 * Replaces the source of the app on screen, through `window.store`. Copied
 * from atomic-server's `browser/e2e/tests/apps.spec.ts` (not exported there),
 * as the pets and notion specs do.
 */
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
