// @vitest-environment jsdom
// @wc-ignore-file
/**
 * The drive app's view end to end in jsdom, against the in-memory host
 * (`fakeStore.ts`) and the same GitHub fixture the mock proxy serves.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { SEEDED_REPOSITORY } from '../fixtures/github-issues/scenario.mjs';
import { createController } from './controller.js';
import { fakeStore, type FakeStore } from './fakeStore.js';
import { view } from './main.js';

const wait = (ms = 0) => new Promise(r => setTimeout(r, ms));

async function mount({
  width = 1180,
  store = fakeStore(),
  bind = true,
}: { width?: number; store?: FakeStore; bind?: boolean } = {}) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  root.getBoundingClientRect = () => ({ width, height: 800 }) as DOMRect;

  if (bind) {
    const c = createController(store);
    await c.load();
    await c.choose(SEEDED_REPOSITORY);
  }

  await view({ root, store });
  await settle(root);

  return { root, store };
}

/** Until no pass runs and queued work has had a chance to start. */
async function settle(root: HTMLElement) {
  for (let i = 0; i < 400; i++) {
    await wait(5);
    if (!root.querySelector('.pl-pill[data-state=syncing]') && i > 3) return;
  }
}

const q = <T extends HTMLElement = HTMLElement>(root: HTMLElement, sel: string) =>
  root.querySelector<T>(sel)!;

const cardOf = (root: HTMLElement, ref: string) =>
  [...root.querySelectorAll<HTMLElement>('[data-issue]')].find(
    el => el.querySelector('.ref')?.textContent === ref,
  )!;

const columnOf = (root: HTMLElement, ref: string) =>
  cardOf(root, ref).closest<HTMLElement>('[data-status]')?.dataset.status;

const key = (target: EventTarget, k: string) =>
  target.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

const openIssues = (store: FakeStore) =>
  store.github.snapshot(SEEDED_REPOSITORY).issues.map((i: { state: string }) => i.state);

afterEach(() => document.body.replaceChildren());

describe('first run', () => {
  it('says the host cannot relay, with no button', async () => {
    const { root } = await mount({ store: fakeStore({ relay: false }), bind: false });
    expect(root.textContent).toContain('This Atomic Server can’t reach GitHub or Jira for apps.');
    expect(root.querySelectorAll('.pl-empty button')).toHaveLength(0);
  });

  it('offers GitHub, and Jira and Todoist as not available', async () => {
    const { root } = await mount({ store: fakeStore({ connected: false }), bind: false });
    expect(q(root, 'h1').textContent).toBe('GitHub Issues');
    expect(q(root, '[role=status]').textContent).toBe('Not connected');
    const connect = q<HTMLButtonElement>(root, '[aria-label="Connect GitHub Issues"]');
    expect(connect.disabled).toBe(false);
    const rows = [...root.querySelectorAll('.src')];
    expect(rows.map(r => r.classList.contains('disabled'))).toEqual([false, true, true]);
    expect(rows[1].textContent).toContain('Not available on this server yet');
  });

  it('lists repositories to pick from and imports the chosen one', async () => {
    const { root, store } = await mount({ bind: false, width: 720 });
    expect(root.textContent).toContain('Which repository?');
    const disabled = q<HTMLInputElement>(root, 'input[value="atomic-fixture/no-issues"]');
    expect(disabled.disabled).toBe(true);
    const pick = q<HTMLInputElement>(root, `input[value="${SEEDED_REPOSITORY}"]`);
    pick.checked = true;
    pick.dispatchEvent(new Event('change'));
    const go = q<HTMLButtonElement>(root, '[data-key=import]');
    expect(go.textContent).toBe(`Import ${SEEDED_REPOSITORY}`);
    go.click();
    await settle(root);
    expect(root.querySelectorAll('[data-issue]')).toHaveLength(2);
    expect(store.calls.some(c => c.path === '/user/repos')).toBe(true);
  });
});

describe('board and list', () => {
  it('defaults to the board at 1000 px and the list at 380 px', async () => {
    expect((await mount({ width: 1180 })).root.querySelector('.board')).not.toBeNull();
    const narrow = await mount({ width: 380 });
    expect(narrow.root.querySelector('.board')).toBeNull();
    expect(narrow.root.querySelector('.list')).not.toBeNull();
  });

  it('moves a focused card with a number key, announces it, and holds the close', async () => {
    const { root, store } = await mount();
    expect(columnOf(root, '#1')).toBe('Todo');
    const card = cardOf(root, '#1');
    card.focus();
    key(card, '3');
    expect(columnOf(root, '#1')).toBe('Done');
    await wait(40);
    expect(q(root, '[aria-live=polite]').textContent).toBe('Moved #1 to Done');
    await settle(root);
    expect(cardOf(root, '#1').querySelector('.sync-mark.waiting')).not.toBeNull();
    expect(root.textContent).toContain('1 change waiting to send');
    expect(openIssues(store)).toEqual(['open', 'open']);
  });

  it('moves a card from its "Move to…" menu', async () => {
    const { root } = await mount();
    q(root, `[data-key="cardmenu:${cardOf(root, '#2').dataset.issue}"]`).click();
    const todo = [...root.querySelectorAll<HTMLButtonElement>('[role=menu] button')].find(
      b => b.textContent === 'Todo',
    )!;
    todo.click();
    expect(columnOf(root, '#2')).toBe('Todo');
    await settle(root);
    expect(columnOf(root, '#2')).toBe('Todo');
  });

  it('sends held changes only from the review panel', async () => {
    const { root, store } = await mount();
    const card = cardOf(root, '#1');
    card.focus();
    key(card, '3');
    await settle(root);
    q(root, '[data-key=review]').click();
    const panel = q(root, '[aria-label="Changes to send to GitHub"]');
    expect(panel.textContent).toContain('Update #1: status Todo → Done (close it)');
    q(root, '[data-key=send]').click();
    await settle(root);
    expect(openIssues(store)).toEqual(['closed', 'open']);
  });

  it('does not run shortcuts while a text field has focus', async () => {
    const { root } = await mount();
    const search = q<HTMLInputElement>(root, '[data-key=search]');
    search.focus();
    key(search, 'b');
    key(search, 'n');
    expect(root.querySelector('.board')).not.toBeNull();
    expect(root.querySelector('.detail')).toBeNull();
    key(document.body, 'b');
    expect(root.querySelector('.list')).not.toBeNull();
  });

  it('tells an empty repository from filters that hide everything', async () => {
    const store = fakeStore();
    const c = createController(store);
    await c.load();
    await c.choose('atomic-fixture/empty');
    const empty = await mount({ store, bind: false });
    expect(empty.root.textContent).toContain('No issues in atomic-fixture/empty yet.');
    expect(q(empty.root, '[data-key=empty-new]').textContent).toBe('New issue');

    const { root } = await mount();
    const search = q<HTMLInputElement>(root, '[data-key=search]');
    search.value = 'nothing like this';
    search.dispatchEvent(new Event('input'));
    expect(root.textContent).toContain('No issues match “nothing like this”.');
    expect(root.textContent).toContain('2 issues are hidden by these filters.');
    q(root, '[data-key=clear-filters]').click();
    expect(root.querySelectorAll('[data-issue]')).toHaveLength(2);
  });

  it('keeps the layout and filters for the next view of this app', async () => {
    const { root, store } = await mount();
    key(document.body, 'b');
    const search = q<HTMLInputElement>(root, '[data-key=search]');
    search.value = 'csv';
    search.dispatchEvent(new Event('input'));
    await wait(900);
    await settle(root);
    const again = await mount({ store, bind: false });
    expect(again.root.querySelector('.list')).not.toBeNull();
    expect(q<HTMLInputElement>(again.root, '[data-key=search]').value).toBe('csv');
    expect(again.root.querySelectorAll('[data-issue]')).toHaveLength(1);
  });
});

describe('issue detail', () => {
  it('opens docked, saves the title on Enter and reverts on Esc', async () => {
    const { root } = await mount();
    cardOf(root, '#2').click();
    const title = q<HTMLTextAreaElement>(root, '.detail.docked [data-key=detail-title]');
    expect(title.value).toBe('Export the board as CSV');

    title.value = 'Scratch that';
    title.dispatchEvent(new Event('input'));
    key(title, 'Escape');
    expect(q<HTMLTextAreaElement>(root, '[data-key=detail-title]').value).toBe(
      'Export the board as CSV',
    );
    expect(root.querySelector('.detail')).not.toBeNull();

    const again = q<HTMLTextAreaElement>(root, '[data-key=detail-title]');
    again.value = 'Export as CSV and JSON';
    again.dispatchEvent(new Event('input'));
    key(again, 'Enter');
    await settle(root);
    expect(cardOf(root, '#2').textContent).toContain('Export as CSV and JSON');
    expect(root.textContent).toContain('1 change waiting to send');
  });

  it('changes status from the segmented control', async () => {
    const { root } = await mount();
    cardOf(root, '#1').click();
    const doing = [...root.querySelectorAll<HTMLButtonElement>('.detail [role=radio]')].find(
      b => b.textContent === 'Doing',
    )!;
    doing.click();
    expect(columnOf(root, '#1')).toBe('Doing');
    await settle(root);
    expect(
      q(root, '.detail [role=radio][aria-checked=true]').textContent,
    ).toBe('Doing');
  });

  it('adds a comment that shows as waiting to send', async () => {
    const { root } = await mount();
    cardOf(root, '#1').click();
    const composer = q<HTMLTextAreaElement>(root, '[data-key=composer]');
    composer.value = 'Fixed on main.';
    composer.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(root, '[data-key=comment]').click();
    await settle(root);
    const comments = [...root.querySelectorAll('.detail .comments li')];
    expect(comments).toHaveLength(2);
    expect(comments[0].textContent).toContain('alice on GitHub');
    expect(comments[1].classList.contains('pending')).toBe(true);
    expect(comments[1].textContent).toContain('Waiting to send');
    expect(q<HTMLTextAreaElement>(root, '[data-key=composer]').value).toBe('');
  });

  it('creates an issue from New issue (N) and shows it as not on GitHub yet', async () => {
    const { root } = await mount();
    key(document.body, 'n');
    const title = q<HTMLTextAreaElement>(root, '[data-key=new-title]');
    title.value = 'Written in the app';
    title.dispatchEvent(new Event('input'));
    q<HTMLButtonElement>(root, '[data-key=create]').click();
    await settle(root);
    expect(q(root, '.detail').dataset.panel).toBe('issue');
    expect(q(root, '.detail .d-foot').textContent).toContain('not on GitHub yet');
    expect(cardOf(root, 'New').textContent).toContain('Written in the app');
    expect(root.textContent).toContain('1 change waiting to send');
  });

  it('returns focus to the card that opened it', async () => {
    const { root } = await mount({ width: 800 });
    const card = cardOf(root, '#2');
    card.focus();
    card.click();
    expect(q(root, '.detail.drawer').getAttribute('role')).toBe('dialog');
    key(document.activeElement ?? document.body, 'Escape');
    expect(root.querySelector('.detail')).toBeNull();
    expect(document.activeElement).toBe(cardOf(root, '#2'));
  });

  it('renders Markdown as elements, never raw HTML', async () => {
    const store = fakeStore();
    store.github.updateIssue(SEEDED_REPOSITORY, 2, {
      body: '**bold** <img src=x onerror=alert(1)> [ok](https://example.com) [bad](javascript:alert(1))',
    });
    const { root } = await mount({ store });
    cardOf(root, '#2').click();
    const md = q(root, '.detail .md');
    expect(md.querySelector('strong')?.textContent).toBe('bold');
    expect(md.querySelector('img')).toBeNull();
    expect(md.textContent).toContain('<img src=x onerror=alert(1)>');
    expect([...md.querySelectorAll('a')].map(a => a.getAttribute('href'))).toEqual([
      'https://example.com',
    ]);
  });
});

describe('sync problems', () => {
  it('raises an alert only for a banner a sync raised while the view was open', async () => {
    const store = fakeStore();
    const c = createController(store);
    await c.load();
    await c.choose(SEEDED_REPOSITORY);
    store.status = 401;
    const { root } = await mount({ store, bind: false });
    const onLoad = q(root, '.pl-banner');
    expect(onLoad.textContent).toContain('GitHub no longer accepts this connection.');
    expect(onLoad.getAttribute('role')).toBeNull();
    expect(q(root, '.pl-pill').dataset.state).toBe('reauth');
    // The board still shows the table while paused.
    expect(root.querySelectorAll('[data-issue]')).toHaveLength(2);

    store.status = undefined;
    q(root, '[data-key=sync-now]').click();
    await settle(root);
    expect(root.querySelector('.pl-banner')).toBeNull();
    store.status = 401;
    q(root, '[data-key=sync-now]').click();
    await settle(root);
    expect(q(root, '.pl-banner').getAttribute('role')).toBe('alert');
  });

  it('shows a transient failure on the pill only, with Retry now', async () => {
    const { root, store } = await mount();
    store.status = 502;
    q(root, '[data-key=sync-now]').click();
    await settle(root);
    expect(root.querySelector('.pl-banner')).toBeNull();
    const pill = q(root, '.pl-pill');
    expect(pill.dataset.state).toBe('error');
    expect(pill.textContent).toMatch(/^Sync failed · retrying in 4 min$/);
    pill.click();
    store.status = undefined;
    [...root.querySelectorAll<HTMLButtonElement>('.popover button')][0].click();
    await settle(root);
    expect(q(root, '.pl-pill').dataset.state).toBe('synced');
  });

  it('keeps Apply disabled until every conflicting field has a side', async () => {
    const { root, store } = await mount();
    const subject = cardOf(root, '#2').dataset.issue!;
    store.edit(subject, { 'https://atomicdata.dev/properties/name': 'Here' });
    store.github.updateIssue(SEEDED_REPOSITORY, 2, { title: 'There' });
    q(root, '[data-key=sync-now]').click();
    await settle(root);
    expect(cardOf(root, '#2').querySelector('.sync-mark.conflict')).not.toBeNull();
    q(root, '[data-key=banner-action]').click();
    await settle(root);
    const apply = () => q<HTMLButtonElement>(root, '[data-key=apply]');
    expect(apply().disabled).toBe(true);
    expect(root.textContent).toContain('Choose Title first');
    const remote = q<HTMLInputElement>(root, '[data-key="cf:title:remote"]');
    remote.checked = true;
    remote.dispatchEvent(new Event('change'));
    expect(apply().disabled).toBe(false);
    apply().click();
    await settle(root);
    expect(root.querySelector('.pl-banner')).toBeNull();
    expect(cardOf(root, '#2').textContent).toContain('There');
  });
});
