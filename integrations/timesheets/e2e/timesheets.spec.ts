// @wc-ignore-file
/**
 * Split out of atomic-server's `browser/e2e/tests/plugins.spec.ts` (pinned
 * commit 4969872c) so this repo's `timesheets` CI lane can be gated on
 * `integrations/timesheets/**` alone — see `integrations/PARALLEL_LANES.md`.
 * The six tests left behind there drive the generic plugin editor and sandbox
 * rather than any one integration, and stay upstream.
 *
 * Run it the way CI does:
 *   node integrations/tooling/run-lane.mjs timesheets --tier e2e
 */
import { enableIntegrationDiscovery } from '../../../browser/e2e/tests/integration-settings-utils';
import { test, expect } from '@playwright/test';
import {
  before,
  createTableFromDialog,
} from '../../../browser/e2e/tests/test-utils';
import { dataBrowser } from '@tomic/lib';

test.describe('clockify timesheets integration', () => {
  test.beforeEach(before);
  test.beforeEach(async ({ page }) => {
    await enableIntegrationDiscovery(page, true);
  });

  test('Clockify discovers named workspaces and surfaces preview transport errors', async ({
    page,
  }) => {
    // Discovery and the failed preview each have a 45s assertion budget,
    // in addition to installing the connector and filling its setup form.
    test.setTimeout(120_000);
    await page.route('**/plugin-run', route => {
      const body = route.request().postDataJSON();
      if (JSON.parse(body.input).phase !== 'discover')
        return route.abort('failed');

      return route.fulfill({
        json: {
          error: null,
          verdict: JSON.stringify({
            intents: [],
            problems: [],
            discovery: {
              user: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Test Person' },
              workspaces: [
                { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Test workspace' },
              ],
            },
          }),
        },
      });
    });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await page
      .locator('[data-integration=clockify]')
      .getByRole('button', { name: 'Set up connection' })
      .click();
    await page.getByRole('button', { name: 'Find my workspaces' }).click();
    await expect(page.getByRole('alert')).toContainText(
      'Enter your Clockify API key',
    );
    await page
      .getByLabel('Clockify API key', { exact: true })
      .fill('synthetic-clockify-key');
    await page.getByRole('button', { name: 'Find my workspaces' }).click();
    // Discovery is a plugin run: the browser posts to the server, the server
    // starts a sandbox and the plugin's `discover` phase answers out of it.
    // That is a real round trip through a real sandbox, and on a loaded box it
    // does not fit the suite's 10s action budget — measured here, this spec
    // passes in 27s run on its own and times out on exactly this assertion
    // when the suite runs it beside another. Same shape as the wait `newApp`
    // documents in apps.spec.ts: the budget was never achievable, and the
    // assertion is about the workspace list, not about how fast it arrives.
    await expect(page.getByLabel('Workspace', { exact: true })).toContainText(
      'Test workspace',
      { timeout: 45000 },
    );
    await expect(page.getByLabel('Import my completed entries')).toHaveValue(
      '7',
    );
    await page
      .getByRole('button', { name: 'Preview import', exact: true })
      .click();
    // The aborted run has to reach the server and come back before the page
    // can say so; same load story as the discovery above it.
    await expect(page.getByText(/Could not run this plugin/)).toBeVisible({
      timeout: 45000,
    });
    await expect(
      page.getByRole('button', { name: 'Preview import', exact: true }),
    ).toBeEnabled();
  });

  test('Clockify applies linked entries through the real sandbox and skips repeats', async ({
    page,
  }) => {
    // Discovery plus an apply, both through the sandbox: a minute here, which
    // is the suite's whole per-test default.
    test.setTimeout(120_000);
    // Replace only the provider transport inside the sandbox. Discovery, mapping,
    // runtime, planning, signed commits and the second run's DB query stay real.
    await createTableFromDialog(page, {
      template: /Time tracker/i,
      name: 'Shared time entries',
    });
    const tableUrl = page.url();
    const tableSubject = new URL(tableUrl).searchParams.get('subject')!;
    const originalViews = await page.evaluate(
      async ({ subject, property }) =>
        (await window.store!.getResource(subject)).get(property),
      { subject: tableSubject, property: dataBrowser.properties.tableViews },
    );
    const startProperty = await page.evaluate(async subject => {
      const table = await window.store!.getResource(subject);
      const row = await window.store!.getResource(
        table.get('https://atomicdata.dev/properties/classtype') as string,
      );

      for (const field of row.get(
        'https://atomicdata.dev/properties/recommends',
      ) as string[]) {
        const property = await window.store!.getResource(field);

        if (
          property.get('https://atomicdata.dev/properties/shortname') ===
          'work-start'
        ) {
          await property.set(
            'https://atomicdata.dev/properties/name',
            'Started working',
          );
          await property.save();

          return field;
        }
      }

      throw new Error('Time Tracker start property missing');
    }, tableSubject);
    const now = Date.now();
    const fixture = {
      user: { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Fixture Person' },
      workspaces: [
        { id: 'aaaaaaaaaaaaaaaaaaaaaaaa', name: 'Fixture workspace' },
      ],
      projects: [{ id: 'cccccccccccccccccccccccc', name: 'Fixture Project' }],
      entries: [
        {
          id: 'dddddddddddddddddddddddd',
          userId: 'bbbbbbbbbbbbbbbbbbbbbbbb',
          projectId: 'cccccccccccccccccccccccc',
          description: 'Clockify fixture work',
          billable: true,
          timeInterval: {
            start: new Date(now - 7200000).toISOString(),
            end: new Date(now - 3600000).toISOString(),
          },
        },
      ],
    };
    let appSubject = '';
    let importDrive = '';
    await page.route('**/plugin-run', async route => {
      const body = route.request().postDataJSON();
      appSubject = body.plugin;
      importDrive = body.drive;
      expect(body.source).toContain('function run(ctx) {');
      body.source = body.source.replace(
        'function run(ctx) {',
        `function run(realCtx) { const ctx = { ...realCtx, http: r => {
          if (r.method !== 'GET') throw new Error('Fixture refuses provider writes');
          const fixtures = ${JSON.stringify(fixture)};
          if (!fixtures[r.operation]) throw new Error('Unknown fixture operation');
          return {status:200, body:JSON.stringify(fixtures[r.operation])};
        }};`,
      );
      // Re-issue from the browser, not from Node. `route.fetch` sends the
      // request from the Node test process, which implements RFC 6761 and
      // resolves `atomic.localhost` to its own container, where nothing
      // listens; run 4279 failed here with
      //
      //     route.fetch: connect ECONNREFUSED 127.0.0.1:9883
      //     → POST http://atomic.localhost:9883/plugin-run
      //
      // and the `Workspace` assertion below was the consequence, not the
      // cause. The three other `route.fetch` call sites in the suite all pass
      // an explicit node-reachable `url`; this one did not.
      //
      // Rewriting the url would work for them and not here, because this
      // request is signed. `signRequest` covers the subject and the timestamp
      // (lib/src/authentication.ts) and the server checks that against the
      // `Host` it was reached on, so moving the request to another host after
      // the browser signed it invalidates the proof. The body is not signed,
      // which is what makes `continue` with a replaced `postData` safe: the
      // browser sends it, to the same host, with its own headers intact, and
      // Chromium resolves the name because it is told the rule explicitly.
      await route.continue({ postData: JSON.stringify(body) });
    });
    await page.getByRole('link', { name: 'Integrations', exact: true }).click();
    await page
      .locator('[data-integration=clockify]')
      .getByRole('button', { name: 'Set up connection' })
      .click();
    await page
      .getByLabel('Clockify API key', { exact: true })
      .fill('synthetic-clockify-key');
    await page.getByRole('button', { name: 'Find my workspaces' }).click();
    // Discovery through the sandbox, as above.
    await expect(page.getByLabel('Workspace', { exact: true })).toContainText(
      'Fixture workspace',
      { timeout: 45000 },
    );
    await expect(page.getByLabel('Import into', { exact: true })).toContainText(
      'Shared time entries',
    );
    await page
      .getByLabel('Import into', { exact: true })
      .selectOption(tableSubject);
    await page
      .getByRole('button', { name: 'Preview import', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Apply 3 changes', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Apply 3 changes', exact: true })
      .click();
    await expect(
      page.getByText('Applied 3 changes', { exact: true }),
    ).toBeVisible();
    const children = await page.evaluate(async parent => {
      const url = new URL('/query', window.store!.getServerUrl());
      url.searchParams.set(
        'property',
        'https://atomicdata.dev/properties/parent',
      );
      url.searchParams.set('value', parent);
      url.searchParams.set('include_nested', 'false');
      const result = await window.store!.fetchResourceFromServer(
        url.toString(),
        { noWebSocket: true, forceOverride: true },
      );
      const members = result.get(
        'https://atomicdata.dev/properties/collection/members',
      ) as string[];

      return Promise.all(
        members.map(async subject => ({
          subject,
          name: (await window.store!.getResource(subject)).title,
        })),
      );
    }, appSubject);
    expect(children.map(child => child.name)).toEqual(
      expect.arrayContaining(['Fixture Project', 'Fixture Person']),
    );
    // Simulate a previously imported record at the old default location.
    const projectSubject = children.find(
      child => child.name === 'Fixture Project',
    )!.subject;
    await page.evaluate(
      async ({ subject, drive }) => {
        const project = await window.store!.getResource(subject);
        await project.set('https://atomicdata.dev/properties/parent', drive);
        await project.save();
      },
      { subject: projectSubject, drive: importDrive },
    );
    await page
      .getByRole('button', { name: 'Preview import', exact: true })
      .click();
    await expect(
      page.getByRole('button', { name: 'Apply 1 changes', exact: true }),
    ).toBeEnabled();
    await expect(
      page.getByText(
        /previously imported root records will move inside this app/,
      ),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Apply 1 changes', exact: true })
      .click();
    await expect(
      page.getByText('Applied 1 changes', { exact: true }),
    ).toBeVisible();
    expect(
      await page.evaluate(
        async subject =>
          (await window.store!.getResource(subject)).get(
            'https://atomicdata.dev/properties/parent',
          ),
        projectSubject,
      ),
    ).toBe(appSubject);
    await page
      .getByRole('button', { name: 'Preview import', exact: true })
      .click();
    await expect(
      page.getByText('This run proposes no changes.', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: /^Apply \d+ changes$/ }),
    ).toHaveCount(0);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.evaluate(async subject => {
      const resource = await window.store!.getResource(subject);
      await resource.set(
        'https://atomicdata.dev/properties/name',
        'My project name',
      );
      await resource.save();
    }, projectSubject);

    for (const choice of ['Keep my value', 'Use source value']) {
      fixture.projects[0].name =
        choice === 'Keep my value'
          ? 'Remote project name'
          : 'New remote project name';
      await page
        .getByRole('button', { name: 'Preview import', exact: true })
        .click();
      await expect(
        page.getByText('Your value: "My project name"', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: choice, exact: true }).click();
      await expect(
        page.getByText(
          'Resolution saved. Close this dialog and preview the import again.',
          { exact: true },
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
      await page
        .getByRole('button', { name: 'Preview import', exact: true })
        .click();
      await expect(
        page.getByText('This run proposes no changes.', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Close', exact: true }).click();
    }

    await expect(
      page.getByRole('button', { name: 'Manage import', exact: true }),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Open time entries', exact: true })
      .click();
    await expect(
      page.getByRole('heading', { name: 'Shared time entries', exact: true }),
    ).toBeVisible();
    const afterViews = await page.evaluate(
      async ({ subject, property }) =>
        (await window.store!.getResource(subject)).get(property),
      { subject: tableSubject, property: dataBrowser.properties.tableViews },
    );
    expect(
      await page.evaluate(
        async subject =>
          (await window.store!.getResource(subject)).get(
            'https://atomicdata.dev/properties/name',
          ),
        startProperty,
      ),
    ).toBe('Started working');
    expect(afterViews).toEqual(originalViews);
    await expect(page.getByText('All entries', { exact: true })).toBeVisible();
    const originalSource = await page.evaluate(async subject => {
      const resource = await window.store!.getResource(subject);
      const entry = Object.entries(resource.getPropVals()).find(
        ([, value]) =>
          typeof value === 'string' && value.includes('const settings='),
      );
      if (!entry) throw new Error('Clockify source missing');
      await resource.set(entry[0], '// Previous release\n' + entry[1]);
      await resource.save();

      return { property: entry[0], source: entry[1] };
    }, appSubject);
    const pluginUrl = new URL(tableUrl);
    pluginUrl.searchParams.set('subject', appSubject);
    await page.goto(pluginUrl.href);
    await page.getByRole('tab', { name: 'Run', exact: true }).click();
    await page
      .getByRole('button', { name: 'Review Clockify update', exact: true })
      .click();
    await expect(
      page.getByText(
        /Your workspace, date range, destination table and stored key are kept/,
      ),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Apply importer update', exact: true })
      .click();
    // The second apply is the slow one: it writes the source back and then
    // pins the release over the network (`/plugin-release-pin`), and the
    // button only unmounts once both have landed. Under suite load that is
    // past the 10s expect budget, and the failure is indistinguishable from
    // the button being stuck: the count sits at 1 for the whole wait. It is
    // not stuck. Run on its own this test passes at the default budget in
    // 53s, and the ARIA snapshot Playwright captures after the timeout shows
    // the button already gone and no error alert anywhere on the page.
    await expect(
      page.getByRole('button', { name: 'Review Clockify update', exact: true }),
    ).toHaveCount(0, { timeout: 45000 });
    expect(
      await page.evaluate(
        async ({ subject, property }) =>
          (await window.store!.getResource(subject)).get(property),
        { subject: appSubject, property: originalSource.property },
      ),
    ).toBe(originalSource.source);
  });
});
