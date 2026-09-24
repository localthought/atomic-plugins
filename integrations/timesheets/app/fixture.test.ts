// @wc-ignore-file
/**
 * The Clockify mock's write endpoints and behaviour switches (#123 M0,
 * §5.1). They model the documented API, not a recording: every assertion
 * here is about the mock, and none of it is verified against a live
 * Clockify account.
 */
import { describe, expect, it } from 'vitest';
import {
  clockifyDocument,
  clockifyEntries,
  clockifyEntry,
  clockifyFixture,
  clockifyReadOnlyDocument,
  NOT_IN_CATALOG,
  NOT_IN_WORKSPACE,
  PROJECT_REQUIRED,
  wallClockToInstant,
  USER,
  WORKSPACE,
} from '../fixtures/clockify/scenario.mjs';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const WS = `/proxy/clockify/api/v1/workspaces/${WORKSPACE.id}`;
const LIST = `${WS}/user/${USER.id}/time-entries`;

function setup() {
  const fixture = clockifyFixture();
  fixture.state.entries = clockifyEntries(NOW);
  const call = async (method: string, path: string, body?: unknown) =>
    (await fixture.request(
      method,
      new URL(path, 'http://proxy.test'),
      body,
    )) as {
      status: number;
      body: unknown;
      headers?: Record<string, string>;
    };

  return { fixture, call };
}

const ids = (reply: { body: unknown }) =>
  (reply.body as { id: string }[]).map(e => e.id);
const description = (reply: { body: unknown }) =>
  (reply.body as { description: string }).description;

describe('Clockify mock: catalog document', () => {
  it('declares the write overlay on top of the read-only document', () => {
    const one = '/v1/workspaces/{workspaceId}/time-entries/{id}';
    expect(Object.keys(clockifyReadOnlyDocument.paths[one])).toEqual(['get']);
    // Read-only: every operation in it is a GET, setup reads included.
    expect(
      Object.values(clockifyReadOnlyDocument.paths).flatMap(item =>
        Object.keys(item),
      ),
    ).toEqual(Object.keys(clockifyReadOnlyDocument.paths).map(() => 'get'));
    expect(clockifyReadOnlyDocument.paths['/v1/user']).toBeDefined();
    expect(clockifyReadOnlyDocument.paths['/v1/workspaces']).toBeDefined();
    expect(Object.keys(clockifyDocument.paths[one]).sort()).toEqual([
      'delete',
      'get',
      'put',
    ]);
    expect(
      clockifyDocument.paths['/v1/workspaces/{workspaceId}/time-entries'].post[
        'x-crud'
      ].action,
    ).toBe('create');
  });
});

describe('Clockify mock: time-entry endpoints', () => {
  it('serves one entry by id, and a 400 "doesn\'t belong to Workspace" for an unknown id, as Clockify does', async () => {
    const { call } = setup();

    const found = await call('GET', `${WS}/time-entries/entry-1`);
    expect(found.status).toBe(200);
    expect(description(found)).toBe('Fix plugin source loading');
    const unknown = await call('GET', `${WS}/time-entries/nope`);
    expect(unknown).toMatchObject({ status: 400, body: NOT_IN_WORKSPACE });
    expect(
      (
        await call(
          'GET',
          `/proxy/clockify/api/v1/workspaces/other/time-entries/entry-1`,
        )
      ).status,
    ).toBe(403);
  });

  it('lists newest start first, with a Last-Page header', async () => {
    const { call } = setup();

    const first = await call('GET', `${LIST}?page=1&page-size=2`);
    const last = await call('GET', `${LIST}?page=3&page-size=2`);
    expect(ids(first)).toEqual(['entry-4', 'entry-5']);
    expect(first.headers).toEqual({ 'Last-Page': 'false' });
    expect(ids(last)).toEqual(['entry-3']);
    expect(last.headers).toEqual({ 'Last-Page': 'true' });
  });

  it('creates an entry with a server-chosen id', async () => {
    const { call, fixture } = setup();

    const created = await call('POST', `${WS}/time-entries`, {
      start: '2026-09-22T08:00:00Z',
      end: '2026-09-22T09:00:00Z',
      projectId: 'p1',
    });

    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({
      id: 'e00000000000000000000001',
      userId: USER.id,
      projectId: 'p1',
      description: '',
      billable: false,
      timeInterval: {
        start: '2026-09-22T08:00:00Z',
        end: '2026-09-22T09:00:00Z',
        duration: 'PT3600S',
      },
    });
    expect(fixture.state.entries).toHaveLength(6);
    expect(fixture.state.writes).toEqual([
      {
        method: 'POST',
        path: `${WS}/time-entries`,
        body: {
          start: '2026-09-22T08:00:00Z',
          end: '2026-09-22T09:00:00Z',
          projectId: 'p1',
        },
      },
    ]);
  });

  it('replaces the whole entry on PUT: omitted fields are cleared, no end makes it run', async () => {
    const { call } = setup();

    const replaced = await call('PUT', `${WS}/time-entries/entry-1`, {
      start: '2026-09-22T08:00:00Z',
    });

    expect(replaced.status).toBe(200);
    expect(replaced.body).toMatchObject({
      id: 'entry-1',
      description: '',
      projectId: null,
      billable: false,
      tagIds: null,
      timeInterval: { start: '2026-09-22T08:00:00Z', end: null },
    });
    expect(
      (await call('PUT', `${WS}/time-entries/entry-1`, { end: 'x' })).status,
    ).toBe(400);
    expect(
      (
        await call('PUT', `${WS}/time-entries/entry-1`, {
          start: '2026-09-22T08:00:00Z',
          end: '2026-09-22T07:00:00Z',
        })
      ).status,
    ).toBe(400);
  });

  it('deletes an entry', async () => {
    const { call } = setup();

    expect((await call('DELETE', `${WS}/time-entries/entry-2`)).status).toBe(
      204,
    );
    // Live: GET of a deleted entry is a 400, DELETE of one a 404.
    expect((await call('GET', `${WS}/time-entries/entry-2`)).body).toEqual(
      NOT_IN_WORKSPACE,
    );
    expect((await call('DELETE', `${WS}/time-entries/entry-2`)).status).toBe(
      404,
    );
  });

  it('refuses writes to a locked entry with 400 (the live status is unverified)', async () => {
    const { call, fixture } = setup();
    fixture.state.entries[0].isLocked = true;

    expect((await call('DELETE', `${WS}/time-entries/entry-1`)).status).toBe(
      400,
    );
    expect(
      (
        await call('PUT', `${WS}/time-entries/entry-1`, {
          start: '2026-09-22T08:00:00Z',
        })
      ).status,
    ).toBe(400);
    expect(fixture.state.entries).toHaveLength(5);
  });

  it('answers what the proxy catalog does not declare with 404, as the proxy does', async () => {
    const { call, fixture } = setup();

    expect((await call('PATCH', `${WS}/time-entries/entry-1`, {})).status).toBe(
      404,
    );
    expect((await call('POST', LIST, { start: 'x' })).status).toBe(404);
    // Reads too: every path and method outside the document gets the
    // proxy's own 404, not Clockify's.
    for (const path of [
      `${WS}/time-entries`,
      `${WS}/tags`,
      '/proxy/clockify/api/v1/nothing',
      '/proxy/clockify/v1/user',
    ])
      expect((await call('GET', path)).body).toBe(NOT_IN_CATALOG);
    // The setup and naming reads the app makes are declared.
    for (const path of [
      '/proxy/clockify/api/v1/user',
      '/proxy/clockify/api/v1/workspaces',
      `${WS}/projects`,
      `${WS}/users`,
    ])
      expect((await call('GET', path)).status).toBe(200);
    fixture.control({ action: 'catalog', readOnly: true });
    expect((await call('DELETE', `${WS}/time-entries/entry-1`)).body).toBe(
      'method or path is not in the catalog',
    );
    expect(fixture.state.entries).toHaveLength(5);
    fixture.control({ action: 'catalog', readOnly: false });
    expect((await call('DELETE', `${WS}/time-entries/entry-1`)).status).toBe(
      204,
    );
  });
});

describe('Clockify mock: behaviour switches', () => {
  it('forbid: answers writes 403 without applying them, until lifted', async () => {
    const { call, fixture } = setup();
    fixture.control({ action: 'forbid' });

    expect((await call('DELETE', `${WS}/time-entries/entry-1`)).status).toBe(
      403,
    );
    expect((await call('GET', `${WS}/time-entries/entry-1`)).status).toBe(200);
    expect(fixture.state.entries).toHaveLength(5);
    fixture.control({ action: 'forbid', methods: ['GET'] });
    expect((await call('GET', `${LIST}`)).status).toBe(403);
    fixture.control({ action: 'forbid', methods: [] });
    expect((await call('DELETE', `${WS}/time-entries/entry-1`)).status).toBe(
      204,
    );
  });

  it('failBefore: the next write fails without taking effect', async () => {
    const { call, fixture } = setup();
    fixture.control({ action: 'failBefore' });

    expect((await call('DELETE', `${WS}/time-entries/entry-1`)).status).toBe(
      503,
    );
    expect(fixture.state.entries).toHaveLength(5);
    expect((await call('DELETE', `${WS}/time-entries/entry-1`)).status).toBe(
      204,
    );
  });

  it('applyThenDrop: the next write takes effect but its response is lost', async () => {
    const { call, fixture } = setup();
    fixture.control({ action: 'applyThenDrop' });

    const dropped = await call('POST', `${WS}/time-entries`, {
      start: '2026-09-22T08:00:00Z',
      end: '2026-09-22T09:00:00Z',
    });

    expect(dropped.status).toBe(502);
    expect(fixture.state.entries).toHaveLength(6);

    fixture.control({ action: 'applyThenDrop', hang: true });
    const pending = fixture.request(
      'DELETE',
      new URL(`${WS}/time-entries/entry-1`, 'http://proxy.test'),
    );
    expect(pending).toBeInstanceOf(Promise);
    expect(fixture.state.entries.some(e => e.id === 'entry-1')).toBe(false);
  });

  it('onNextRequest: changes Clockify just before the matching request is served', async () => {
    const { call, fixture } = setup();
    fixture.control({
      action: 'onNextRequest',
      match: 'GET /proxy/clockify/api/v1/workspaces/',
      id: 'entry-1',
      patch: { description: 'Edited elsewhere' },
    });

    const read = await call('GET', `${WS}/time-entries/entry-1`);

    expect(description(read)).toBe('Edited elsewhere');
    expect(fixture.state.onNextRequest).toEqual([]);
  });

  it('deleteDuringPaging: an entry vanishes between page 1 and page 2, shifting one forward', async () => {
    const { call, fixture } = setup();
    fixture.control({ action: 'deleteDuringPaging', id: 'entry-4' });

    const one = await call('GET', `${LIST}?page=1&page-size=2`);
    const two = await call('GET', `${LIST}?page=2&page-size=2`);

    expect(ids(one)).toEqual(['entry-4', 'entry-5']);
    // entry-2 moved onto page 1 and is never served: skipped, not deleted.
    expect(ids(two)).toEqual(['entry-1', 'entry-3']);
    expect(fixture.state.entries.some(e => e.id === 'entry-2')).toBe(true);
  });

  it('add and delete change "Clockify" between syncs; reset restores everything', async () => {
    const { fixture } = setup();
    fixture.control({
      action: 'add',
      entry: clockifyEntry('extra', 'Extra', NOW - 3_600_000, NOW),
    });
    fixture.control({ action: 'delete', id: 'entry-1' });
    fixture.control({ action: 'forbid' });

    expect(fixture.state.entries.map(e => e.id)).toContain('extra');
    expect(fixture.state.entries.map(e => e.id)).not.toContain('entry-1');
    fixture.control({ action: 'reset' });
    expect(fixture.state.entries).toHaveLength(5);
    expect(fixture.state.forbidden.methods).toEqual([]);
  });
});

describe('Clockify mock: behaviour checked live on 2026-09-24', () => {
  const at = (text: string) => Date.parse(text);
  const list = (fixture: ReturnType<typeof clockifyFixture>, query: string) =>
    fixture.request(
      'GET',
      new URL(`${LIST}?${query}`, 'http://proxy.test'),
    ) as {
      status: number;
      body: { id: string }[];
    };

  const only = (start: string, end: string) => {
    const fixture = clockifyFixture();
    fixture.state.entries = [clockifyEntry('e', 'E', at(start), at(end))];

    return fixture;
  };

  it('reads list bounds as wall-clock time in the profile time zone, ignoring Z and offsets', () => {
    // 00:30 in Amsterdam (CEST) is 22:30 UTC the day before.
    const fixture = only('2026-09-26T22:30:00Z', '2026-09-26T23:00:00Z');

    for (const zone of ['Z', '+02:00', '+00:00'])
      expect(
        list(
          fixture,
          `start=2026-09-27T00:00:00${encodeURIComponent(zone)}&end=2026-09-27T03:00:00Z`,
        ).body.map(e => e.id),
      ).toEqual(['e']);
    // Read as UTC, 00:00–03:00 would miss it.
    fixture.control({ action: 'settings', timeZone: 'UTC' });
    expect(
      list(fixture, 'start=2026-09-27T00:00:00Z&end=2026-09-27T03:00:00Z').body,
    ).toEqual([]);
  });

  it('refuses a bound without a zone', () => {
    const fixture = only('2026-09-26T22:30:00Z', '2026-09-26T23:00:00Z');

    expect(list(fixture, 'start=2026-09-27T01:15:00').status).toBe(400);
  });

  it("filters on the entry's start in [start, end): the end is exclusive", () => {
    // 02:30 Amsterdam = 00:30 UTC.
    const fixture = only('2026-09-27T00:30:00Z', '2026-09-27T01:00:00Z');
    const listed = (q: string) => list(fixture, q).body.map(e => e.id);

    expect(
      listed('start=2026-09-27T02:30:00Z&end=2026-09-27T02:59:59Z'),
    ).toEqual(['e']);
    expect(
      listed('start=2026-09-27T02:30:01Z&end=2026-09-27T03:00:00Z'),
    ).toEqual([]);
    expect(
      listed('start=2026-09-27T02:00:00Z&end=2026-09-27T02:30:00Z'),
    ).toEqual([]);
  });

  it('resolves wall-clock times on DST days as java.time does (an assumption)', () => {
    const tz = 'Europe/Amsterdam';
    // 2026-10-25: 02:00–03:00 happens twice; the earlier instant is used.
    expect(wallClockToInstant(at('2026-10-25T02:30:00Z'), tz)).toBe(
      at('2026-10-25T00:30:00Z'),
    );
    // 2026-03-29: 02:00–03:00 does not exist; shifted forward by the gap.
    expect(wallClockToInstant(at('2026-03-29T02:30:00Z'), tz)).toBe(
      at('2026-03-29T01:30:00Z'),
    );
    expect(wallClockToInstant(at('2026-03-29T03:30:00Z'), tz)).toBe(
      at('2026-03-29T01:30:00Z'),
    );
  });

  it('truncates written instants to whole seconds', async () => {
    const { call } = setup();

    const created = await call('POST', `${WS}/time-entries`, {
      start: '2026-09-27T02:20:00.789Z',
      end: '2026-09-27T02:40:00.999Z',
    });

    expect(created.body).toMatchObject({
      timeInterval: {
        start: '2026-09-27T02:20:00Z',
        end: '2026-09-27T02:40:00Z',
      },
    });
  });

  it('with forceProjects, refuses a create or PUT without a project', async () => {
    const { call, fixture } = setup();
    fixture.control({ action: 'settings', forceProjects: true });
    const start = '2026-09-27T02:20:00Z';

    expect(await call('POST', `${WS}/time-entries`, { start })).toMatchObject({
      status: 400,
      body: { message: PROJECT_REQUIRED },
    });
    expect(
      (await call('PUT', `${WS}/time-entries/entry-1`, { start })).status,
    ).toBe(400);
    expect(
      (
        await call('PUT', `${WS}/time-entries/entry-1`, {
          start,
          projectId: 'p',
        })
      ).status,
    ).toBe(200);
    // Setup can see the setting, and the user's time zone.
    const workspaces = await call('GET', '/proxy/clockify/api/v1/workspaces');
    expect(workspaces.body).toContainEqual(
      expect.objectContaining({ settings: { forceProjects: true } }),
    );
    const user = await call('GET', '/proxy/clockify/api/v1/user');
    expect(user.body).toMatchObject({
      settings: { timeZone: 'Europe/Amsterdam' },
    });
  });
});
