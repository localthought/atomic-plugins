// @wc-ignore-file
/**
 * The pinned host can read a class of the shared ontology (#177) from where
 * the dev-server serves it: `/ontology/...`, the committed term files with
 * their subjects moved to the dev-server's origin and GitHub Pages' headers
 * (octet-stream, `access-control-allow-origin: *`, a preflight answered 405;
 * integrations/tooling/dev-server.mjs `serveTerm`). This repeats the core of
 * spike S1 against the real generated files, not a draft:
 *
 *   node integrations/tooling/run-lane.mjs ontology --tier e2e
 *
 * - The data browser's store reads `event-v1` with its name, `isA` and the
 *   `requires`/`recommends` the build wrote.
 * - atomic-server accepts a hand-made table whose `classtype` is that class,
 *   and a row of it with an `atomic-calendar-day` value, which it can only
 *   validate after fetching that property itself.
 *
 * atomic-server has to reach the same URL as the browser. With
 * ATOMIC_SERVER_IMAGE set it runs in Docker, where the dev-server on the
 * host is `host.docker.internal`; Chromium maps that name to 127.0.0.1.
 *
 * Not checked here: the real https://ontola.github.io URL (the
 * `ontology-published` workflow checks Pages serves the same bytes), a cold
 * browser or server while the ontology is unreachable (spike S1 found both
 * fail), and "Allow editing" on such a table (spike S1 found it works).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { before } from '../../../browser/e2e/tests/test-utils';

// Playwright loads this spec as CommonJS, so __dirname, not import.meta.
const repo = resolve(__dirname, '../../..');
const PUBLISHED: string = JSON.parse(
  readFileSync(resolve(repo, 'ontology-kit/base.json'), 'utf8'),
).base;
const DEV_PORT = new URL(
  process.env.PLUGIN_CATALOG_URL ?? 'http://localhost:19271/x',
).port;
const HOST = process.env.ATOMIC_SERVER_IMAGE
  ? 'host.docker.internal'
  : 'localhost';
const BASE = `http://${HOST}:${DEV_PORT}/ontology`;

/** A committed term file, as the dev-server serves it. */
const served = (path: string) =>
  JSON.parse(
    readFileSync(resolve(repo, 'ontology', path), 'utf8').replaceAll(
      PUBLISHED,
      BASE,
    ),
  ) as Record<string, unknown>;

const P = {
  name: 'https://atomicdata.dev/properties/name',
  isA: 'https://atomicdata.dev/properties/isA',
  classtype: 'https://atomicdata.dev/properties/classtype',
  requires: 'https://atomicdata.dev/properties/requires',
  recommends: 'https://atomicdata.dev/properties/recommends',
  table: 'https://atomicdata.dev/classes/Table',
  Class: 'https://atomicdata.dev/classes/Class',
};

const EVENT = served('classes/event-v1');
const DAY = `${BASE}/properties/atomic-calendar-day`;

test.use({
  launchOptions: {
    args: ['--host-resolver-rules=MAP host.docker.internal 127.0.0.1'],
  },
});

async function read(page: Page, subject: string) {
  return page.evaluate(
    async ({ s, p }) => {
      const r = await window.store!.getResource(s);

      return {
        error: r.error ? String(r.error.message ?? r.error) : null,
        name: r.get(p.name) ?? null,
        isA: r.get(p.isA) ?? null,
        requires: r.get(p.requires) ?? null,
        recommends: r.get(p.recommends) ?? null,
      };
    },
    { s: subject, p: P },
  );
}

test.describe('shared ontology', () => {
  test.beforeEach(before);

  test('the host reads a generated class from the dev-server', async ({
    page,
  }) => {
    test.setTimeout(120_000);
    const subject = EVENT['@id'] as string;
    expect(subject).toBe(`${BASE}/classes/event-v1`);

    const got = await read(page, subject);
    expect(got.error).toBeNull();
    expect(got.name).toBe(EVENT[P.name]);
    expect(got.isA).toEqual([P.Class]);
    expect(got.requires).toEqual(EVENT[P.requires]);
    expect(got.recommends).toEqual(EVENT[P.recommends]);

    const made = await page.evaluate(
      async ({ klass, day, p }) => {
        const store = window.store!;
        const table = await store.newResource({
          parent: store.getDrive(),
          isA: [p.table],
          propVals: { [p.name]: 'Shared events', [p.classtype]: klass },
        });
        await table.save();
        const row = await store.newResource({
          parent: table.subject,
          isA: [klass],
          propVals: { [p.name]: 'Launch', [day]: '2026-09-25' },
        });

        try {
          await row.save();
        } catch (e) {
          return { table: table.subject, error: String((e as Error).message) };
        }

        return { table: table.subject, error: null };
      },
      { klass: subject, day: DAY, p: P },
    );
    expect(made.error).toBeNull();
  });
});
