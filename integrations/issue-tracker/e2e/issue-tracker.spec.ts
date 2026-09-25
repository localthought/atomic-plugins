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
 *    pauses sync; the conflict review keeps GitHub's title.
 * 5. Moving a card on the board with the keyboard, reviewed and sent.
 * 6. A comment added in the issue panel, reviewed and sent.
 *
 * GitHub-side reads and edits go through the mock's test drivers for the
 * github-issues fixture (`POST /fixture/github-issues/<driver>`), standing
 * in for someone working on GitHub. The connection itself lives at the
 * proxy (#54 phase 2): the page redeems and delegates it, and the frame
 * calls the proxy with a capability and its own key.
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

  test('imports, refreshes, sends reviewed updates, moves a card, comments and recovers from a conflict', async ({
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
        name: 'Use LocalThought to sync GitHub Issues with this destination',
        exact: true,
      })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // 1. Choose the repository from the picker (the mock answers
    // GET /user/repos) and import.
    await expect(
      app.getByRole('heading', { name: 'Which repository?' }),
    ).toBeVisible({ timeout: 30_000 });
    await app.getByRole('radio', { name: new RegExp(REPOSITORY) }).check();
    await app.getByRole('button', { name: `Import ${REPOSITORY}` }).click();
    const bar = app.locator('.pl-conn');
    await expect(bar).toHaveAttribute(
      'title',
      /2 issues and 1 comment in sync with atomic-fixture\/tracker/,
      { timeout: 60_000 },
    );
    await expect(status).toContainText('Synced');
    // The frame's width decides board or list; this spec uses the board.
    await app.getByRole('button', { name: 'Board', exact: true }).click();
    await expect(card(app, '#1')).toContainText(
      'Keep the selected calendar after refresh',
    );
    await expect(column(app, 'Todo').locator('[data-subject]')).toHaveCount(1);
    await expect(card(app, '#2')).toContainText('Export the board as CSV');
    await expect(column(app, 'Doing').locator('[data-subject]')).toHaveCount(1);

    // 2. Reload: resumes from the saved state; an unchanged refresh writes nothing.
    await page.reload();
    await expect(bar).toHaveAttribute(
      'title',
      /0 added and 0 updated here, 0 sent to GitHub/,
      { timeout: 60_000 },
    );
    await expect(bar).toHaveAttribute('title', /2 issues and 1 comment/);

    // 3. A reviewed update: close #1 from the table, outside the app.
    const first = await subjectOf(app, '#1');
    await setStatus(page, first, 'done');
    await app.getByRole('button', { name: 'Sync now' }).click();
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    const review = app.getByRole('region', {
      name: 'Changes to send to GitHub',
    });
    await expect(review).toContainText(
      'Update #1: status Todo → Done (close it)',
    );
    expect((await github('GET', '/issues/1')).state).toBe('open');
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    expect((await github('GET', '/issues/1')).state).toBe('closed');
    await expect(review).toBeHidden();

    // 4. Conflict: #2's title edited on both sides since the last sync.
    const second = await subjectOf(app, '#2');
    await setName(page, second, 'Export as CSV (edited here)');
    await github('PATCH', '/issues/2', {
      title: 'Export as CSV (edited on GitHub)',
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    const banner = app.locator('.pl-banner');
    await expect(banner).toContainText(
      '#2 was changed both here and on GitHub',
      { timeout: 30_000 },
    );
    await expect(status).toContainText('Sync paused');
    await banner.getByRole('button', { name: 'Review conflict' }).click();
    const apply = app.getByRole('button', { name: 'Apply and resume sync' });
    await expect(apply).toBeDisabled();
    await app
      .getByRole('group', { name: 'Title' })
      .getByRole('radio', { name: /On GitHub/ })
      .check();
    await apply.click();
    await expect(banner).toBeHidden({ timeout: 30_000 });
    await expect(bar).toHaveAttribute('title', /0 sent to GitHub/);
    await expect(card(app, '#2')).toContainText(
      'Export as CSV (edited on GitHub)',
    );
    expect((await github('GET', '/issues/2')).title).toBe(
      'Export as CSV (edited on GitHub)',
    );

    // 5. Move a card in the app: #2 to Done with the keyboard, then send.
    await card(app, '#2').focus();
    await page.keyboard.press('3');
    await expect(column(app, 'Done')).toContainText('Export as CSV');
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    await expect(review).toContainText(
      'Update #2: status Doing → Done (close it)',
    );
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    expect((await github('GET', '/issues/2')).state).toBe('closed');

    // 6. Comment on #1 from its detail panel, then send.
    await card(app, '#1').click();
    const detail = app.locator('aside.detail');
    await detail
      .getByRole('textbox', { name: 'Add a comment' })
      .fill('Fixed in the app.');
    await detail.getByRole('button', { name: 'Comment' }).click();
    await expect(detail).toContainText('Waiting to send');
    // Below 1000 px the panel is a modal drawer; close it first.
    await page.keyboard.press('Escape');
    await expect(detail).toBeHidden();
    await app
      .getByRole('button', { name: 'Review and send' })
      .click({ timeout: 30_000 });
    await expect(review).toContainText(
      'Add a comment on #1: “Fixed in the app.”',
    );
    await app.getByRole('button', { name: 'Send 1 change to GitHub' }).click();
    await expect(bar).toHaveAttribute('title', /1 sent to GitHub/, {
      timeout: 30_000,
    });
    const { comments } = (await fixture('snapshot', [REPOSITORY])) as {
      comments: { body: string; issue_url: string }[];
    };
    expect(
      comments.filter(c => c.issue_url.endsWith('/issues/1')).map(c => c.body),
    ).toEqual(['I can reproduce this in Firefox.', 'Fixed in the app.']);

    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app; the page keeps nothing credential-like.
    const connections = await proxyConnections('github-issues');
    expect(connections).toHaveLength(1);
    expect(connections[0].owner).toBe(await signedInAgent(page));
    expect(connections[0].delegations).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atomic-proxy-connect|connection-v1/),
      ]),
    );
  });
});

/** A card (board) or row (list) by its "#n" reference. */
function card(app: FrameLocator, ref: string) {
  return app.locator('[data-issue]').filter({
    has: app.locator('.ref', { hasText: new RegExp(`^${ref}$`) }),
  });
}

function column(app: FrameLocator, status: string) {
  return app.locator(`section[data-status="${status}"]`);
}

async function subjectOf(app: FrameLocator, ref: string): Promise<string> {
  const subject = await card(app, ref).getAttribute('data-issue');
  if (!subject) throw new Error(`No card for ${ref}`);

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
 * Someone working on GitHub directly: the github-issues fixture's test
 * drivers on the mock proxy (`snapshot`, `updateIssue`), not the app's
 * connection.
 */
async function github(
  method: 'GET' | 'PATCH',
  path: string,
  body?: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const number = Number(/^\/issues\/(\d+)$/.exec(path)?.[1]);
  if (!number) throw new Error(`Unsupported GitHub path ${path}`);

  if (method === 'PATCH')
    return (await fixture('updateIssue', [
      REPOSITORY,
      number,
      body ?? {},
    ])) as Record<string, unknown>;
  const { issues } = (await fixture('snapshot', [REPOSITORY])) as {
    issues: { number: number }[];
  };
  const issue = issues.find(i => i.number === number);
  if (!issue) throw new Error(`No issue #${number}`);

  return issue;
}

/** One github-issues fixture driver on the mock proxy. */
async function fixture(name: string, args: unknown[]): Promise<unknown> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/fixture/github-issues/${name}`,
    { method: 'POST', body: JSON.stringify(args) },
  );
  if (!response.ok) throw new Error(`${name}: HTTP ${response.status}`);

  return response.json();
}

interface MockConnection {
  connection_id: string;
  platform: string;
  owner: string;
  delegations: { agent: string; label: string | null }[];
}

/** The mock proxy's connections for `platform` (test-side introspection). */
async function proxyConnections(platform: string): Promise<MockConnection[]> {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/__mock/connections`,
  );
  const { connections } = (await response.json()) as {
    connections: MockConnection[];
  };

  return connections.filter(c => c.platform === platform);
}

/** The signed-in agent as the proxy names it: `atomic:agent:<base64url>`. */
async function signedInAgent(page: Page): Promise<string> {
  const key = await page.evaluate(() =>
    window.store!.getAgent()!.getPublicKey(),
  );

  return `atomic:agent:${Buffer.from(key, 'base64').toString('base64url')}`;
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
