// @wc-ignore-file
import { describe as suite, expect, it } from 'vitest';
import { PRIMARY, TEAM } from '../fixtures/google-calendar/scenario.mjs';
import { createController, describe, type ViewState } from './controller.js';
import { DAY, fakeStore, ONTOLOGY, ROW_CLASS, TABLE } from './fakeStore.js';
import { listCalendars } from './relay.js';
import {
  DESCRIPTION,
  NAME,
  PARENT,
  PROPERTIES,
  RECOMMENDS,
  SHORTNAME,
} from './sync.js';

type Store = ReturnType<typeof fakeStore>;

/** Property subject by shortname, from the app's ontology. */
function prop(store: Store, shortname: string): string {
  const listed = store.resources.get(ONTOLOGY)![PROPERTIES] as string[];
  const subject = listed.find(
    s => store.resources.get(s)![SHORTNAME] === shortname,
  );
  if (!subject) throw new Error(`no ${shortname} property`);

  return subject;
}

/** Rows by Google event id, as plain field maps. */
function rows(store: Store) {
  const id = prop(store, 'google-event-id');
  const out = new Map<string, Record<string, unknown>>();

  for (const [subject, props] of store.resources)
    if (props[PARENT] === TABLE && typeof props[id] === 'string')
      out.set(props[id] as string, {
        subject,
        title: props[NAME],
        description: props[DESCRIPTION],
        location: props[prop(store, 'location')],
        start: props[prop(store, 'start')],
        end: props[prop(store, 'end')],
        allDay: props[prop(store, 'all-day')],
        day: props[prop(store, 'day')],
        etag: props[prop(store, 'google-etag')],
      });

  return out;
}

/** Edits a row the way the host table would. */
function editRow(
  store: Store,
  eventId: string,
  fields: Record<string, unknown>,
) {
  const subject = rows(store).get(eventId)!.subject as string;
  store.resources.set(subject, { ...store.resources.get(subject)!, ...fields });
}

async function imported(store = fakeStore(), maxPages?: number) {
  const states: ViewState[] = [];
  const controller = createController(
    store,
    s => states.push(s),
    maxPages ? { maxPages } : {},
  );
  await controller.load();
  expect(controller.state().kind).toBe('choosing');
  await controller.choose(PRIMARY);

  return { store, controller, states };
}

const ready = (state: ViewState) => {
  if (state.kind !== 'ready') throw new Error(describe(state));

  return state;
};

suite('Calendar drive app: supported path', () => {
  it('without the relay or a connection, fetches nothing', async () => {
    for (const [options, kind] of [
      [{ relay: false }, 'no-relay'],
      [{ connected: false }, 'disconnected'],
    ] as const) {
      const store = fakeStore(options);
      const controller = createController(store, () => {});
      await controller.load();
      expect(controller.state().kind).toBe(kind);
      expect(store.calls).toEqual([]);
    }
  });

  it('lists calendars through the relay, never naming a credential', async () => {
    const store = fakeStore();
    expect(await listCalendars(store.proxy!, 'c1')).toEqual([
      {
        id: PRIMARY,
        summary: 'Synthetic',
        primary: true,
        accessRole: 'owner',
        backgroundColor: '#9fe1e7',
      },
      {
        id: TEAM,
        summary: 'Team',
        primary: false,
        accessRole: 'reader',
        backgroundColor: '#f691b2',
      },
    ]);
    expect(store.calls).toEqual([
      {
        platform: 'google-calendar',
        connectionId: 'c1',
        path: '/calendar/v3/users/me/calendarList',
        method: 'GET',
        query: { maxResults: '250' },
      },
    ]);
  });

  it('imports all-day and timed events of the chosen calendar only, skipping recurring and cancelled', async () => {
    const { store, controller } = await imported();
    const state = ready(controller.state());
    expect(state.summary).toMatchObject({
      calendarId: PRIMARY,
      total: 2,
      added: 2,
      updated: 0,
      unchanged: 0,
      skipped: { recurring: 2, cancelled: 1 },
      conflicts: [],
      review: [],
    });
    expect(describe(state)).toContain(
      'Not imported: 2 recurring, 1 cancelled.',
    );

    const byId = rows(store);
    expect([...byId.keys()].sort()).toEqual(['all-day', 'timed']);
    expect(byId.get('all-day')).toMatchObject({
      title: 'Calendar all-day fixture',
      description: '',
      location: '',
      start: DAY,
      end: '2026-09-25',
      allDay: true,
      day: DAY,
    });
    // Exact strings, offset kept, never re-serialised through a Date.
    expect(byId.get('timed')).toMatchObject({
      title: 'Calendar timed fixture',
      description: 'Synthetic agenda',
      location: 'Room 4',
      start: `${DAY}T09:30:00+02:00`,
      end: `${DAY}T10:30:00+02:00`,
      allDay: false,
      day: DAY,
    });
    expect(store.resources.get(TABLE)![NAME]).toBe('Synthetic');
    expect(store.resources.get(TABLE)![prop(store, 'google-calendar-id')]).toBe(
      PRIMARY,
    );
    const klass = store.resources.get(ROW_CLASS)!;
    expect(klass[NAME]).toBe('Event');
    expect(klass[RECOMMENDS]).toEqual([
      NAME,
      DESCRIPTION,
      ...['location', 'start', 'end', 'all-day', 'day'].map(s =>
        prop(store, s),
      ),
    ]);

    // Paged (2 per page), full scan with tombstones, one calendar only.
    const lists = store.calls.filter(c => c.path.endsWith('/events'));
    expect(lists.map(c => c.path)).toEqual(
      Array(3).fill(
        `/calendar/v3/calendars/${encodeURIComponent(PRIMARY)}/events`,
      ),
    );
    expect(lists.map(c => c.query?.pageToken)).toEqual([undefined, '2', '4']);
    expect(lists[0].query).toMatchObject({
      singleEvents: 'false',
      showDeleted: 'true',
      maxResults: '250',
    });
    expect(
      store.calls.every(
        c => !JSON.stringify(c).match(/secret:|authorization|bearer/i),
      ),
    ).toBe(true);
  });

  it('a refresh brings in Google edits and leaves unchanged rows alone', async () => {
    const { store, controller } = await imported();
    store.google.editRemote('timed', { location: 'Room 2' });
    const saves = store.writes.length;
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary).toMatchObject({ added: 0, updated: 1, unchanged: 1 });
    expect(rows(store).get('timed')!.location).toBe('Room 2');
    // One save for the updated row; the unchanged row is not rewritten.
    expect(store.writes.slice(saves).map(w => w.op)).toEqual(['save']);
    await controller.refresh();
    expect(ready(controller.state()).summary).toMatchObject({
      updated: 0,
      unchanged: 2,
    });
  });

  it('previews a local edit as a minimal patch and sends it only on approval, with If-Match', async () => {
    const { store, controller } = await imported();
    const etag = rows(store).get('timed')!.etag;
    editRow(store, 'timed', { [NAME]: 'Renamed here' });
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.review).toEqual([
      expect.objectContaining({
        etag,
        title: 'Calendar timed fixture',
        fields: [
          {
            field: 'Title',
            before: 'Calendar timed fixture',
            after: 'Renamed here',
          },
        ],
      }),
    ]);
    // A preview writes nothing to Google.
    expect(store.google.writes).toEqual([]);
    expect(store.calls.some(c => c.method === 'PATCH')).toBe(false);

    await controller.send();
    const sent = ready(controller.state());
    expect(sent.outcomes).toEqual([
      { status: 'sent', title: 'Calendar timed fixture' },
    ]);
    expect(store.google.writes).toEqual([
      { id: 'timed', patch: { summary: 'Renamed here' }, ifMatch: etag },
    ]);
    const patch = store.calls.find(c => c.method === 'PATCH')!;
    expect(patch).toMatchObject({
      path: '/calendar/v3/calendars/synthetic%40example.com/events/timed',
      query: { sendUpdates: 'none' },
      ifMatch: etag,
      body: JSON.stringify({ summary: 'Renamed here' }),
    });
    expect(rows(store).get('timed')!.etag).not.toBe(etag);

    await controller.refresh();
    expect(ready(controller.state()).summary).toMatchObject({
      review: [],
      conflicts: [],
      unchanged: 2,
    });
  });

  it('an edit made in Google after the preview fails the write with 412 and is reviewed again', async () => {
    const { store, controller } = await imported();
    editRow(store, 'timed', { [NAME]: 'Renamed here' });
    await controller.refresh();
    store.google.editRemote('timed', { location: 'Room 9' });
    await controller.send();
    expect(ready(controller.state()).outcomes).toEqual([
      { status: 'stale', title: 'Calendar timed fixture' },
    ]);
    expect(store.google.writes).toEqual([]);
    expect(store.google.events.find(e => e.id === 'timed')).toMatchObject({
      summary: 'Calendar timed fixture',
      location: 'Room 9',
    });

    // Different fields: no conflict. The new preview carries the new ETag.
    await controller.refresh();
    const again = ready(controller.state());
    expect(again.summary.conflicts).toEqual([]);
    expect(rows(store).get('timed')).toMatchObject({
      title: 'Renamed here',
      location: 'Room 9',
    });
    expect(again.summary.review[0].fields.map(f => f.field)).toEqual(['Title']);
    await controller.send();
    expect(ready(controller.state()).outcomes[0].status).toBe('sent');
    expect(store.google.writes).toEqual([
      expect.objectContaining({ patch: { summary: 'Renamed here' } }),
    ]);
  });

  it('the same field changed on both sides is a conflict; neither side is overwritten', async () => {
    const { store, controller } = await imported();
    editRow(store, 'timed', { [NAME]: 'Here' });
    store.google.editRemote('timed', { summary: 'There' });
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.conflicts).toEqual([
      expect.objectContaining({
        id: 'timed',
        title: 'Here',
        fields: ['title'],
        kind: 'both',
        local: expect.objectContaining({ title: 'Here' }),
        remote: expect.objectContaining({ title: 'There' }),
        base: expect.objectContaining({ title: 'Calendar timed fixture' }),
        etag: expect.stringMatching(/^"v\d+"$/),
      }),
    ]);
    expect(state.summary.review).toEqual([]);
    expect(rows(store).get('timed')!.title).toBe('Here');
    expect(store.google.writes).toEqual([]);
  });

  it('a lost write response is reported as unknown, stops the batch, and the next preview shows what Google has', async () => {
    const { store, controller } = await imported();
    editRow(store, 'all-day', { [NAME]: 'All-day here' });
    editRow(store, 'timed', { [NAME]: 'Timed here' });
    await controller.refresh();
    expect(ready(controller.state()).summary.review).toHaveLength(2);
    store.loseNextWriteResponse();
    await controller.send();
    const failed = controller.state();
    if (failed.kind !== 'error') throw new Error(failed.kind);
    expect(failed.message).toMatch(/may or may not have applied/);
    expect(failed.outcomes?.map(o => o.status)).toEqual([
      'uncertain',
      'not-sent',
    ]);
    // Google did apply the first; the second was never dispatched.
    expect(store.google.writes.map(w => w.id)).toEqual(['all-day']);

    // Nothing was spent (no connection codes since #54 phase 2): the same
    // connection previews again straight away.
    await controller.refresh();
    const after = ready(controller.state());
    // Google has the first change: it now agrees, nothing to send for it.
    expect(after.summary.conflicts).toEqual([]);
    expect(after.summary.review.map(r => r.edit.id)).toEqual(['timed']);
    expect(store.calls.at(-1)!.connectionId).toBe('c1');
  });

  it('a delegation revoked at the proxy asks to connect again', async () => {
    const { store, controller } = await imported();
    store.revoke('c1');
    await controller.refresh();
    expect(controller.state()).toMatchObject({
      kind: 'error',
      reconnect: true,
    });
    store.reconnect();
    await (
      await controller.load()
    ).refreshing;
    ready(controller.state());
    expect(store.calls.at(-1)!.connectionId).toBe('c2');
  });

  it('an imported event cancelled in Google is a conflict, never a local deletion', async () => {
    const { store, controller } = await imported();
    store.google.cancel('timed');
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.conflicts).toEqual([
      {
        subject: rows(store).get('timed')!.subject,
        id: 'timed',
        title: 'Calendar timed fixture',
        kind: 'missing-remote',
        fields: [
          'Event cancelled, recurring or inaccessible; no deletion inferred',
        ],
      },
    ]);
    expect(state.summary.skipped.cancelled).toBe(2);
    expect(rows(store).has('timed')).toBe(true);
  });

  it('rows made here and invalid local edits are reported, not sent', async () => {
    const { store, controller } = await imported();
    await store.newResource({
      parent: TABLE,
      isA: [ROW_CLASS],
      propVals: { [NAME]: 'Made here' },
    });
    editRow(store, 'timed', { [NAME]: '  ' });
    store.google.editRemote('timed', { location: 'Room 7' });
    await controller.refresh();
    const state = ready(controller.state());
    expect(state.summary.localOnly).toBe(1);
    expect(state.summary.invalid).toEqual([
      { title: '  ', reason: 'the title is empty' },
    ]);
    expect(state.summary.review).toEqual([]);
    // Held back entirely: the Google edit does not overwrite the row either.
    expect(rows(store).get('timed')!.location).toBe('Room 4');
    expect(describe(state)).toContain('creating events isn’t supported');
  });

  it('the import is bounded: past the page cap it fails and writes nothing', async () => {
    const store = fakeStore();
    const controller = createController(store, () => {}, { maxPages: 1 });
    await controller.load();
    await controller.choose(PRIMARY);
    expect(controller.state()).toMatchObject({
      kind: 'error',
      message: 'Pilot supports at most 250 events per scan',
    });
    expect(
      [...store.resources.values()].filter(p => p[PARENT] === TABLE),
    ).toEqual([]);
  });

  it('a chosen calendar is remembered on the table', async () => {
    const { store } = await imported();
    const controller = createController(store, () => {});
    const { refreshing } = await controller.load();
    await refreshing;
    expect(ready(controller.state()).summary.calendarId).toBe(PRIMARY);
    expect(
      store.calls.filter(c => c.path.endsWith('/calendarList')),
    ).toHaveLength(1);
  });
});
