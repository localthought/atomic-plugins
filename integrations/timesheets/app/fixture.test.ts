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
  it('serves one entry by id, and 404 once it is gone', async () => {
    const { call } = setup();

    const found = await call('GET', `${WS}/time-entries/entry-1`);
    expect(found.status).toBe(200);
    expect(description(found)).toBe('Fix plugin source loading');
    expect((await call('GET', `${WS}/time-entries/nope`)).status).toBe(404);
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
    expect((await call('GET', `${WS}/time-entries/entry-2`)).status).toBe(404);
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
