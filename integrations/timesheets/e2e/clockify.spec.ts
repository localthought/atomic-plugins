// @wc-ignore-file
/**
 * The Clockify timesheets drive app (`integrations/timesheets/app/`), end to
 * end in a real host: the app runs in its null-origin iframe, connects
 * Clockify through the host's consent bar and the (mock) integration proxy,
 * is set up in the frame (workspace, account, 7/30-day look-back), and
 * imports through the integration proxy into its own table, with the
 * Properties it creates under its own ontology. Then: reload (no
 * duplicates), a changed entry, a wider window, and a proxy failure that
 * leaves the rows readable and recovers.
 *
 * The install is test-side, as in the Pets and Notion specs: `New app`, then
 * its entry point's source is replaced with `app/build.mjs`'s bundle. There
 * is no catalog install flow for drive apps yet (#94).
 *
 * Provider data changes and failures go through the mock proxy's local-only
 * fixture driver (`POST /__fixture/clockify`, see
 * `../fixtures/clockify/scenario.mjs`). Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs timesheets --tier e2e
 */
import { createRequire } from 'node:module';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect, type Page } from '@playwright/test';
import {
  before,
  createFromCatalog,
} from '../../../browser/e2e/tests/test-utils';
// @ts-expect-error build.mjs is plain JS with no declaration file.
import { build, cssRawPlugin } from '../app/build.mjs';

const APP_FRAME = 'iframe[title="App"]';
/** The fixture's workspace (`../fixtures/clockify/scenario.mjs`). */
const WORKSPACE_ID = 'aaaaaaaaaaaaaaaaaaaaaaaa';

/** Sends a command to the mock proxy's Clockify fixture. */
async function fixture(command: Record<string, unknown>) {
  const base = process.env.INTEGRATION_PROXY_URL;
  if (!base) throw new Error('INTEGRATION_PROXY_URL is not set');
  const response = await fetch(`${base}/__fixture/clockify`, {
    method: 'POST',
    body: JSON.stringify(command),
  });
  expect(response.status).toBe(200);

  return (await response.json()) as Record<string, unknown>;
}

/** `start` of every time-entries request the mock has seen, in order. */
async function windowStarts(): Promise<string[]> {
  const { requests } = (await fixture({ action: 'requests' })) as {
    requests: string[];
  };

  return requests
    .filter(r => r.includes('/time-entries?'))
    .map(r => new URL(r.slice(r.indexOf(' ') + 1), 'http://x'))
    .map(u => u.searchParams.get('start')!);
}

test.describe('timesheets drive app', () => {
  test.beforeEach(before);

  test('connects, sets up and imports Clockify entries through the host relay', async ({
    page,
  }) => {
    test.skip(
      !process.env.ATOMIC_MOCK_INTEGRATION_PROXY,
      'Run with the documented mock integration-proxy server configuration',
    );
    test.setTimeout(240_000);
    await fixture({ action: 'reset' });
    const { text } = (await build()) as { text: string };

    await createFromCatalog(page, 'App');
    await expect(page.getByRole('main').locator(APP_FRAME)).toBeVisible({
      timeout: 45_000,
    });
    await setAppSource(page, text);
    await page.reload();
    const appUrl = page.url();

    const app = page.frameLocator(APP_FRAME);
    const status = app.getByRole('status');
    await expect(
      app.getByRole('heading', { name: 'Clockify timesheets' }),
    ).toBeVisible();
    await expect(status).toContainText('Not connected');
    await app.getByRole('button', { name: 'Connect Clockify' }).click();

    // Drawn by the host page, outside the frame: only a click here navigates.
    const consent = page.getByRole('group', { name: 'Connect an account' });
    await expect(consent).toContainText('Clockify');
    await consent.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(
      page.getByRole('heading', { name: 'Mock integration proxy' }),
    ).toBeVisible();
    // An API-key platform: the key is pasted on the proxy's own page and
    // stays there, sealed in the connection; the drive never sees it.
    await page.getByLabel('API key').fill('synthetic-clockify-key');
    await page
      .getByRole('button', { name: 'Connect Clockify', exact: true })
      .click();
    await expect(page).not.toHaveURL(/connection_code=|integration_state=/);

    // Setup, in the frame: the account and its workspaces come through the proxy.
    await expect(status).toContainText('Choose the workspace', {
      timeout: 30_000,
    });
    // #89 frame G2: a radio per workspace (the key sees two), the window.
    await expect(app.getByText('Test Person', { exact: true })).toBeVisible();
    await app.getByRole('radio', { name: 'Test workspace' }).check();
    await app.getByRole('button', { name: 'Last 7 days' }).click();
    await app.getByRole('button', { name: 'Import entries' }).click();

    // Two completed entries; the running timer and the break are not rows.
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '2 created, 0 updated, 0 unchanged, last 7 days.',
      {
        timeout: 60_000,
      },
    );

    // #89 views, read from the observation log's mirror (not the rows).
    await expect(
      app.getByRole('table', { name: /^Hours per project/ }),
    ).toBeVisible();
    await expect(app.getByText('Clockify · Test workspace')).toBeVisible();
    await app.getByRole('tab', { name: 'Projects' }).click();
    await expect(
      app.getByRole('list', { name: 'Time per project' }),
    ).toContainText('Atomic plugins');
    // Both entries were yesterday: on a week's first day, that is last week.
    await app.getByRole('tab', { name: 'Entries' }).click();
    const weekly = app.getByRole('button', { name: /Weekly sync/ });
    if (!(await weekly.count()))
      await app.getByRole('button', { name: 'Previous week' }).click();
    await weekly.click();
    const detail = app.getByRole('dialog', { name: 'Weekly sync' });
    await expect(detail).toContainText('Atomic plugins');
    await expect(detail).toContainText('Test client');
    await page.keyboard.press('Escape');
    await expect(detail).toHaveCount(0);
    await expect(weekly).toBeFocused();
    await app.getByRole('tab', { name: 'Week' }).click();

    const table = await tableOf(page);

    // The drive holds settings, never the connection or the key.
    // The connection lives at the proxy, owned by the signed-in user and
    // delegated to this app; the page keeps nothing credential-like.
    const connections = await proxyConnections('clockify');
    expect(connections).toHaveLength(1);
    expect(connections[0].owner).toBe(await signedInAgent(page));
    expect(connections[0].delegations).toHaveLength(1);
    expect(await page.evaluate(() => Object.keys(localStorage))).not.toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^atomic-proxy-connect|connection-v1/),
      ]),
    );
    const appValues = await page.evaluate(async () => {
      const store = window.store!;
      const subject = new URL(location.href).searchParams.get('subject')!;

      return JSON.stringify((await store.getResource(subject)).getPropVals());
    });
    expect(appValues).toContain('aaaaaaaaaaaaaaaaaaaaaaaa');
    expect(appValues).not.toMatch(
      /connection[-_]?code|bearer|capabilit|synthetic-clockify-key/i,
    );

    // Columns are Properties the app created, with Atomic datatypes.
    expect(await columnDatatypes(page, table)).toMatchObject({
      Start: 'https://atomicdata.dev/datatypes/timestamp',
      End: 'https://atomicdata.dev/datatypes/timestamp',
      Billable: 'https://atomicdata.dev/datatypes/boolean',
      Project: 'https://atomicdata.dev/datatypes/string',
      'Clockify entry id': 'https://atomicdata.dev/datatypes/string',
    });

    // Reload: the app finds its connection and settings and syncs on open,
    // without creating duplicates.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 2 unchanged',
      { timeout: 60_000 },
    );

    // A changed entry in Clockify updates its row in place.
    await fixture({
      action: 'update',
      id: 'entry-1',
      patch: { description: 'Fix plugin source loading (renamed)' },
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 1 updated, 1 unchanged',
      { timeout: 60_000 },
    );

    // The window is recomputed on every run, so it moves with the clock.
    const starts = await windowStarts();
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect(Date.parse(starts.at(-1)!)).toBeGreaterThan(Date.parse(starts[0]));

    // Widening to 30 days brings in the older entry, and only that one.
    // #89 frame M: the settings sheet over the views.
    await app.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = app.getByRole('dialog', { name: 'Settings' });
    await expect(settings.getByLabel('Workspace')).toHaveValue(WORKSPACE_ID);
    await settings.getByRole('button', { name: 'Last 30 days' }).click();
    await settings.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '1 created, 0 updated, 2 unchanged, last 30 days.',
      {
        timeout: 60_000,
      },
    );

    // A proxy failure: the error is shown and nothing is written.
    await fixture({ action: 'fail', status: 503, count: 1 });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status).toContainText('Import failed: Clockify request', {
      timeout: 60_000,
    });
    await expect(status).toContainText('failed with 503');
    await expect(status).toContainText('Rows already in the table are kept.');
    // #89 frame J: a banner over the data already on screen.
    await expect(app.getByRole('alert')).toContainText('The last sync failed.');
    await expect(
      app.getByRole('table', { name: /^Hours per project/ }),
    ).toBeVisible();

    // The rows stay an ordinary, readable table outside the app: each entry
    // once, no running timer, no break.
    await expectRows(page, table);

    // Reopening the app recovers: it syncs on open, without duplicates.
    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '0 created, 0 updated, 3 unchanged',
      { timeout: 60_000 },
    );
    await expectRows(page, table);

    // #123 M2: a conflict and unknown time, as the #89 views show them
    // through `ui/coverage.ts`. Those views reach the bundle only once
    // `main.ts` renders them; until then the text below is tree-shaken
    // out and these steps are skipped with an annotation, not passed.
    if (!text.includes('Conflicts in Clockify')) {
      test.info().annotations.push({
        type: 'skipped-steps',
        description:
          '#123 M2 timeline assertions: the #89 views are not in the bundle yet',
      });

      return;
    }

    await page.goto(appUrl);
    await expect(status.filter({ hasText: 'Last synced' })).toBeVisible({
      timeout: 60_000,
    });
    // An entry without a project inside the running timer's span (project
    // "Atomic plugins"): unclear which project.
    const minute = 60_000;
    await fixture({
      action: 'add',
      entry: {
        id: 'entry-9',
        description: 'No project here',
        userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
        workspaceId: 'aaaaaaaaaaaaaaaaaaaaaaaa',
        billable: false,
        projectId: null,
        isLocked: false,
        type: 'REGULAR',
        timeInterval: {
          start: clockifyInstant(Date.now() - 40 * minute),
          end: clockifyInstant(Date.now() - 20 * minute),
        },
      },
    });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      '1 created,',
      { timeout: 60_000 },
    );
    await expect(
      app.getByRole('region', { name: 'Conflicts in Clockify' }),
    ).toContainText('Unclear which project: Atomic plugins · No project');

    // The running timer disappears from Clockify's list: a candidate, not
    // yet a deletion, so its span is not loaded (and no longer a conflict).
    await fixture({ action: 'delete', id: 'entry-4' });
    await app.getByRole('button', { name: 'Sync now' }).click();
    await expect(status.filter({ hasText: 'Last synced' })).toContainText(
      "1 missing from Clockify's list",
      { timeout: 60_000 },
    );
    await expect(
      app.getByRole('note', { name: 'Not loaded' }).first(),
    ).toContainText('Not loaded: ');
    await expect(
      app.getByRole('region', { name: 'Conflicts in Clockify' }),
    ).toHaveCount(0);
  });
});

/** Clockify's instant form: whole seconds, `Z`. */
const clockifyInstant = (at: number) =>
  new Date(at).toISOString().replace(/\.\d{3}Z$/, 'Z');

async function expectRows(page: Page, table: string) {
  await page.goto(
    `${new URL(page.url()).origin}/app/show?subject=${encodeURIComponent(table)}`,
  );
  const main = page.getByRole('main');

  for (const name of [
    'Fix plugin source loading (renamed)',
    'Weekly sync',
    'Plugin catalog evidence',
  ])
    await expect(main.getByText(name, { exact: true })).toHaveCount(1, {
      timeout: 30_000,
    });

  for (const skipped of ['Still running', 'Lunch'])
    await expect(main.getByText(skipped, { exact: true })).toHaveCount(0);
}

async function columnDatatypes(
  page: Page,
  table: string,
): Promise<Record<string, string>> {
  return page.evaluate(async (subject: string) => {
    const store = window.store!;
    const tableResource = await store.getResource(subject);
    const klass = await store.getResource(
      tableResource.get(
        'https://atomicdata.dev/properties/classtype',
      ) as string,
    );
    const fields = klass.get(
      'https://atomicdata.dev/properties/recommends',
    ) as string[];
    const properties = await Promise.all(fields.map(s => store.getResource(s)));

    return Object.fromEntries(
      properties.map(p => [
        p.get('https://atomicdata.dev/properties/name'),
        p.get('https://atomicdata.dev/properties/datatype'),
      ]),
    );
  }, table);
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
 * from atomic-server's `browser/e2e/tests/apps.spec.ts` (not exported there),
 * as the Pets and Notion specs do.
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

/**
 * The #89 views frame by frame (`app/ui/preview.ts`: the real views, the
 * mockup's sample data, a stub controller), at the mockups' widths, checked
 * with axe (WCAG 2.1 A/AA rules) and attached as screenshots. No server is
 * needed; it runs in this lane because the lane is where Playwright is.
 */
test.describe('timesheets views, frame by frame', () => {
  test('every design frame renders without axe violations', async ({
    browser,
  }, testInfo) => {
    const script = await previewScript();
    const { default: AxeBuilder } = await import('@axe-core/playwright');
    // Reduced motion: the drawer does not slide in, so axe measures its
    // final colours (and the reduced-motion styles get exercised).
    const context = await browser.newContext({
      timezoneId: 'Europe/Amsterdam',
      reducedMotion: 'reduce',
    });
    const page = await context.newPage();
    await page.setContent(
      '<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Timesheets frames</title></head><body></body></html>',
    );
    await page.addScriptTag({ content: script });
    const frames = await page.evaluate(() =>
      Object.entries(
        (window as unknown as { FRAMES: Record<string, { width: number }> })
          .FRAMES,
      ).map(([id, f]) => [id, f.width] as const),
    );
    expect(frames.length).toBeGreaterThanOrEqual(20);

    for (const [id, width] of frames) {
      await page.setViewportSize({ width, height: 720 });
      await page.evaluate(frame => {
        document.body.replaceChildren();
        const root = document.createElement('div');
        document.body.append(root);
        (
          window as unknown as {
            renderFrame: (root: HTMLElement, id: string) => void;
          }
        ).renderFrame(root, frame);
      }, id);
      await testInfo.attach(`frame-${id}.png`, {
        body: await page.screenshot({ fullPage: true }),
        contentType: 'image/png',
      });
      // Frame O uses a dark accent chosen for the harness; the host picks
      // the real one (DESIGN.md §8: accent contrast is not guaranteed).
      const axe = new AxeBuilder({ page }).withTags([
        'wcag2a',
        'wcag2aa',
        'wcag21a',
        'wcag21aa',
      ]);
      if (id === 'o') axe.disableRules(['color-contrast']);
      const { violations } = await axe.analyze();
      expect(violations.map(v => `${id}: ${v.id} (${v.nodes.length})`)).toEqual(
        [],
      );
    }

    await context.close();
  });
});

/** `app/ui/preview.ts` bundled for the page, with esbuild from `browser/`. */
async function previewScript(): Promise<string> {
  const require = createRequire(
    new URL('../../../browser/package.json', import.meta.url),
  );
  // esbuild's types are not resolvable from here; only `build` is used.
  const esbuild = require('esbuild') as {
    build(options: object): Promise<{ outputFiles: { text: string }[] }>;
  };
  const preview = fileURLToPath(
    new URL('../app/ui/preview.ts', import.meta.url),
  );
  const result = await esbuild.build({
    stdin: {
      contents: `import { renderFrame, FRAMES } from ${JSON.stringify(preview)};\nObject.assign(window, { renderFrame, FRAMES });`,
      resolveDir: dirname(preview),
      loader: 'ts',
    },
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'es2022',
    write: false,
    alias: {
      '@tomic/lib': fileURLToPath(
        new URL('../app/tomic-lib-shim.ts', import.meta.url),
      ),
    },
    plugins: [cssRawPlugin(esbuild)],
    logLevel: 'silent',
  });

  return result.outputFiles[0].text;
}
