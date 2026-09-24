// @wc-ignore-file
// @vitest-environment jsdom
/**
 * The designed views (#89) in a DOM, against the fake store: what each
 * screen says, what each control is called, and that nothing reaches Google
 * except from the Review sheet's Send button.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TEAM } from '../fixtures/google-calendar/scenario.mjs';
import { fakeStore, TABLE } from './fakeStore.js';
import { conflicts } from './sheets.js';
import { view } from './main.js';

type Store = ReturnType<typeof fakeStore>;

const NAME = 'https://atomicdata.dev/properties/name';
const tick = () => new Promise(r => setTimeout(r, 0));

async function settle(times = 4) {
  for (let i = 0; i < times; i++) await tick();
}

async function mount(store: Store = fakeStore(), width = 1120) {
  const root = document.createElement('div');
  document.body.replaceChildren(root);
  Object.defineProperty(root, 'clientWidth', {
    value: width,
    configurable: true,
  });
  await view({ root, store });
  await settle();

  return root;
}

const IMPLICIT: Record<string, string> = {
  button: 'button',
  heading: 'h1,h2,h3',
  radio: 'input[type=radio]',
  checkbox: 'input[type=checkbox]',
  region: 'section[aria-label]',
  complementary: 'aside',
};

/** Elements by role and accessible name, roughly the way a test runner would. */
function byRole(root: ParentNode, role: string, name?: string | RegExp) {
  const selector = `[role="${role}"]${IMPLICIT[role] ? `,${IMPLICIT[role]}` : ''}`;

  return [...root.querySelectorAll<HTMLElement>(selector)].filter(node => {
    if (
      IMPLICIT[role] &&
      node.getAttribute('role') &&
      node.getAttribute('role') !== role
    )
      return false;
    if (name === undefined) return true;
    const label =
      node.getAttribute('aria-label') ??
      node.closest('label')?.textContent ??
      node.textContent ??
      '';

    return typeof name === 'string' ? label.trim() === name : name.test(label);
  });
}

function one(root: ParentNode, role: string, name?: string | RegExp) {
  const found = byRole(root, role, name);
  if (found.length !== 1)
    throw new Error(
      `expected one ${role} named ${String(name)}, found ${found.length}`,
    );

  return found[0];
}

async function click(node: HTMLElement, times = 4) {
  node.click();
  await settle(times);
}

async function chosen(width = 1120, store = fakeStore()) {
  const root = await mount(store, width);
  await click(one(root, 'button', 'Import this calendar'), 10);

  return { root, store };
}

const rowWith = (store: Store, title: string) =>
  [...store.resources.entries()].find(([, p]) => p[NAME] === title)!;

const key = (k: string) =>
  document.body.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true }),
  );

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-09-24T12:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('Calendar views: before there is a calendar', () => {
  it('5.1: without the relay, says so and offers nothing to press', async () => {
    const root = await mount(fakeStore({ relay: false }));
    expect(one(root, 'heading', /can’t be reached/)).toBeTruthy();
    expect(byRole(root, 'button')).toEqual([]);
  });

  it('5.2 and 5.3: one Connect, other providers not available yet, Cancel returns', async () => {
    const store = fakeStore({ connected: false });
    const root = await mount(store);
    expect(root.textContent).toContain(
      'Nothing is sent to Google until you review it.',
    );
    expect(root.textContent).toMatch(/Outlook Calendar\s*Not available yet/);
    expect(root.textContent).toMatch(/Apple Calendar\s*Not available yet/);
    await click(one(root, 'button', 'Connect Google Calendar'));
    expect(root.textContent).toContain(
      'Confirm the connection in the bar above',
    );
    await click(one(root, 'button', 'Cancel'));
    expect(one(root, 'button', 'Connect Google Calendar')).toBeTruthy();
    expect(store.calls).toEqual([]);
  });

  it('5.4: lists calendars with the primary preselected and read-only ones tagged', async () => {
    const root = await mount();
    const form = one(root, 'form', 'Choose a calendar');
    const radios = byRole(form, 'radio') as HTMLInputElement[];
    expect(radios.map(r => r.checked)).toEqual([true, false]);
    expect(radios[1].closest('label')!.textContent).toContain('Read-only');
    expect(form.textContent).toContain('Recurring events aren’t imported yet.');
  });
});

describe('Calendar views: agenda and week', () => {
  it('5.8: agenda rows are buttons with a complete accessible name', async () => {
    const { root } = await chosen(360);
    const today = one(root, 'region', /^Thursday 24/);
    expect(today.querySelector('h3')!.textContent).toMatch(/^Today/);
    expect(
      byRole(today, 'button').map(r => r.getAttribute('aria-label')),
    ).toEqual([
      'Calendar all-day fixture, All day, Synthetic calendar',
      expect.stringMatching(
        /^Calendar timed fixture, \d\d:\d\d to \d\d:\d\d, Room 4, Synthetic calendar$/,
      ),
    ]);
    expect(one(root, 'group', 'Days of this week')).toBeTruthy();
  });

  it('5.7: week columns are labelled sections with lists of event buttons', async () => {
    const { root } = await chosen(1120);
    expect(root.querySelector('.wk button')!.textContent).toBe(
      'Switch to agenda view',
    );
    const thursday = one(root, 'region', 'Thursday 24 September');
    expect(
      [...thursday.querySelectorAll('ul > li > button')].map(b =>
        b.getAttribute('aria-label'),
      ),
    ).toEqual([expect.stringMatching(/^Calendar timed fixture, /)]);
    expect(one(root, 'group', 'All-day events').textContent).toContain(
      'Calendar all-day fixture',
    );
    // Sidebar at 900px and wider, with what was not imported.
    expect(one(root, 'complementary', 'Calendars').textContent).toContain(
      '2 recurring events and 1 cancelled event aren’t imported yet.',
    );
  });

  it('switches view with the segmented control and the keyboard', async () => {
    const { root } = await chosen(1120);
    await click(one(root, 'button', 'Agenda'));
    expect(root.querySelector('.agenda')).toBeTruthy();
    key('w');
    await settle();
    expect(root.querySelector('.wk')).toBeTruthy();
    key('?');
    await settle();
    expect(one(root, 'dialog').textContent).toContain('Keyboard shortcuts');
    key('Escape');
    await settle();
    expect(byRole(root, 'dialog')).toEqual([]);
  });
});

describe('Calendar views: edit, review, send', () => {
  it('5.9: edits five fields locally, validates like the adapter, sends nothing', async () => {
    const { root, store } = await chosen(1120);
    await click(one(root, 'button', /^Calendar timed fixture, /));
    const drawer = one(root, 'dialog');
    expect(drawer.textContent).toContain(
      'Guests, reminders and video links are edited in Google Calendar.',
    );
    await click(one(drawer, 'button', 'Edit'));
    const form = one(root, 'dialog');
    const field = (k: string) =>
      form.querySelector<HTMLInputElement>(`[data-key="f-${k}"]`)!;

    const type = async (k: string, value: string) => {
      field(k).value = value;
      field(k).dispatchEvent(new Event('input'));
      await settle();
    };

    await type('title', '  ');
    expect(form.textContent).toContain('Add a title');
    await type('title', 'Renamed in the drawer');
    const start = field('startTime').value;
    await type('endTime', '00:00');
    expect(form.textContent).toContain('End must be after start');
    expect(
      form.querySelector<HTMLButtonElement>('[data-key="drawer-save"]')!
        .disabled,
    ).toBe(true);
    await type(
      'endTime',
      start.replace(/^\d\d/, h => String(Number(h) + 2).padStart(2, '0')),
    );
    await click(
      form.querySelector<HTMLElement>('[data-key="drawer-save"]')!,
      8,
    );
    expect(one(root, 'dialog').textContent).toContain(
      'Saved here · not sent to Google yet',
    );
    expect(store.google.writes).toEqual([]);
    const [, saved] = rowWith(store, 'Renamed in the drawer');
    // Offset-qualified strings, never numbers or Dates.
    expect(
      Object.values(saved).filter(
        v => typeof v === 'string' && /T\d\d:\d\d:00[+-]\d\d:\d\d$/.test(v),
      ),
    ).toHaveLength(2);
    expect(one(root, 'button', 'Review 1 change')).toBeTruthy();
  });

  it('5.10: review lists before and after, Discard puts Google’s value back, Send uses If-Match', async () => {
    const { root, store } = await chosen(1120);
    const [allDay] = rowWith(store, 'Calendar all-day fixture');
    const [timed] = rowWith(store, 'Calendar timed fixture');
    store.resources.set(allDay, {
      ...store.resources.get(allDay)!,
      [NAME]: 'All-day here',
    });
    store.resources.set(timed, {
      ...store.resources.get(timed)!,
      [NAME]: 'Timed here',
    });
    await click(one(root, 'button', 'Sync now'), 10);
    await click(one(root, 'button', 'Review 2 changes'), 10);
    const sheet = one(root, 'dialog');
    expect(sheet.textContent).toContain('Send 2 changes to Google Calendar');
    expect(sheet.textContent).toContain(
      'TitleCalendar timed fixture→ becomes Timed here',
    );
    expect(sheet.textContent).toContain(
      'Guests on these events are not emailed about these changes.',
    );
    await click(
      one(sheet, 'button', 'Discard the change to Calendar all-day fixture'),
      6,
    );
    expect(store.resources.get(allDay)![NAME]).toBe('Calendar all-day fixture');
    const again = one(root, 'dialog');
    expect(again.textContent).toContain('Send 1 change to Google Calendar');
    await click(one(again, 'button', 'Send 1 change to Google'), 10);
    expect(store.google.writes).toEqual([
      expect.objectContaining({
        id: 'timed',
        patch: { summary: 'Timed here' },
        ifMatch: expect.stringMatching(/^"v\d+"$/),
      }),
    ]);
    const done = one(root, 'dialog');
    expect(done.textContent).toContain('1 of 1 change sent');
    expect(done.textContent).toContain('Calendar timed fixture: Sent');
  });

  it('a read-only calendar never offers Edit', async () => {
    const store = fakeStore();
    const root = await mount(store, 1120);
    const team = byRole(root, 'radio').find(
      r => (r as HTMLInputElement).value === TEAM,
    ) as HTMLInputElement;
    team.checked = true;
    await click(one(root, 'button', 'Import this calendar'), 10);
    expect(one(root, 'complementary', 'Calendars').textContent).toContain(
      'Read-only',
    );
    await click(one(root, 'button', /^Team standup, /));
    const drawer = one(root, 'dialog');
    expect(byRole(drawer, 'button', 'Edit')).toEqual([]);
    expect(drawer.textContent).toContain('read-only for you');
    key('e');
    await settle();
    expect(drawer.isConnected || one(root, 'dialog')).toBeTruthy();
    expect(root.querySelector('[data-key="f-title"]')).toBeNull();
  });
});

describe('Calendar views: conflicts and errors', () => {
  it('5.11: Resolve is enabled only once every field has a choice; nothing is sent', async () => {
    const { root, store } = await chosen(1120);
    const [timed] = rowWith(store, 'Calendar timed fixture');
    store.resources.set(timed, {
      ...store.resources.get(timed)!,
      [NAME]: 'Mine',
    });
    store.google.editRemote('timed', { summary: 'Theirs' });
    await click(one(root, 'button', 'Sync now'), 10);
    await click(one(root, 'button', /1 conflict/));
    const sheet = one(root, 'dialog');
    expect(sheet.textContent).toContain('1 event needs a decision');
    expect(
      (one(sheet, 'button', 'Resolve') as HTMLButtonElement).disabled,
    ).toBe(true);
    const mine = byRole(sheet, 'radio').find(r =>
      r.closest('label')!.textContent!.startsWith('Keep mine'),
    ) as HTMLInputElement;
    mine.checked = true;
    mine.dispatchEvent(new Event('change'));
    await settle();
    await click(one(one(root, 'dialog'), 'button', 'Resolve'), 8);
    expect(one(root, 'dialog').textContent).toContain('No conflicts');
    expect(store.google.writes).toEqual([]);
    expect(one(root, 'button', 'Review 1 change')).toBeTruthy();
  });

  it('5.11: a local copy is removed only after an in-page confirmation', async () => {
    const { root, store } = await chosen(1120);
    store.google.cancel('timed');
    await click(one(root, 'button', 'Sync now'), 10);
    await click(one(root, 'button', /1 conflict/));
    await click(one(one(root, 'dialog'), 'button', 'Remove local copy'));
    const confirm = one(root, 'group', 'Confirm removal');
    expect(confirm.textContent).toContain('This can’t be undone.');
    expect(rowWith(store, 'Calendar timed fixture')).toBeTruthy();
    await click(one(confirm, 'button', 'Remove'), 8);
    expect(rowWith(store, 'Calendar timed fixture')).toBeUndefined();
  });

  it('5.12: a 401 is an alert with Reconnect; the rows stay visible', async () => {
    const { root, store } = await chosen(1120);
    store.answerNext(401);
    await click(one(root, 'button', 'Sync now'), 10);
    const alert = one(root, 'alert');
    expect(alert.textContent).toContain('Google access has expired.');
    expect(alert.textContent).toContain('Nothing here was changed.');
    expect(one(alert, 'button', 'Reconnect Google Calendar')).toBeTruthy();
    expect(root.querySelector('.pill')!.textContent).toBe('Reconnect needed');
    expect(byRole(root, 'button', /^Calendar timed fixture, /)).toHaveLength(1);
  });

  it('5.12: a network failure is a status, not an alert', async () => {
    const { root, store } = await chosen(1120);
    store.throwNext('Failed to fetch');
    await click(one(root, 'button', 'Sync now'), 10);
    expect(byRole(root, 'alert')).toEqual([]);
    const banner = root.querySelector('.banner')!;
    expect(banner.getAttribute('role')).toBe('status');
    expect(banner.textContent).toContain('Couldn’t reach Google.');
  });
});

describe('Calendar views: host operations of pin 007869464', () => {
  it('C8: the drawer opens the event in Google Calendar through the host', async () => {
    const { root, store } = await chosen(1120);
    await click(one(root, 'button', /^Calendar timed fixture, /));
    await click(
      one(one(root, 'dialog'), 'button', 'Open in Google Calendar ↗'),
    );
    expect(store.opened.external).toEqual([
      'https://www.google.com/calendar/event?eid=dGltZWQgc3ludGhldGlj',
    ]);
  });

  it('C7: Month opens the table in the host, from the segment and from m', async () => {
    const { root, store } = await chosen(1120);
    await click(one(root, 'button', 'Month ↗'));
    key('m');
    await settle();
    expect(store.opened.resources).toEqual([TABLE, TABLE]);
    // The app's own view does not change.
    expect(root.querySelector('.wk')).toBeTruthy();
  });

  it('Disconnect in the connection menu returns to the first-run card', async () => {
    const { root, store } = await chosen(1120);
    await click(one(root, 'button', 'Connection menu'));
    await click(one(root, 'menuitem', /^Disconnect/), 6);
    expect(one(root, 'button', 'Connect Google Calendar')).toBeTruthy();
    expect(
      await store.proxy!.connections({ platform: 'google-calendar' }),
    ).toEqual([]);
  });

  it('follows the host’s colour scheme, not a guess from its background', async () => {
    const store = fakeStore();
    store.setTheme('dark');
    await mount(store);
    expect(document.documentElement.getAttribute('data-pl-theme')).toBe('dark');
    store.setTheme('light');
    expect(document.documentElement.getAttribute('data-pl-theme')).toBe(
      'light',
    );
  });

  it('C10: a missing or rebound row can be opened in the table', async () => {
    const root = document.createElement('div');
    const opened: Array<string | undefined> = [];
    root.append(
      conflicts(
        {
          doc: document,
          zone: 'UTC',
          today: '2026-09-24',
          now: Date.now(),
          width: 720,
          open: () => {},
          goTo: () => {},
          setView: () => {},
        },
        {
          list: [
            {
              subject: 'did:ad:row',
              id: 'timed',
              title: 'Calendar timed fixture',
              fields: ['Missing or rebound local card'],
              kind: 'missing-local',
            },
          ],
          color: '#9fe1e7',
          choices: new Map(),
          errors: new Map(),
          onClose: () => {},
          onChoose: () => {},
          onResolve: () => {},
          onKeep: () => {},
          onRemove: () => {},
          onConfirm: () => {},
          onOpenRow: c => opened.push(c.subject),
        },
      ),
    );
    await click(one(root, 'button', 'Open row in table'));
    expect(opened).toEqual(['did:ad:row']);
  });

  it('an older host shows none of these controls', async () => {
    const { root } = await chosen(1120, fakeStore({ hostOps: false }));
    expect(byRole(root, 'button', 'Month ↗')).toEqual([]);
    await click(one(root, 'button', /^Calendar timed fixture, /));
    expect(byRole(root, 'button', 'Open in Google Calendar ↗')).toEqual([]);
    await click(one(root, 'button', 'Connection menu'));
    expect(byRole(root, 'menuitem', /^Disconnect/)).toEqual([]);
  });
});
