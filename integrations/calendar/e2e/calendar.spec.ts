// @wc-ignore-file
/**
 * The Calendar drive app (`../app/`) end to end, in its null-origin plugin
 * frame on the pinned atomic-server: connect Google Calendar through the
 * host's consent bar and the mock integration proxy, choose one calendar,
 * import it through the host's proxy relay, refresh after a Google-side
 * edit, then preview and send a local edit — including an ETag conflict and
 * a write whose response is lost.
 *
 * The provider is the mock proxy's stateful google-calendar fixture
 * (`../fixtures/google-calendar/scenario.mjs`). Its Google-side edits are
 * made through the mock's test drivers (`POST /fixture/google-calendar/...`).
 * Nothing here talks to Google; see README.md for what is and isn't live
 * verified.
 *
 * Install is test-side, as in the pets and notion specs: there is no
 * catalog install flow for drive apps yet (#94).
 *
 *   node integrations/tooling/run-lane.mjs calendar --tier e2e
 */
import { test, expect, type FrameLocator, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build } from '../app/build.mjs';

const APP_FRAME = 'iframe[title="App"]';
const NAME = 'https://atomicdata.dev/properties/name';

test.describe('calendar drive app', () => {
  test.beforeEach(before);

  test('imports one Google calendar and sends reviewed edits with If-Match', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY ||
        !process.env.INTEGRATION_PROXY_URL,
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
    await expect(app.getByRole('heading', { name: 'Calendar' })).toBeVisible();
    await expect(status).toContainText('Not connected');
    await connectThroughHost(page, app);

    // Calendar selection: both calendars listed, the primary preselected.
    const choose = app.getByRole('form', { name: 'Choose a calendar' });
    await expect(choose.getByRole('radio', { name: /Synthetic/ })).toBeChecked({
      timeout: 30_000,
    });
    await expect(
      choose.getByRole('radio', { name: /Team \(read-only/ }),
    ).not.toBeChecked();
    await choose.getByRole('button', { name: 'Import this calendar' }).click();

    // Bounded, paged import: the all-day and the timed event; the weekly
    // series (master and instance) and the cancelled event are not imported.
    await expect(status).toContainText('2 events (2 added', {
      timeout: 30_000,
    });
    await expect(status).toContainText(
      'Not imported: 2 recurring, 1 cancelled.',
    );
    const imported = await rowsOf(page);
    expect(imported).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: 'Calendar all-day fixture',
          'all-day': true,
        }),
        expect.objectContaining({
          name: 'Calendar timed fixture',
          location: 'Room 4',
          'all-day': false,
        }),
      ]),
    );
    expect(imported).toHaveLength(2);
    const timed = imported.find(r => r.name === 'Calendar timed fixture')!;
    expect(timed.start).toMatch(/^\d{4}-\d{2}-\d{2}T09:30:00\+02:00$/);
    const allDay = imported.find(r => r.name === 'Calendar all-day fixture')!;
    expect(allDay.start).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(allDay.day).toBe(allDay.start);

    // Refresh after an edit made in Google.
    await driver('editRemote', ['timed', { location: 'Room 2' }]);
    await app.getByRole('button', { name: 'Refresh' }).click();
    await expect(status).toContainText('1 updated, 1 unchanged');
    // The app writes as the app agent; the page's store sees it once the
    // commit comes back, so poll.
    await expect
      .poll(async () => (await rowsOf(page)).map(r => r.location).sort())
      .toEqual(['', 'Room 2']);

    // A local edit is previewed, not sent, until approved.
    await setRowTitle(page, 'Calendar timed fixture', 'Renamed here');
    await app.getByRole('button', { name: 'Refresh' }).click();
    const review = app.getByRole('region', { name: 'Review changes' });
    await expect(review).toContainText(
      'Title: Calendar timed fixture → Renamed here',
    );
    expect((await driver('state', [])).writes).toEqual([]);
    const sendOne = review.getByRole('button', {
      name: 'Send 1 change to Google',
    });
    await sendOne.click();
    const sent = app.getByRole('region', { name: 'Sent changes' });
    await expect(sent).toContainText('Calendar timed fixture: Sent');
    const afterSend = await driver('state', []);
    expect(afterSend.writes).toEqual([
      expect.objectContaining({
        id: 'timed',
        patch: { summary: 'Renamed here' },
        ifMatch: expect.stringMatching(/^"v\d+"$/),
      }),
    ]);

    // ETag conflict: Google changes the event between preview and send.
    await setRowTitle(page, 'Renamed here', 'Renamed twice');
    await app.getByRole('button', { name: 'Refresh' }).click();
    await expect(review).toContainText('Renamed here → Renamed twice');
    await driver('editRemote', ['timed', { location: 'Room 9' }]);
    await sendOne.click();
    await expect(sent).toContainText('Changed in Google since this preview');
    expect((await driver('state', [])).writes).toHaveLength(1);

    // A lost response: the PATCH reaches the proxy, its answer never
    // reaches the page. The app says it can't know, and asks to reconnect.
    await app.getByRole('button', { name: 'Refresh' }).click();
    await expect(review).toContainText('Renamed here → Renamed twice');
    await page.route('**/proxy/google-calendar/**', async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch();
      await route.abort('connectionreset');
    });
    await sendOne.click();
    await expect(status).toContainText('may or may not have applied');
    await expect(sent).toContainText('Unknown whether Google applied it');
    await page.unroute('**/proxy/google-calendar/**');
    expect((await driver('state', [])).writes).toHaveLength(2);

    await app.getByRole('button', { name: 'Refresh' }).click();
    await expect(
      app.getByRole('button', { name: 'Connect Google Calendar' }),
    ).toBeVisible();
    await connectThroughHost(page, app);
    // Google has the change, so the new preview agrees: nothing to review.
    await expect(status).toContainText('Last refreshed', { timeout: 30_000 });
    await expect(status).not.toContainText('to review');
    await expect(status).not.toContainText('conflict');
    expect((await driver('state', [])).writes).toHaveLength(2);

    // The frame never held the rotating code; the page keeps it.
    const stored = await page.evaluate(() =>
      Object.keys(localStorage).filter(k =>
        k.startsWith('atomic-proxy-connection-v1:'),
      ),
    );
    expect(stored.length).toBeGreaterThanOrEqual(1);
  });
});

/** Connect, consent in the host's bar, then the mock proxy's page. */
async function connectThroughHost(page: Page, app: FrameLocator) {
  await app.getByRole('button', { name: 'Connect Google Calendar' }).click();
  // Drawn by the host page, outside the frame: only a click here navigates.
  const consent = page.getByRole('group', { name: 'Connect an account' });
  await expect(consent).toContainText('Google Calendar');
  await consent.getByRole('button', { name: 'Connect', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Mock integration proxy' }),
  ).toBeVisible();
  await page
    .getByRole('button', {
      name: 'Use LocalThought to sync Google Calendar with your Atomic Data Hub',
      exact: true,
    })
    .click();
  await expect(page).not.toHaveURL(/connection_code=|integration_state=/);
}

/** Calls a mock-proxy test driver of the google-calendar fixture. */
async function driver(name: string, args: unknown[]) {
  const response = await fetch(
    `${process.env.INTEGRATION_PROXY_URL}/fixture/google-calendar/${name}`,
    { method: 'POST', body: JSON.stringify(args) },
  );
  if (!response.ok) throw new Error(`driver ${name}: HTTP ${response.status}`);

  return response.json();
}

/** The app's table rows, keyed by property shortname, via window.store. */
async function rowsOf(page: Page): Promise<Record<string, unknown>[]> {
  const table = await tableOf(page);

  return page.evaluate(async (subject: string) => {
    const store = window.store!;
    const collection = await (
      await store.getResource(subject)
    ).getChildrenCollection(500);
    const out: Record<string, unknown>[] = [];

    for (const member of await collection.getAllMembers()) {
      // From the server, not the page's cache: what was actually committed.
      const row = await store.fetchResourceFromServer(member, {
        noWebSocket: true,
      });
      const named: Record<string, unknown> = {};

      for (const [property, value] of Object.entries(row.getPropVals())) {
        const shortname = (await store.getResource(property)).get(
          'https://atomicdata.dev/properties/shortname',
        );
        named[typeof shortname === 'string' ? shortname : property] = value;
      }

      out.push(named);
    }

    return out;
  }, table);
}

/** Edits a row's Name the way a table edit would: a commit by the user. */
async function setRowTitle(page: Page, from: string, to: string) {
  const table = await tableOf(page);
  await page.evaluate(
    async ([subject, oldTitle, newTitle, name]) => {
      const store = window.store!;
      const collection = await (
        await store.getResource(subject)
      ).getChildrenCollection(500);

      for (const member of await collection.getAllMembers()) {
        const row = await store.getResource(member);
        if (row.get(name) !== oldTitle) continue;
        await row.set(name, newTitle);
        await row.save();

        return;
      }

      throw new Error(`no row named ${oldTitle}`);
    },
    [table, from, to, NAME] as const,
  );
}

/** The app's table: the value on the app that is a Table (`app-data`). */
async function tableOf(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const store = window.store!;
    const subject = new URL(location.href).searchParams.get('subject')!;
    const app = await store.getResource(subject);
    const candidates = Object.values(app.getPropVals()).filter(
      (v): v is string => typeof v === 'string' && v.includes(':'),
    );

    for (const candidate of candidates) {
      const child = await store.getResource(candidate).catch(() => undefined);
      if (!child) continue;
      const classes = child.get('https://atomicdata.dev/properties/isA');

      if (
        Array.isArray(classes) &&
        classes.some(c => String(c).endsWith('/classes/Table'))
      )
        return candidate;
    }

    throw new Error('could not find the app’s table');
  });
}

/**
 * Replaces the source of the app on screen, through `window.store`. Copied
 * from atomic-server's `browser/e2e/tests/apps.spec.ts` (not exported there).
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
