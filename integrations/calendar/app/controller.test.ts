// @wc-ignore-file
import { describe as suite, expect, it } from 'vitest';
import { PRIMARY } from '../fixtures/google-calendar/scenario.mjs';
import {
  banner,
  classify,
  createController,
  pill,
  reviewCount,
  syncedAgo,
  type Snapshot,
  type ViewState,
} from './controller.js';
import { DAY, fakeStore, TABLE } from './fakeStore.js';
import { NAME, PARENT } from './sync.js';

type Store = ReturnType<typeof fakeStore>;

async function imported(store: Store = fakeStore()) {
  const states: ViewState[] = [];
  const controller = createController(store, s => states.push(s));
  await controller.load();
  await controller.choose(PRIMARY);

  return { store, controller, states };
}

const byTitle = (
  controller: Awaited<ReturnType<typeof imported>>['controller'],
  title: string,
) => controller.snapshot().events.find(e => e.title === title)!;

suite('classify and banner: DESIGN.md §5.12', () => {
  const status = (n: number, extra: Record<string, unknown> = {}) =>
    classify(Object.assign(new Error(`Google Calendar returned ${n}`), extra));

  it('maps each provider status to its banner copy and one action', () => {
    expect(banner(status(401), 'Work')).toEqual({
      tone: 'neg',
      role: 'alert',
      title: 'Google access has expired.',
      body: 'Nothing here was changed.',
      action: { label: 'Reconnect', does: 'reconnect' },
    });
    expect(banner(status(403), 'Work')).toMatchObject({
      role: 'alert',
      title: 'Google refused access to Work.',
      body: 'You may have lost access to this calendar. Nothing here was changed.',
    });
    expect(banner(status(404), 'Team offsite')).toMatchObject({
      role: 'status',
      title: 'Calendar Team offsite no longer exists or isn’t shared with you.',
    });
    expect(banner(status(429, { retryAfter: '40' }))).toMatchObject({
      tone: 'warn',
      role: 'status',
      title: 'Google is limiting requests. Retrying in 40 s.',
      action: { label: 'Retry now', does: 'retry' },
    });
    expect(banner(status(503))).toMatchObject({
      tone: 'info',
      title: 'Couldn’t reach Google.',
      action: { label: 'Retry' },
    });
    expect(banner(classify(new Error('Failed to fetch')))).toMatchObject({
      title: 'Couldn’t reach Google.',
    });
    expect(
      banner(
        classify(new Error('Pilot supports at most 25,000 events per scan')),
        'Work',
      ),
    ).toEqual({
      tone: 'warn',
      role: 'status',
      title: 'Work has more than 25,000 events, so the import stopped.',
      body: 'Nothing here was changed.',
    });
  });

  it('reads the status from the adapter message when the error carries none', () => {
    expect(
      classify(
        new Error(
          'Google Calendar returned 401; no checkpoint was advanced. Resolve access/reconnect before retrying.',
        ),
      ),
    ).toMatchObject({ kind: 'reauth', status: 401 });
    expect(classify(new Error('Reconnect Google Calendar.')).kind).toBe(
      'reauth',
    );
    expect(status(429).retryAfter).toBeUndefined();
    expect(status(429, { retryAfter: '12.2' }).retryAfter).toBe(13);
  });

  it('only 401 and 403 are alerts', () => {
    for (const n of [404, 429, 500])
      expect(banner(status(n)).role).toBe('status');
  });
});

suite('pill', () => {
  const at = new Date('2026-09-24T14:16:00Z');
  const base: Snapshot = {
    state: { kind: 'loading' },
    events: [],
    pending: 0,
    stale: false,
  };
  const summary = {
    calendarId: PRIMARY,
    total: 0,
    added: 0,
    updated: 0,
    unchanged: 0,
    skipped: { recurring: 0, cancelled: 0 },
    conflicts: [],
    localOnly: 0,
    invalid: [],
    review: [],
  };

  it('says what state the sync is in, always in words', () => {
    expect(pill(base)).toMatchObject({ text: 'Syncing…', busy: true });
    const ready: Snapshot = {
      ...base,
      state: { kind: 'ready', at, summary, outcomes: [] },
      summary,
      at,
    };
    expect(pill(ready, new Date('2026-09-24T14:20:30Z'))).toEqual({
      text: 'Synced 4 min ago',
      tone: 'muted',
    });
    expect(pill({ ...ready, pending: 3 })).toMatchObject({
      text: '3 to review',
      tone: 'accent',
      opens: 'review',
    });
    const conflicted = {
      ...summary,
      conflicts: [
        { title: 'x', fields: ['title'], kind: 'both' as const },
        { title: 'y', fields: ['title'], kind: 'both' as const },
      ],
    };
    expect(pill({ ...ready, summary: conflicted })).toMatchObject({
      text: '2 conflicts',
      tone: 'warn',
      opens: 'conflicts',
    });
    expect(
      pill({
        ...base,
        state: {
          kind: 'error',
          message: 'x',
          reconnect: true,
          problem: { kind: 'reauth', message: 'x' },
        },
      }),
    ).toMatchObject({ text: 'Reconnect needed', tone: 'neg' });
    expect(
      pill({
        ...base,
        state: {
          kind: 'error',
          message: 'x',
          reconnect: false,
          problem: { kind: 'network', message: 'x' },
        },
      }),
    ).toMatchObject({ text: 'Error', tone: 'neg' });
  });

  it('formats the last sync time', () => {
    expect(syncedAgo(at, at)).toBe('just now');
    expect(syncedAgo(at, new Date(at.getTime() + 59 * 60_000))).toBe(
      '59 min ago',
    );
    expect(syncedAgo(at, new Date(at.getTime() + 3 * 3600_000))).toMatch(
      /^at \d\d:\d\d$/,
    );
  });

  it('counts local edits before a preview has planned them', () => {
    expect(reviewCount({ ...base, pending: 2, stale: true })).toBe(2);
  });
});

suite('controller: views over the rows', () => {
  it('keeps the chosen calendar’s name, colour, access and account on the table', async () => {
    const { controller, store } = await imported();
    expect(controller.snapshot().meta).toEqual({
      summary: 'Synthetic',
      color: '#9fe1e7',
      accessRole: 'owner',
      account: PRIMARY,
    });
    // A new view of the same app does not list calendars again.
    const again = createController(store, () => {});
    await (
      await again.load()
    ).refreshing;
    expect(again.snapshot().meta?.color).toBe('#9fe1e7');
    expect(
      store.calls.filter(c => c.path.endsWith('/calendarList')),
    ).toHaveLength(1);
  });

  it('lists the imported rows as events, with calendar colour and no pending edits', async () => {
    const { controller } = await imported();
    const { events } = controller.snapshot();
    expect(events.map(e => e.title).sort()).toEqual([
      'Calendar all-day fixture',
      'Calendar timed fixture',
    ]);
    expect(events.every(e => !e.pending && !e.conflict && !e.readOnly)).toBe(
      true,
    );
    expect(events[0].calendar).toEqual({ name: 'Synthetic', color: '#9fe1e7' });
  });

  it('a drawer save stores exact strings locally and is sent only after review', async () => {
    const { controller, store } = await imported();
    const timed = byTitle(controller, 'Calendar timed fixture');
    await controller.saveEvent(timed.subject, {
      ...timed,
      location: 'Room 2',
      start: `${DAY}T10:00:00+02:00`,
      end: `${DAY}T11:00:00+02:00`,
    });
    expect(store.google.writes).toEqual([]);
    const snap = controller.snapshot();
    expect(snap.pending).toBe(1);
    expect(snap.stale).toBe(true);
    expect(pill(snap).text).toBe('1 to review');
    const row = store.resources.get(timed.subject)!;
    expect(Object.values(row)).toContain(`${DAY}T10:00:00+02:00`);

    await controller.prepareReview();
    const state = controller.state();
    if (state.kind !== 'ready') throw new Error(state.kind);
    expect(state.summary.review[0].fields).toEqual([
      { field: 'Location', before: 'Room 4', after: 'Room 2' },
      {
        field: 'Start',
        before: `${DAY}T09:30:00+02:00`,
        after: `${DAY}T10:00:00+02:00`,
      },
      {
        field: 'End',
        before: `${DAY}T10:30:00+02:00`,
        after: `${DAY}T11:00:00+02:00`,
      },
    ]);
    expect(controller.snapshot().stale).toBe(false);
    expect(store.google.writes).toEqual([]);
  });

  it('reports per-row progress while sending', async () => {
    const { controller, states } = await imported();
    const timed = byTitle(controller, 'Calendar timed fixture');
    await controller.saveEvent(timed.subject, { ...timed, title: 'New' });
    await controller.prepareReview();
    states.length = 0;
    await controller.send();
    const progress = states
      .filter(s => s.kind === 'sending')
      .map(s => (s.kind === 'sending' ? s.progress : []));
    expect(progress).toEqual([
      [undefined],
      ['sending'],
      [{ status: 'sent', title: 'Calendar timed fixture' }],
    ]);
    const after = controller.state();
    if (after.kind !== 'ready') throw new Error(after.kind);
    expect(after.outcomes).toEqual([
      { status: 'sent', title: 'Calendar timed fixture' },
    ]);
    expect(controller.snapshot().pending).toBe(0);
  });

  it('Discard puts Google’s value back and drops the edit from review', async () => {
    const { controller, store } = await imported();
    const timed = byTitle(controller, 'Calendar timed fixture');
    await controller.saveEvent(timed.subject, { ...timed, title: 'Changed' });
    await controller.prepareReview();
    const state = controller.state();
    if (state.kind !== 'ready') throw new Error(state.kind);
    await controller.discard(state.summary.review[0]);
    expect(store.resources.get(timed.subject)![NAME]).toBe(
      'Calendar timed fixture',
    );
    expect(controller.snapshot().pending).toBe(0);
    const after = controller.state();
    if (after.kind !== 'ready') throw new Error(after.kind);
    expect(after.summary.review).toEqual([]);
    await controller.refresh();
    const again = controller.state();
    if (again.kind !== 'ready') throw new Error(again.kind);
    expect(again.summary.review).toEqual([]);
    expect(store.google.writes).toEqual([]);
  });

  it('a both-changed conflict is resolved per field; "Keep mine" goes to review, not to Google', async () => {
    const { controller, store } = await imported();
    const timed = byTitle(controller, 'Calendar timed fixture');
    await controller.saveEvent(timed.subject, {
      ...timed,
      title: 'Mine',
      location: 'My room',
      description: 'Only here',
    });
    store.google.editRemote('timed', {
      summary: 'Theirs',
      location: 'Their room',
    });
    await controller.refresh();
    const snap = controller.snapshot();
    const [conflict] = snap.summary!.conflicts;
    expect(conflict).toMatchObject({
      kind: 'both',
      fields: ['title', 'location'],
    });
    expect(snap.events.find(e => e.subject === timed.subject)!.conflict).toBe(
      true,
    );

    await expect(
      controller.resolve(conflict, { title: 'mine' }),
    ).rejects.toThrow('Choose a value for location');
    await controller.resolve(conflict, { title: 'mine', location: 'google' });
    expect(controller.snapshot().summary!.conflicts).toEqual([]);
    expect(store.google.writes).toEqual([]);

    await controller.prepareReview();
    const state = controller.state();
    if (state.kind !== 'ready') throw new Error(state.kind);
    expect(state.summary.conflicts).toEqual([]);
    expect(state.summary.review[0].fields).toEqual([
      { field: 'Title', before: 'Theirs', after: 'Mine' },
      { field: 'Description', before: 'Synthetic agenda', after: 'Only here' },
    ]);
    expect(
      controller.snapshot().events.find(e => e.subject === timed.subject)!
        .location,
    ).toBe('Their room');
  });

  it('an event gone from Google can be kept as a local event or removed, only on request', async () => {
    const { controller, store } = await imported();
    store.google.cancel('timed');
    store.google.cancel('all-day');
    await controller.refresh();
    const conflicts = controller.snapshot().summary!.conflicts;
    expect(conflicts.map(c => c.kind)).toEqual([
      'missing-remote',
      'missing-remote',
    ]);
    const rowsBefore = [...store.resources.values()].filter(
      p => p[PARENT] === TABLE,
    ).length;
    expect(rowsBefore).toBe(2);

    const timed = conflicts.find(c => c.id === 'timed')!;
    await controller.keepAsLocal(timed);
    const kept = store.resources.get(timed.subject!)!;
    expect(kept[NAME]).toBe('Calendar timed fixture');
    await controller.removeLocal(conflicts.find(c => c.id === 'all-day')!);
    expect(
      [...store.resources.values()].filter(p => p[PARENT] === TABLE),
    ).toHaveLength(1);

    await controller.refresh();
    const state = controller.state();
    if (state.kind !== 'ready') throw new Error(state.kind);
    expect(state.summary.conflicts).toEqual([]);
    expect(state.summary.localOnly).toBe(1);
  });
});

suite('controller: errors keep what is on screen', () => {
  it('a 401 asks to reconnect and keeps the rows and the last result', async () => {
    const { controller, store } = await imported();
    store.answerNext(401);
    await controller.refresh();
    const state = controller.state();
    if (state.kind !== 'error') throw new Error(state.kind);
    expect(state.problem).toMatchObject({ kind: 'reauth', status: 401 });
    expect(state.summary?.total).toBe(2);
    expect(controller.snapshot().events).toHaveLength(2);
    expect(pill(controller.snapshot()).text).toBe('Reconnect needed');
  });

  it('a 429 carries its retry-after', async () => {
    const { controller, store } = await imported();
    store.answerNext(429, { 'retry-after': '40' });
    await controller.refresh();
    const state = controller.state();
    if (state.kind !== 'error') throw new Error(state.kind);
    expect(state.problem).toMatchObject({
      kind: 'rate-limited',
      status: 429,
      retryAfter: 40,
    });
    expect(banner(state.problem).title).toBe(
      'Google is limiting requests. Retrying in 40 s.',
    );
  });

  it('a 403 on the calendar list is a refusal, not a reconnect', async () => {
    const store = fakeStore();
    const controller = createController(store, () => {});
    store.answerNext(403);
    await controller.load();
    const state = controller.state();
    if (state.kind !== 'error') throw new Error(state.kind);
    expect(state.problem.kind).toBe('forbidden');
  });

  it('a failed fetch is a network problem', async () => {
    const { controller, store } = await imported();
    store.throwNext('Failed to fetch');
    await controller.refresh();
    const state = controller.state();
    if (state.kind !== 'error') throw new Error(state.kind);
    expect(state.problem.kind).toBe('network');
  });

  it('reports each page read while importing', async () => {
    const store = fakeStore();
    const pages: number[] = [];
    const controller = createController(store, s => {
      if (s.kind === 'refreshing' && s.pages) pages.push(s.pages);
    });
    await controller.load();
    await controller.choose(PRIMARY);
    expect(pages).toEqual([1, 2, 3]);
  });

  it('Cancel while connecting returns to the first-run card', async () => {
    const store = fakeStore({ connected: false });
    const controller = createController(store, () => {});
    await controller.load();
    void controller.connect();
    expect(controller.state().kind).toBe('connecting');
    controller.cancelConnect();
    expect(controller.state().kind).toBe('disconnected');
  });
});
