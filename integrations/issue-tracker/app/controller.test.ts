// @wc-ignore-file
import { describe as group, expect, it } from 'vitest';
import { SEEDED_REPOSITORY } from '../fixtures/github-issues/scenario.mjs';
import {
  classify,
  createController,
  describeHeld,
  type ViewState,
} from './controller.js';
import { fakeStore, TABLE, type FakeStore } from './fakeStore.js';
import { ABOUT, DESCRIPTION, NAME, PARENT, SHORTNAME } from './tracker.js';

type Ready = Extract<ViewState, { kind: 'ready' }>;

const ready = (state: ViewState): Ready => {
  if (state.kind !== 'ready')
    throw new Error(`Expected ready, got ${JSON.stringify(state)}`);

  return state;
};

const property = (store: FakeStore, shortname: string) =>
  [...store.resources.entries()].find(
    ([, props]) => props[SHORTNAME] === shortname,
  )![0];

async function bound(store = fakeStore()) {
  const states: ViewState[] = [];
  const controller = createController(store, s => states.push(s));
  await controller.load();
  const state = ready(await controller.choose(SEEDED_REPOSITORY));
  if (state.problem) throw new Error(state.problem.message);

  return { store, controller, state, states };
}

const rowByNumber = (state: Ready, n: number) =>
  state.last!.result.rows.find(r => r.number === n)!;

group('issue-tracker controller: rows for the board', () => {
  it('returns each issue with its body, labels and comments', async () => {
    const { state } = await bound();
    const first = rowByNumber(state, 1);
    expect(first).toMatchObject({
      title: 'Keep the selected calendar after refresh',
      status: 'Todo',
      body: 'Refreshing the page resets the selection to **All calendars**.',
      labels: [{ name: 'bug' }],
      url: `https://github.com/${SEEDED_REPOSITORY}/issues/1`,
    });
    expect(first.updatedAt).toMatch(/^\d{4}-\d\d-\d\dT/);
    expect(first.comments).toEqual([
      expect.objectContaining({
        body: 'I can reproduce this in Firefox.',
        author: 'alice',
      }),
    ]);
    // atomic:doing is the Doing status, not a label chip.
    expect(rowByNumber(state, 2)).toMatchObject({
      status: 'Doing',
      labels: [],
    });
  });
});

group('issue-tracker controller: moving and editing', () => {
  it('moves a card at once, then holds the close for review', async () => {
    const { store, controller, states } = await bound();
    const before = states.length;
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    const done = controller.edit(subject, { status: 'Done' });

    // Optimistic: the next state already shows it in Done, marked touched.
    const shown = ready(states[before]);
    expect(rowByNumber(shown, 1).status).toBe('Done');
    expect(shown.touched).toEqual([subject]);

    const after = ready(await done);
    expect(after.touched).toBeUndefined();
    expect(rowByNumber(after, 1).status).toBe('Done');
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Update #1: status Todo → Done (close it)',
    ]);
    expect(after.last!.result.held[0].local).toBe(subject);
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'open',
    );

    await controller.send();
    expect(store.github.snapshot(SEEDED_REPOSITORY).issues[0].state).toBe(
      'closed',
    );
  });

  it('keeps an edit made during a pass on screen until a pass has seen it', async () => {
    const { controller, states } = await bound();
    const subject = rowByNumber(ready(controller.state()), 2).subject;
    const syncing = controller.sync();
    // Let the pass start before the edit comes in.
    while (ready(controller.state()).busy !== 'syncing')
      await Promise.resolve();
    const editing = controller.edit(subject, { title: 'Renamed mid-pass' });
    await syncing;
    // The pass that was already running did not see it; still shown.
    const between = ready(controller.state());
    expect(rowByNumber(between, 2).title).toBe('Renamed mid-pass');
    expect(between.touched).toEqual([subject]);
    const after = ready(await editing);
    expect(after.touched).toBeUndefined();
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Update #2: title “Export the board as CSV” → “Renamed mid-pass”',
    ]);
    // It never snapped back while waiting.
    const later = states.slice(states.findIndex(s => s === between));
    for (const s of later)
      expect(rowByNumber(ready(s), 2).title).toBe('Renamed mid-pass');
  });

  it('adds a comment as a Message and holds it for review', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 1).subject;
    const after = ready(await controller.comment(subject, 'Fixed on main.'));
    const comments = rowByNumber(after, 1).comments;
    expect(comments.map(c => c.body)).toEqual([
      'I can reproduce this in Firefox.',
      'Fixed on main.',
    ]);
    expect(comments[1].author).toBeUndefined();
    const message = store.resources.get(comments[1].subject)!;
    expect(message).toMatchObject({
      [DESCRIPTION]: 'Fixed on main.',
      [ABOUT]: subject,
    });
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Add a comment on #1: “Fixed on main.”',
    ]);
    expect(after.last!.result.held[0].local).toBe(comments[1].subject);
    await controller.send();
    expect(store.github.snapshot(SEEDED_REPOSITORY).comments).toHaveLength(2);
  });

  it('creates an issue in the table and holds its create for review', async () => {
    const { store, controller } = await bound();
    const { state, subject } = await controller.create({
      title: 'Written in the app',
      body: 'Details',
      status: 'Doing',
    });
    const after = ready(state);
    expect(subject).toBeTruthy();
    expect(store.resources.get(subject!)).toMatchObject({
      [NAME]: 'Written in the app',
      [PARENT]: TABLE,
    });
    const row = after.last!.result.rows.find(r => r.subject === subject)!;
    expect(row).toMatchObject({ status: 'Doing', title: 'Written in the app' });
    expect(row.number).toBeUndefined();
    expect(after.last!.result.held.map(describeHeld)).toEqual([
      'Create issue “Written in the app” (Doing)',
    ]);
  });
});

group('issue-tracker controller: conflict review', () => {
  it('describes each field and applies one side per field', async () => {
    const { store, controller } = await bound();
    const subject = rowByNumber(ready(controller.state()), 2).subject;
    const status = property(store, 'issue-status');
    const done = [...store.resources.entries()].find(
      ([, p]) => p[PARENT] === status && p[SHORTNAME] === 'done',
    )![0];
    store.edit(subject, { [NAME]: 'Here', [status]: [done] });
    store.github.updateIssue(SEEDED_REPOSITORY, 2, {
      title: 'There',
      state: 'closed',
    });
    // Status agrees (both Done), so only the title conflicts.
    const paused = ready(await controller.sync());
    expect(paused.problem).toMatchObject({ kind: 'conflict', fields: ['title'] });
    expect(await controller.conflict()).toEqual([
      {
        field: 'title',
        base: 'Export the board as CSV',
        local: 'Here',
        remote: 'There',
      },
    ]);
    const before = store.calls.filter(c => c.method !== 'GET').length;
    const resolved = ready(await controller.resolve({ title: 'local' }));
    expect(resolved.problem).toBeUndefined();
    expect(await controller.conflict()).toBeUndefined();
    // Keeping this side becomes a held write; nothing was sent.
    expect(store.calls.filter(c => c.method !== 'GET').length).toBe(before);
    expect(resolved.last!.result.held.map(describeHeld)).toEqual([
      'Update #2: title “There” → “Here”',
    ]);
  });
});

group('issue-tracker controller: repository picker', () => {
  it('lists repositories, marks those without issues, and binds the choice', async () => {
    const store = fakeStore();
    const controller = createController(store);
    await controller.load();
    const listed = await controller.listRepositories();
    expect(listed).toMatchObject({
      kind: 'choose-repository',
      listing: {
        kind: 'listed',
        repositories: [
          { fullName: SEEDED_REPOSITORY, hasIssues: true, openIssues: 2 },
          {
            fullName: 'atomic-fixture/no-issues',
            hasIssues: false,
            openIssues: 0,
          },
        ],
      },
    });
    expect(store.calls.at(-1)).toMatchObject({
      path: '/user/repos',
      method: 'GET',
      query: { per_page: '100', page: '1', sort: 'updated' },
    });
    const state = ready(await controller.choose(SEEDED_REPOSITORY));
    expect(state.repository).toBe(SEEDED_REPOSITORY);
    // Stored on the app, found again by a fresh view.
    expect(ready(await createController(store).load()).repository).toBe(
      SEEDED_REPOSITORY,
    );
  });

  it('pages through more than 100 repositories', async () => {
    const store = fakeStore();
    for (let i = 0; i < 120; i++) store.github.snapshot(`many/repo-${i}`);
    const controller = createController(store);
    await controller.load();
    const listed = await controller.listRepositories();
    if (listed.kind !== 'choose-repository' || listed.listing?.kind !== 'listed')
      throw new Error('not listed');
    expect(listed.listing.repositories).toHaveLength(122);
    expect(store.calls.filter(c => c.path === '/user/repos')).toHaveLength(2);
  });

  it('falls back to typing owner/name when the proxy will not list', async () => {
    const store = fakeStore();
    const controller = createController(store);
    await controller.load();
    store.status = 404;
    const state = await controller.listRepositories();
    expect(state).toMatchObject({
      kind: 'choose-repository',
      listing: {
        kind: 'unavailable',
        message: 'GitHub list_repositories returned 404',
      },
    });
    store.status = undefined;
    expect(ready(await controller.choose(SEEDED_REPOSITORY)).problem).toBe(
      undefined,
    );
  });
});

group('issue-tracker controller: view preferences', () => {
  it('keeps the layout and filters on the app, across views', async () => {
    const { store, controller } = await bound();
    expect(controller.prefs()).toEqual({});
    await controller.savePrefs({ layout: 'list', search: 'csv', label: 'bug' });
    const again = createController(store);
    await again.load();
    expect(again.prefs()).toEqual({ layout: 'list', search: 'csv', label: 'bug' });
    // And the sync state next to them is intact.
    expect(ready(await again.sync()).problem).toBeUndefined();
  });
});

group('issue-tracker controller: problems', () => {
  it('names the reason a pass paused, for the banner', () => {
    expect(classify(new Error('Uncertain GitHub write (create_issue).'))).toMatchObject({
      kind: 'paused',
      reason: 'uncertain',
    });
    expect(classify(new Error('Missing remote record: s'))).toMatchObject({
      reason: 'missing',
    });
    expect(
      classify(new Error('Atomic write rejected: did:ad:x')),
    ).toMatchObject({ reason: 'rejected' });
    expect(classify(new Error('Duplicate external identity'))).toMatchObject({
      reason: 'other',
    });
  });
});

group('issue-tracker controller: host calls from pin 007869464', () => {
  it('disconnects this app from GitHub and keeps the table', async () => {
    const { store, controller } = await bound();
    const rows = [...store.resources.values()].filter(p => p[PARENT] === TABLE).length;
    expect((await controller.disconnect()).kind).toBe('not-connected');
    expect(store.disconnected).toEqual(['github-issues']);
    expect([...store.resources.values()].filter(p => p[PARENT] === TABLE)).toHaveLength(rows);
  });

  it('does nothing on a host without proxy.disconnect', async () => {
    const { controller } = await bound(fakeStore({ hostApis: false }));
    expect((await controller.disconnect()).kind).toBe('ready');
  });

  it('reads listed rows in batches with getMany, and one by one without it', async () => {
    const batched = await bound();
    const before = { ...batched.store.counts };
    await batched.controller.sync();
    const withMany = {
      getMany: (batched.store.counts.getMany ?? 0) - (before.getMany ?? 0),
      getResource: batched.store.counts.getResource - before.getResource,
    };

    const single = await bound(fakeStore({ hostApis: false }));
    const start = single.store.counts.getResource;
    await single.controller.sync();
    const oneByOne = single.store.counts.getResource - start;

    expect(withMany.getMany).toBeGreaterThan(0);
    expect(withMany.getResource).toBeLessThan(oneByOne);
    const shape = (c: typeof batched.controller) =>
      ready(c.state())
        .last!.result.rows.map(r => [r.number, r.title, r.status, r.comments.map(x => x.body)])
        .sort();
    expect(shape(batched.controller)).toEqual(shape(single.controller));
group('issue-tracker controller: an issue gone from GitHub (state 13)', () => {
  /** GitHub stops returning issue `n` (deleted or transferred) until `back()`. */
  function hide(store: FakeStore, n: number) {
    const request = store.proxy!.request.bind(store.proxy);
    let hidden = true;
    store.proxy!.request = async r => {
      const own = new RegExp(`/issues/${n}(/|$)`);
      if (hidden && own.test(r.path)) return { status: 404, headers: {}, body: {} };
      const response = await request(r);
      if (hidden && /\/issues$/.test(r.path) && Array.isArray(response.body))
        return {
          ...response,
          body: (response.body as { number: number }[]).filter(i => i.number !== n),
        };

      return response;
    };

    return { back: () => (hidden = false) };
  }

  const writes = (store: FakeStore) =>
    store.calls.filter(c => (c.method ?? 'GET') !== 'GET').length;

  it('keeps it here only, never recreates it, and binds it back when it returns', async () => {
    const { store, controller } = await bound();
    const row = rowByNumber(ready(controller.state()), 1).subject;
    const gh = hide(store, 1);
    const paused = ready(await controller.sync());
    expect(paused.problem).toMatchObject({
      kind: 'paused',
      reason: 'missing',
      missing: { side: 'remote', entity: 'issue', local: row },
    });
    const sent = writes(store);

    const kept = ready(await controller.keepHereOnly());
    expect(kept.problem).toBeUndefined();
    expect(kept.last!.result.held).toEqual([]);
    const here = kept.last!.result.rows.find(r => r.subject === row)!;
    expect(here.number).toBeUndefined();
    expect(store.resources.get(row)?.[property(store, 'github-issue-number')]).toBeUndefined();
    expect(ready(await controller.sync()).last!.result.held).toEqual([]);
    expect(writes(store)).toBe(sent);

    // The same issue shows up on GitHub again: bound back to the same row.
    gh.back();
    const again = ready(await controller.sync());
    expect(again.problem).toBeUndefined();
    const rows = again.last!.result.rows;
    expect(rows).toHaveLength(2);
    expect(rows.find(r => r.subject === row)?.number).toBe(1);
    expect(writes(store)).toBe(sent);
  });

  it('removes it from the board without touching GitHub, and imports it again if it returns', async () => {
    const { store, controller } = await bound();
    const first = rowByNumber(ready(controller.state()), 1);
    const gh = hide(store, 1);
    await controller.sync();
    const sent = writes(store);

    const removed = ready(await controller.removeFromBoard());
    expect(removed.problem).toBeUndefined();
    expect(store.resources.has(first.subject)).toBe(false);
    expect(store.resources.has(first.comments[0].subject)).toBe(false);
    expect(removed.last!.result.rows.map(r => r.number)).toEqual([2]);
    expect(writes(store)).toBe(sent);
    expect(ready(await controller.sync()).problem).toBeUndefined();

    gh.back();
    const again = ready(await controller.sync());
    expect(again.problem).toBeUndefined();
    const back = again.last!.result.rows.find(r => r.number === 1)!;
    expect(back.title).toBe(first.title);
    expect(back.comments.map(c => c.body)).toEqual(['I can reproduce this in Firefox.']);
    expect(again.last!.result.rows).toHaveLength(2);
    expect(writes(store)).toBe(sent);
  });
});
