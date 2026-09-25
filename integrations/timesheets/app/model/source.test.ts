// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { PROJECT, USER, WORKSPACE } from '../../fixtures/clockify/scenario.mjs';
import type { Settings } from '../config.js';
import { fakeStore } from '../fakeStore.js';
import { fixtureProxy } from '../fixtureProxy.js';
import { emptyMirror } from '../observations.js';
import { ensureSchema } from '../schema.js';
import { syncClockify } from '../sync.js';
import { relayTransport } from '../transport.js';
import { readMirror } from '../viewData.js';
import { timesheetFromMirror } from './source.js';

const NOW = Date.parse('2026-09-23T12:00:00Z');
const settings: Settings = {
  workspaceId: WORKSPACE.id,
  userId: USER.id,
  lookbackDays: 30,
};

async function synced() {
  const proxy = fixtureProxy(NOW);
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const progress: [number, number][] = [];
  const result = await syncClockify(
    store,
    relayTransport(store.proxy!, { platform: 'clockify', connectionId: 'c' }),
    settings,
    schema,
    NOW,
    {
      clock: () => NOW,
      onProgress: p => progress.push([p.done, p.total]),
    },
  );

  return { store, result, progress };
}

describe('timesheetFromMirror', () => {
  it('lists completed entries from the mirror with project colour and client, and counts the rest', async () => {
    const { result } = await synced();
    const sheet = timesheetFromMirror({
      mirror: result.mirror,
      projects: result.projects,
      members: result.members,
      settings,
      now: NOW,
      timeZone: 'Europe/Amsterdam',
      weekStart: result.account.weekStart,
    });

    expect(sheet.entries.map(e => e.id).sort()).toEqual([
      'entry-1',
      'entry-2',
      'entry-3',
    ]);
    const first = sheet.entries.find(e => e.id === 'entry-1')!;
    expect(first).toMatchObject({
      description: 'Fix plugin source loading',
      billable: true,
      project: {
        id: PROJECT.id,
        name: PROJECT.name,
        color: PROJECT.color,
        client: PROJECT.clientName,
      },
      member: USER.name,
    });
    expect(first.end - first.start).toBe(2 * 3_600_000);
    expect(sheet.entries.find(e => e.id === 'entry-2')!.billable).toBe(false);
    expect(sheet.running).toBe(1);
    expect(sheet.breaks).toBe(1);
    expect(sheet.weekStart).toBe('MONDAY');
    expect(sheet.window).toEqual({ from: NOW - 30 * 86_400_000, to: NOW });
    expect(sheet.lastChecked).toBe(new Date(NOW).toISOString());
    expect(sheet.conflicts).toEqual([]);
  });

  it('reads the same mirror back from the store after a reload, without names', async () => {
    const { store, result } = await synced();
    const mirror = await readMirror(store, () => NOW);
    expect(mirror).toEqual(result.mirror);
    const sheet = timesheetFromMirror({
      mirror,
      settings,
      now: NOW,
      timeZone: 'UTC',
    });
    expect(sheet.entries).toHaveLength(3);
    expect(sheet.entries[0].project).toEqual({ id: PROJECT.id });
  });

  it('reports save progress per projected entry', async () => {
    const { progress } = await synced();
    expect(progress).toEqual([
      [0, 3],
      [1, 3],
      [2, 3],
    ]);
  });

  it('shows another workspace’s entries only when no settings say whose to show', async () => {
    const { result } = await synced();
    const other = { ...settings, workspaceId: 'elsewhere' };
    expect(
      timesheetFromMirror({
        mirror: result.mirror,
        settings: other,
        now: NOW,
        timeZone: 'UTC',
      }).entries,
    ).toEqual([]);
    expect(
      timesheetFromMirror({
        mirror: result.mirror,
        now: NOW,
        timeZone: 'UTC',
      }).entries,
    ).toHaveLength(3);
  });

  it('is empty for an app that never synced', async () => {
    expect(await readMirror(fakeStore())).toEqual(emptyMirror());
    expect(
      timesheetFromMirror({ mirror: emptyMirror(), now: NOW, timeZone: 'UTC' }),
    ).toMatchObject({ entries: [], running: 0, breaks: 0, unknown: [] });
  });
});
