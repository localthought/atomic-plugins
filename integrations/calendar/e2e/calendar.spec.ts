// @wc-ignore-file
/**
 * The Calendar drive app (`../app/`) end to end, in its null-origin plugin
 * frame on the pinned atomic-server: connect Google Calendar through the
 * host's consent bar and the mock integration proxy, choose one calendar,
 * import it, refresh after a Google-side edit, then preview and send a local
 * edit — including an ETag conflict and a write whose response is lost.
 *
 * The frame calls the proxy itself (#54 phase 2): a capability from the page,
 * each request signed with the frame's own key, `If-Match` passed through.
 * The mock proxy checks every signature the way the real one does.
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
import AxeBuilder from '@axe-core/playwright';
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
    // The #89 design: the status pill carries the sync state in words, the
    // header's primary action is "Sync now" or "Review N changes", and the
    // review happens in a sheet (a dialog).
    const pill = app.locator('.pill');
    const syncNow = () =>
      app.getByRole('button', { name: 'Sync now', exact: true }).first();
    const sheet = app.getByRole('dialog');
    await expect(
      app.getByRole('heading', { name: 'Bring your calendar into Atomic' }),
    ).toBeVisible();
    await expect(
      app.getByRole('button', { name: 'Connect Google Calendar' }),
    ).toBeVisible();
    await connectThroughHost(page, app);

    // Calendar selection: both calendars listed, the primary preselected.
    const choose = app.getByRole('form', { name: 'Choose a calendar' });
    await expect(choose.getByRole('radio', { name: /Synthetic/ })).toBeChecked({
      timeout: 30_000,
    });
    const team = choose.getByRole('radio', { name: /Team/ });
    await expect(team).not.toBeChecked();
    await expect(
      choose.locator('li').filter({ hasText: 'Team' }).getByText('Read-only'),
    ).toBeVisible();
    await choose.getByRole('button', { name: 'Import this calendar' }).click();

    // Bounded, paged import: the all-day and the timed event; the weekly
    // series (master and instance) and the cancelled event are not imported.
    await expect(pill).toContainText('Synced', { timeout: 30_000 });
    await app.getByRole('button', { name: 'Agenda', exact: true }).click();
    await expect(app.locator('.agenda')).toContainText(
      '2 recurring events and 1 cancelled event aren’t imported yet.',
    );
    await expect(
      app.getByRole('button', { name: /^Calendar timed fixture, .*Room 4/ }),
    ).toBeVisible();
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

    // Sync after an edit made in Google.
    await driver('editRemote', ['timed', { location: 'Room 2' }]);
    await syncNow().click();
    await expect(
      app.getByRole('button', { name: /^Calendar timed fixture, .*Room 2/ }),
    ).toBeVisible();
    // The app writes as the app agent; the page's store sees it once the
    // commit comes back, so poll.
    await expect
      .poll(async () => (await rowsOf(page)).map(r => r.location).sort())
      .toEqual(['', 'Room 2']);

    // A local edit is previewed, not sent, until approved.
    await setRowTitle(page, 'Calendar timed fixture', 'Renamed here');
    await syncNow().click();
    await app.getByRole('button', { name: 'Review 1 change' }).click();
    await expect(sheet).toContainText('Send 1 change to Google Calendar');
    await expect(sheet).toContainText(
      /Title\s*Calendar timed fixture\s*→\s*becomes\s*Renamed here/,
    );
    expect((await driver('state', [])).writes).toEqual([]);
    const sendOne = sheet.getByRole('button', {
      name: 'Send 1 change to Google',
    });
    await sendOne.click();
    await expect(sheet).toContainText('1 of 1 change sent');
    await expect(sheet).toContainText('Calendar timed fixture: Sent');
    const afterSend = await driver('state', []);
    expect(afterSend.writes).toEqual([
      expect.objectContaining({
        id: 'timed',
        patch: { summary: 'Renamed here' },
        ifMatch: expect.stringMatching(/^"v\d+"$/),
      }),
    ]);
    await sheet.getByRole('button', { name: 'Done' }).click();

    // ETag conflict: Google changes the event between preview and send.
    await setRowTitle(page, 'Renamed here', 'Renamed twice');
    await syncNow().click();
    await app.getByRole('button', { name: 'Review 1 change' }).click();
    await expect(sheet).toContainText(
      /Renamed here\s*→\s*becomes\s*Renamed twice/,
    );
    await driver('editRemote', ['timed', { location: 'Room 9' }]);
    await sendOne.click();
    await expect(sheet).toContainText('0 of 1 change sent');
    await expect(sheet).toContainText('Changed in Google since this preview');
    expect((await driver('state', [])).writes).toHaveLength(1);

    // A lost response: the PATCH reaches the proxy, its answer never
    // reaches the frame. The app says it can't know.
    await sheet.getByRole('button', { name: 'Review again' }).click();
    await expect(sheet).toContainText(
      /Renamed here\s*→\s*becomes\s*Renamed twice/,
    );
    await page.route('**/proxy/*/google-calendar/**', async route => {
      if (route.request().method() !== 'PATCH') return route.continue();
      await route.fetch();
      await route.abort('connectionreset');
    });
    await sendOne.click();
    await expect(sheet).toContainText('Unknown whether Google applied it');
    await page.unroute('**/proxy/*/google-calendar/**');
    expect((await driver('state', [])).writes).toHaveLength(2);
    await sheet.getByRole('button', { name: 'Done' }).click();
    const banner = app.locator('.banner');
    await expect(banner).toContainText('may or may not have applied');

    // Nothing was spent (there are no connection codes any more): the same
    // connection syncs straight away. Google has the change, so the new
    // preview agrees: nothing to review, no conflict.
    await banner.getByRole('button', { name: 'Sync now' }).click();
    await expect(pill).toContainText('Synced', { timeout: 30_000 });
    await expect(banner).toHaveCount(0);
    await expect(app.getByRole('button', { name: /^Review \d/ })).toHaveCount(
      0,
    );
    expect((await driver('state', [])).writes).toHaveLength(2);

    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app; the page keeps nothing credential-like.
    const connections = await proxyConnections('google-calendar');
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

test.describe('calendar drive app: responsive and theme (#89 C13)', () => {
  // Wide enough that a 1200px frame is not clipped by the host page.
  test.use({ viewport: { width: 1680, height: 900 } });
  test.beforeEach(before);

  test('fits 360, 720 and 1200px frames in light and dark without horizontal scroll', async ({
    page,
  }, testInfo) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY ||
        !process.env.INTEGRATION_PROXY_URL,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    const { text } = (await build()) as { text: string };
    await page.emulateMedia({ colorScheme: 'light' });
    await createFromCatalog(page, 'App');
    await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
      timeout: 45_000,
    });
    await setAppSource(page, text);
    await page.reload();
    const app = page.frameLocator(APP_FRAME);
    await connectThroughHost(page, app);
    await app
      .getByRole('form', { name: 'Choose a calendar' })
      .getByRole('button', { name: 'Import this calendar' })
      .click();
    await expect(app.locator('.pill')).toContainText('Synced', {
      timeout: 30_000,
    });

    // The host re-sends its theme into the frame; the view follows it
    // without a reload (DESIGN.md §3).
    const root = app.locator('.pl-app');
    await root.evaluate(el => el.setAttribute('data-e2e-mark', 'kept'));
    const html = app.locator('html');
    await expect(html).toHaveAttribute('data-pl-theme', 'light');

    for (const scheme of ['light', 'dark'] as const) {
      await page.emulateMedia({ colorScheme: scheme });
      await expect(html).toHaveAttribute('data-pl-theme', scheme);
      await expect(root).toHaveAttribute('data-e2e-mark', 'kept');

      for (const width of [360, 720, 1200]) {
        await page.locator(APP_FRAME).evaluate((el, w) => {
          (el as HTMLElement).style.width = `${w}px`;
          (el as HTMLElement).style.maxWidth = 'none';
        }, width);
        await expect
          .poll(() =>
            root.evaluate(el => el.ownerDocument.documentElement.clientWidth),
          )
          .toBe(width);
        const overflow = await root.evaluate(el => {
          const doc = el.ownerDocument.documentElement;

          return doc.scrollWidth - doc.clientWidth;
        });
        expect(overflow, `${scheme} ${width}px scrolls sideways`).toBe(0);
        // Week below 720px only when chosen; Agenda is the default there.
        await expect(
          width < 720
            ? app.locator('.agenda, .wk')
            : app.locator('.wk, .agenda'),
        ).toBeVisible();
        const axe = await new AxeBuilder({ page }).include(APP_FRAME).analyze();
        expect(
          axe.violations.map(v => `${v.id}: ${v.nodes.length}`),
          `${scheme} ${width}px`,
        ).toEqual([]);
        await testInfo.attach(`calendar-${width}-${scheme}.png`, {
          body: await page.locator(APP_FRAME).screenshot(),
          contentType: 'image/png',
        });
      }
    }
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
      name: 'Use LocalThought to sync Google Calendar with this destination',
      exact: true,
    })
    .click();
  await expect(page).not.toHaveURL(/connection_code=|integration_state=/);
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
