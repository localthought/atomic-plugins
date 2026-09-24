// @wc-ignore-file
/**
 * #123 M1 scenarios S1–S5, S8 and S27: the read-only observation log against
 * the Clockify mock, through the in-memory store. The mock filters on an
 * entry's start and lists newest start first; both are the mock's reading
 * of unverified live behaviour.
 */
import { describe, expect, it } from 'vitest';
import {
  clockifyEntries,
  clockifyEntry,
  PROJECT,
  USER,
  WORKSPACE,
} from '../fixtures/clockify/scenario.mjs';
import {
  MARGIN_MS,
  readRange,
  TIME_ENTRY,
  timeEntries,
  unknownIntervals,
  type Interval,
} from './clockifyObserve.js';
import type { Settings } from './config.js';
import { describe as describeState } from './controller.js';
import { fakeStore, PARENT, TABLE } from './fakeStore.js';
import { fixtureProxy } from './fixtureProxy.js';
import {
  COMPACT_AFTER_INCREMENTALS,
  ObservationLog,
  type HeadState,
  type SnapshotState,
} from './observationLog.js';
import {
  mirrorDigest,
  recordKey,
  type Incremental,
  type Mirror,
} from './observations.js';
import { ensureSchema } from './schema.js';
import { syncClockify } from './sync.js';
import { relayTransport } from './transport.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-23T12:00:00Z');
const CONNECTION = { platform: 'clockify', connectionId: 'conn-1' };
const settings: Settings = {
  workspaceId: WORKSPACE.id,
  userId: USER.id,
  lookbackDays: 7,
};
const WINDOW = { from: NOW - 7 * DAY, to: NOW };

async function setup(now = NOW) {
  const proxy = fixtureProxy(now);
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const transport = relayTransport(store.proxy!, CONNECTION);
  let ids = 0;
  const newId = () => `obs-${String(++ids).padStart(4, '0')}`;
  /** One sync pass; the observation clock runs `offset` after `NOW`. */
  const run = (offset = 0) =>
    syncClockify(store, transport, settings, schema, now + offset, {
      clock: () => now + offset,
      newId,
      device: 'test',
    });
  const open = () => ObservationLog.open(store, schema, { clock: () => now });
  const app = () => store.resources.get('did:ad:app')!;
  const headSubject = () => app()[schema.log.log] as string;
  const head = () =>
    JSON.parse(
      store.resources.get(headSubject())![schema.log.head] as string,
    ) as HeadState;
  const children = (parent: string) =>
    [...store.resources.entries()].filter(([, r]) => r[PARENT] === parent);
  const incrementals = () =>
    children(headSubject())
      .filter(([, r]) => typeof r[schema.log.observation] === 'string')
      .map(
        ([, r]) =>
          JSON.parse(r[schema.log.observation] as string) as Incremental,
      );
  const snapshots = () =>
    children(headSubject()).filter(
      ([, r]) => typeof r[schema.log.snapshot] === 'string',
    );
  const rows = () => children(TABLE).map(([, r]) => r);
  const rowOf = (id: string) => rows().find(r => r[schema.row.entryId] === id);

  return {
    proxy,
    store,
    schema,
    transport,
    newId,
    run,
    open,
    head,
    incrementals,
    snapshots,
    rows,
    rowOf,
  };
}

/** What the timeline (M2) will show at `t`, from the mirror alone. */
function stateAt(mirror: Mirror, t: number): string {
  if (
    unknownIntervals(mirror, settings, WINDOW, NOW).some(
      i => i.from <= t && t < i.to,
    ) ||
    t < WINDOW.from
  )
    return 'unknown';
  const claims = timeEntries(mirror)
    .filter(r => !r.deletedAt)
    .filter(r => {
      const start = Date.parse(r.fields.start as string);
      const end = r.fields.end ? Date.parse(r.fields.end as string) : NOW;

      return start <= t && t < end;
    })
    .map(r =>
      r.fields.type === 'BREAK'
        ? 'break'
        : r.fields.end === null
          ? 'open'
          : `worked(${String(r.fields.projectId ?? 'none')})`,
    );

  return claims.length ? claims.sort().join('+') : 'not-worked';
}

const mid = (e: { timeInterval: { start: string; end: string | null } }) =>
  (Date.parse(e.timeInterval.start) +
    Date.parse(e.timeInterval.end ?? new Date(NOW).toISOString())) /
  2;

const total = (intervals: Interval[]) =>
  intervals.reduce((sum, i) => sum + i.to - i.from, 0);

describe('observation log scenarios (#123 M1)', () => {
  it('S1: the first sync writes a head, a snapshot and one incremental; the window is known, outside it is not', async () => {
    const t = await setup();
    const [e1, e2, e3, e4, e5] = clockifyEntries(NOW);

    const result = await t.run();

    expect(t.snapshots()).toHaveLength(1);
    expect(t.incrementals()).toHaveLength(1);
    const [first] = t.incrementals();
    expect(first).toMatchObject({
      kind: 'list',
      complete: true,
      absent: [],
      scope: {
        type: 'range',
        collection: TIME_ENTRY,
        field: 'start',
        from: '2026-09-15T12:00:00Z',
        to: '2026-09-23T12:00:00Z',
      },
    });
    // Everything in the window and its margin, running timer and break
    // included; the 20-day-old entry is outside both.
    expect(first.upserts.map(u => u.id).sort()).toEqual([
      'entry-1',
      'entry-2',
      'entry-4',
      'entry-5',
    ]);
    expect(t.head().tail.map(e => e.id)).toEqual([first.id]);
    expect(result.log).toEqual({
      incrementals: 1,
      snapshotWritten: false,
      candidates: 0,
      unknownMs: 0,
    });

    const { mirror } = await t.open();
    expect(stateAt(mirror, mid(e1))).toBe(`worked(${PROJECT.id})`);
    expect(stateAt(mirror, mid(e2))).toBe(`worked(${PROJECT.id})`);
    expect(stateAt(mirror, mid(e4))).toBe('open');
    expect(stateAt(mirror, mid(e5))).toBe('break');
    expect(stateAt(mirror, NOW - 3 * DAY)).toBe('not-worked');
    expect(stateAt(mirror, NOW - 7 * DAY - HOUR)).toBe('unknown');
    expect(stateAt(mirror, mid(e3))).toBe('unknown');
    // Rows: only the two completed REGULAR entries.
    expect(t.rows().map(r => r[t.schema.row.entryId])).toEqual([
      'entry-1',
      'entry-2',
    ]);
  });

  it('S2: a resync with no change stores no incremental and only confirms the coverage again', async () => {
    const t = await setup();
    await t.run();
    const confirmed = t.head().coverage.map(c => c.confirmedAt);

    const again = await t.run(5 * 60_000);

    expect(again.log.incrementals).toBe(0);
    expect(t.incrementals()).toHaveLength(1);
    expect(t.head().tail).toHaveLength(1);
    expect(confirmed).toEqual(['2026-09-23T12:00:00.000Z']);
    // The window moved 5 minutes: what both reads covered is confirmed at
    // 12:05, the 5 minutes only the first read covered stay at 12:00.
    expect(t.head().coverage).toEqual([
      expect.objectContaining({
        from: '2026-09-15T12:00:00Z',
        to: '2026-09-15T12:05:00Z',
        confirmedAt: '2026-09-23T12:00:00.000Z',
      }),
      expect.objectContaining({
        from: '2026-09-15T12:05:00Z',
        to: '2026-09-23T12:05:00Z',
        confirmedAt: '2026-09-23T12:05:00.000Z',
      }),
    ]);
    expect(t.head().lastComplete).toBe('2026-09-23T12:05:00.000Z');
  });

  it('S3: a changed end is one incremental with one upsert, and the row follows', async () => {
    const t = await setup();
    await t.run();
    const entry = t.proxy.fixture.state.entries.find(e => e.id === 'entry-1')!;
    const end = new Date(NOW - DAY - HOUR).toISOString().replace('.000', '');
    entry.timeInterval = { ...entry.timeInterval, end };

    const result = await t.run(60_000);

    expect(result).toMatchObject({ updated: 1, unchanged: 1 });
    expect(result.log.incrementals).toBe(1);
    const latest = t.incrementals().at(-1)!;
    expect(latest.upserts.map(u => u.id)).toEqual(['entry-1']);
    expect(latest.upserts[0].fields.end).toBe(end);
    expect(latest.unchanged).toBe(3);
    expect(t.rowOf('entry-1')![t.schema.row.end]).toBe(Date.parse(end));
  });

  it('S4: a deletion is first a candidate (unknown), then a GET 404 confirms it and the row goes', async () => {
    const t = await setup();
    await t.run();
    const [, e2] = clockifyEntries(NOW);
    t.proxy.fixture.control({ action: 'delete', id: 'entry-2' });

    const first = await t.run(60_000);

    expect(first.log.candidates).toBe(1);
    expect(first.log.unknownMs).toBe(HOUR);
    expect(t.incrementals().at(-1)!.absent).toEqual(['entry-2']);
    expect(stateAt((await t.open()).mirror, mid(e2))).toBe('unknown');
    // Not deleted on a list read's word alone.
    expect(t.rowOf('entry-2')).toBeDefined();
    expect(first.removed).toBe(0);
    expect(describeState(ready(first))).toContain(
      "1 missing from Clockify's list, re-checked on the next sync.",
    );
    expect(describeState(ready(first))).toContain('60 min not loaded.');

    const second = await t.run(120_000);

    expect(t.proxy.fixture.state.requests).toContain(
      `GET /proxy/clockify/api/v1/workspaces/${WORKSPACE.id}/time-entries/entry-2`,
    );
    const point = t.incrementals().at(-1)!;
    expect(point).toMatchObject({
      kind: 'point',
      scope: { type: 'id', id: 'entry-2' },
      absent: ['entry-2'],
    });
    const { mirror } = await t.open();
    expect(mirror.records[recordKey(TIME_ENTRY, 'entry-2')].deletedAt).toBe(
      '2026-09-23T12:02:00.000Z',
    );
    expect(second).toMatchObject({ removed: 1, unchanged: 1 });
    expect(second.log).toMatchObject({ candidates: 0, unknownMs: 0 });
    expect(stateAt(mirror, mid(e2))).toBe('not-worked');
    expect(t.rowOf('entry-2')).toBeUndefined();
    expect(describeState(ready(second))).toContain(
      '1 removed (deleted in Clockify).',
    );
  });

  it('S5: an entry skipped because another was deleted between pages is restored by its GET, not deleted', async () => {
    const t = await setup();
    // 60 completed entries, 2 h apart, newest first: two pages of 50.
    t.proxy.fixture.state.entries = Array.from({ length: 60 }, (_, i) =>
      clockifyEntry(
        `bulk-${String(i).padStart(2, '0')}`,
        `Bulk ${i}`,
        NOW - (i + 1) * 2 * HOUR,
        NOW - (i + 1) * 2 * HOUR + HOUR,
      ),
    );
    expect((await t.run()).created).toBe(60);
    // bulk-00 is the newest; deleting it after page 1 shifts bulk-50 onto
    // page 1, which was already served.
    t.proxy.fixture.control({ action: 'deleteDuringPaging', id: 'bulk-00' });

    const skipped = await t.run(60_000);

    expect(skipped.log.candidates).toBe(1);
    expect(t.incrementals().at(-1)!.absent).toEqual(['bulk-50']);

    const restored = await t.run(120_000);

    // bulk-50's GET answered 200: no longer a candidate, never deleted.
    const { mirror } = await t.open();
    const bulk50 = mirror.records[recordKey(TIME_ENTRY, 'bulk-50')];
    expect(bulk50.absentSince).toBeUndefined();
    expect(bulk50.deletedAt).toBeUndefined();
    expect(t.rowOf('bulk-50')).toBeDefined();
    expect(restored.removed).toBe(0);
    // The entry that really went is now the candidate…
    expect(t.incrementals().at(-1)!.absent).toEqual(['bulk-00']);

    const confirmed = await t.run(180_000);

    // …and only it is removed.
    expect(confirmed.removed).toBe(1);
    expect(t.rowOf('bulk-00')).toBeUndefined();
    expect(t.rows()).toHaveLength(59);
  });

  it('S8: an entry longer than 24 h across the window start leaves the first part unknown until an older read', async () => {
    const t = await setup();
    // Starts 2 h before the window, inside the margin, and runs 25 h.
    t.proxy.fixture.control({
      action: 'add',
      entry: clockifyEntry(
        'long',
        'Long one',
        WINDOW.from - 2 * HOUR,
        WINDOW.from + 23 * HOUR,
      ),
    });

    const result = await t.run();

    // Starts are known back to window start − 24 h; with a 25 h entry seen,
    // anything that started up to 25 h before a moment could reach it.
    expect(result.log.unknownMs).toBe(HOUR);
    const log = await t.open();
    expect(unknownIntervals(log.mirror, settings, WINDOW, NOW)).toEqual([
      { from: WINDOW.from, to: WINDOW.from + HOUR },
    ]);
    expect(describeState(ready(result))).toContain('60 min not loaded.');

    // "Load older": one more range read, before the first one's margin.
    const older = await readRange(
      {
        transport: t.transport,
        workspaceId: WORKSPACE.id,
        userId: USER.id,
        clock: () => NOW + 60_000,
        newId: t.newId,
        device: 'test',
        timeZone: 'Europe/Amsterdam',
      },
      WINDOW.from - MARGIN_MS - 7 * DAY,
      WINDOW.from - MARGIN_MS,
    );
    await log.append(older.observation);
    await log.flush();

    expect(total(unknownIntervals(log.mirror, settings, WINDOW, NOW))).toBe(0);
    expect(
      total(unknownIntervals((await t.open()).mirror, settings, WINDOW, NOW)),
    ).toBe(0);
  });

  it('S27: after 50 incrementals a snapshot is written, and the fold is the same before and after', async () => {
    const t = await setup();
    await t.run();
    const entry = t.proxy.fixture.state.entries.find(e => e.id === 'entry-1')!;
    let snapshotAt = -1;

    for (let i = 1; i <= COMPACT_AFTER_INCREMENTALS + 3; i++) {
      entry.description = `Edit ${i}`;
      const before = mirrorDigest(
        await ObservationLog.replay(t.store, t.schema),
      );
      const result = await t.run(i * 60_000);
      if (result.log.snapshotWritten) snapshotAt = i;
      // Opening (snapshot + tail) always equals replaying every incremental.
      const opened = mirrorDigest((await t.open()).mirror);
      const replayed = mirrorDigest(
        await ObservationLog.replay(t.store, t.schema),
      );
      expect(opened).toBe(replayed);
      expect(opened).not.toBe(before);
    }

    // The first sync's incremental plus 49 edits reach 50.
    expect(snapshotAt).toBe(COMPACT_AFTER_INCREMENTALS - 1);
    expect(t.snapshots()).toHaveLength(2);
    const current = JSON.parse(
      t.store.resources.get(t.head().snapshot)![
        t.schema.log.snapshot
      ] as string,
    ) as SnapshotState;
    expect(current.compacted).toHaveLength(COMPACT_AFTER_INCREMENTALS);
    expect(current.previous).not.toBeNull();
    // The full log is kept: nothing was pruned.
    expect(t.incrementals()).toHaveLength(COMPACT_AFTER_INCREMENTALS + 4);
    expect(t.head().tail).toHaveLength(4);
    expect(t.rowOf('entry-1')!['https://atomicdata.dev/properties/name']).toBe(
      `Edit ${COMPACT_AFTER_INCREMENTALS + 3}`,
    );
  }, 30_000);

  it('refolds from the whole log when an incremental arrives that sorts before the snapshot', async () => {
    const t = await setup();
    await t.run();

    for (let i = 1; i < COMPACT_AFTER_INCREMENTALS; i++) {
      t.proxy.fixture.state.entries[0].description = `Edit ${i}`;
      await t.run(i * 60_000);
    }

    expect(t.head().tail).toHaveLength(0);
    // Another device's read, received before the snapshot's cut, lands late.
    const late: Incremental = {
      v: 1,
      id: 'obs-late',
      device: 'other',
      sentAt: '2026-09-23T12:00:30.000Z',
      receivedAt: '2026-09-23T12:00:30.000Z',
      kind: 'point',
      scope: { type: 'id', collection: TIME_ENTRY, id: 'entry-2' },
      mask: ['description'],
      complete: true,
      upserts: [{ id: 'entry-2', fields: { description: 'Seen elsewhere' } }],
      absent: [],
      unchanged: 0,
      digest: '00000000',
    };
    const created = await t.store.newResource({
      parent: t.store.resources.get('did:ad:app')![t.schema.log.log] as string,
      propVals: { [t.schema.log.observation]: JSON.stringify(late) },
    });
    const head = t.head();
    head.tail.push({
      subject: created.subject,
      id: late.id,
      receivedAt: late.receivedAt,
      bytes: 1,
    });
    t.store.resources.get(
      t.store.resources.get('did:ad:app')![t.schema.log.log] as string,
    )![t.schema.log.head] = JSON.stringify(head);

    const opened = (await t.open()).mirror;

    expect(mirrorDigest(opened)).toBe(
      mirrorDigest(await ObservationLog.replay(t.store, t.schema)),
    );
    // Folded in its place: later reads of entry-2 did not change it again,
    // so the late description stays.
    expect(
      opened.records[recordKey(TIME_ENTRY, 'entry-2')].fields.description,
    ).toBe('Seen elsewhere');
  });

  it('keeps a partial read: a later page failing keeps page 1, proves no absence, and fails the sync', async () => {
    const t = await setup();
    t.proxy.fixture.state.entries = Array.from({ length: 55 }, (_, i) =>
      clockifyEntry(`p-${i}`, `P ${i}`, NOW - (i + 1) * HOUR, NOW - i * HOUR),
    );
    await t.run();
    // p-0 changes (it is on page 1); page 2 then fails.
    t.proxy.fixture.state.entries[0].description = 'Changed';
    const serve = t.proxy.fixture.request.bind(t.proxy.fixture);
    t.proxy.fixture.request = (method, url, body) =>
      url.searchParams.get('page') === '2'
        ? { status: 503, body: { message: 'Simulated Clockify failure' } }
        : serve(method, url, body);
    const rowsBefore = structuredClone(t.rows());

    await expect(t.run(60_000)).rejects.toThrow(/failed with 503/);

    const partial = t.incrementals().at(-1)!;
    expect(partial).toMatchObject({ complete: false, absent: [] });
    expect(partial.upserts.map(u => u.id)).toEqual(['p-0']);
    const { mirror } = await t.open();
    expect(
      mirror.records[recordKey(TIME_ENTRY, 'p-0')].fields.description,
    ).toBe('Changed');
    expect(Object.values(mirror.records).some(r => r.absentSince)).toBe(false);
    // No coverage from an incomplete read, and the rows are untouched.
    expect(t.head().lastComplete).toBe('2026-09-23T12:00:00.000Z');
    expect(t.rows()).toEqual(rowsBefore);
  });
});

describe('time zones and live-checked answers (#123 findings, 2026-09-24)', () => {
  const Z = (text: string) => Date.parse(text);

  const listQuery = (t: Awaited<ReturnType<typeof setup>>) => {
    const request = t.proxy.fixture.state.requests.find(r =>
      r.includes('/time-entries?'),
    )!;

    return new URL(request.slice(request.indexOf(' ') + 1), 'http://x')
      .searchParams;
  };

  it('across the repeated hour (25 October), claims no coverage it cannot prove and invents no absence', async () => {
    // Now is the second 02:30 in Amsterdam (CET, 01:30Z).
    const now = Z('2026-10-25T01:30:00Z');
    const t = await setup(now);
    // Started at the first 02:40 (CEST, 00:40Z).
    t.proxy.fixture.control({
      action: 'add',
      entry: clockifyEntry(
        'early',
        'Early',
        Z('2026-10-25T00:40:00Z'),
        Z('2026-10-25T00:50:00Z'),
      ),
    });

    const first = await t.run();

    expect(listQuery(t).get('end')).toBe('2026-10-25T02:30:00Z');
    // Clockify may read the end bound "02:30" as 00:30Z: the last hour is
    // not claimed as read, and shows as unknown, not as "not worked".
    expect(t.incrementals()[0].scope).toMatchObject({
      to: '2026-10-25T00:30:00Z',
    });
    expect(first.log.unknownMs).toBe(HOUR);
    const { mirror } = await t.open();
    expect(mirror.records[recordKey(TIME_ENTRY, 'early')]).toBeUndefined();

    // Once the hour has passed, the entry is read and nothing is absent.
    const later = await t.run(2 * HOUR);
    expect(later.log).toMatchObject({ candidates: 0, unknownMs: 0 });
    expect(
      (await t.open()).mirror.records[recordKey(TIME_ENTRY, 'early')],
    ).toBeDefined();
  });

  it('across the skipped hour (29 March), reads entries on both sides with no gap in coverage', async () => {
    const now = Z('2026-03-29T02:00:00Z'); // 04:00 CEST
    const t = await setup(now);

    for (const [id, from, to] of [
      ['before', '2026-03-29T00:30:00Z', '2026-03-29T00:55:00Z'],
      ['after', '2026-03-29T01:10:00Z', '2026-03-29T01:40:00Z'],
    ])
      t.proxy.fixture.control({
        action: 'add',
        entry: clockifyEntry(id, id, Z(from), Z(to)),
      });

    const result = await t.run();

    // 8 days back is still CET (+1); now is CEST (+2).
    expect(listQuery(t).get('start')).toBe('2026-03-21T03:00:00Z');
    expect(listQuery(t).get('end')).toBe('2026-03-29T04:00:00Z');
    expect(t.incrementals()[0].scope).toMatchObject({
      from: '2026-03-21T02:00:00Z',
      to: '2026-03-29T02:00:00Z',
    });
    expect(result.log.unknownMs).toBe(0);
    expect(t.rowOf('before')).toBeDefined();
    expect(t.rowOf('after')).toBeDefined();
  });

  it('reads the profile time zone from Clockify on every pass', async () => {
    const t = await setup();
    t.proxy.fixture.control({
      action: 'settings',
      timeZone: 'America/New_York',
    });

    const result = await t.run();

    expect(result.account.timeZone).toBe('America/New_York');
    // 2026-09-15T12:00Z is 08:00 in New York (EDT).
    expect(listQuery(t).get('start')).toBe('2026-09-15T08:00:00Z');
    expect(result.log.unknownMs).toBe(0);
  });

  it('notes forceProjects in the result and the status line', async () => {
    const t = await setup();
    t.proxy.fixture.control({ action: 'settings', forceProjects: true });

    const result = await t.run();

    expect(result.account.forceProjects).toBe(true);
    expect(describeState(ready(result))).toContain(
      'This workspace requires a project on every entry.',
    );
  });

  it('treats any other 400 on a re-check as an error: the candidate stays, with a warning', async () => {
    const t = await setup();
    await t.run();
    t.proxy.fixture.control({ action: 'delete', id: 'entry-2' });
    await t.run(60_000);
    const serve = t.proxy.fixture.request.bind(t.proxy.fixture);
    t.proxy.fixture.request = (method, url, body) =>
      url.pathname.endsWith('/time-entries/entry-2')
        ? { status: 400, body: { message: 'Something else' } }
        : serve(method, url, body);

    const result = await t.run(120_000);

    expect(result.removed).toBe(0);
    expect(result.log.candidates).toBe(1);
    expect(result.warnings.join(' ')).toMatch(
      /re-check entry entry-2.*400: Something else/,
    );
    expect(t.rowOf('entry-2')).toBeDefined();
  });
});

/** A `ready` view state around a sync result, for the status line. */
function ready(result: Awaited<ReturnType<typeof syncClockify>>) {
  return {
    kind: 'ready' as const,
    connection: CONNECTION,
    settings,
    last: { ok: true as const, result, at: NOW },
  };
}
