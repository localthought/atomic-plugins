// @wc-ignore-file
/**
 * DOM tests for the #89 views, in jsdom (from the atomic-server checkout's
 * data-browser workspace; no dependency of our own). Frames are rendered by
 * `preview.ts` from the mockup data; the last tests run the real `view()`
 * against the fake store and the Clockify mock.
 */
import { createRequire } from 'node:module';
import { afterEach, describe, expect, it } from 'vitest';
import { USER, WORKSPACE } from '../../fixtures/clockify/scenario.mjs';
import { APP, fakeStore } from '../fakeStore.js';
import { fixtureProxy } from '../fixtureProxy.js';
import { view } from '../main.js';
import { ensureSchema } from '../schema.js';
import { FRAMES, renderFrame, type FrameId } from './preview.js';
import type { Shell } from './shell.js';
import { css } from './theme.js';

const { JSDOM } = createRequire(
  new URL('../../../../browser/data-browser/package.json', import.meta.url),
)('jsdom') as typeof import('jsdom');

const shells: Shell[] = [];
afterEach(() => shells.splice(0).forEach(s => s.destroy()));

function frame(id: FrameId) {
  const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
  const doc = dom.window.document;
  const root = doc.getElementById('root')!;
  shells.push(renderFrame(root, id));

  return { dom, doc, root };
}

const text = (node: Element | null | undefined) =>
  node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
const buttons = (root: Element, name: string) =>
  [...root.querySelectorAll('button')].filter(
    b => (b.getAttribute('aria-label') ?? text(b)) === name,
  );

describe('theme', () => {
  it('maps every --pl-* colour from a host --t-* variable and loads nothing', () => {
    for (const token of [
      'bg',
      'surface',
      'subtle',
      'border',
      'text',
      'muted',
      'accent',
      'neg',
      'warn',
    ])
      expect(css).toMatch(new RegExp(`--pl-${token}: var\\(--t-`));
    expect(css).not.toMatch(/@import|url\(/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
  });
});

describe('frames', () => {
  it.each(Object.keys(FRAMES) as FrameId[])(
    '%s renders with one status region',
    id => {
      const { root } = frame(id);
      expect(root.querySelectorAll('[role="status"]')).toHaveLength(1);
      // The e2e and screen readers find the app by this heading.
      expect(text(root.querySelector('h1'))).toBe('Clockify Timesheets');
    },
  );

  it('A: a captioned table with row and column headers, en dashes and spoken durations', () => {
    const { root } = frame('a');
    const table = root.querySelector('table.week')!;
    expect(text(table.querySelector('caption'))).toBe(
      'Hours per project, 21 – 27 Sep 2026',
    );
    expect(table.querySelectorAll('thead th[scope="col"]')).toHaveLength(9);
    expect(table.querySelectorAll('tbody th[scope="row"]')).toHaveLength(5);
    expect(text(root.querySelector('.weektotal strong'))).toContain('26:50');
    expect(text(root.querySelector('.weektotal strong .sr'))).toBe(
      '26 hours 50 minutes',
    );
    const friday = table
      .querySelectorAll('tbody tr')[0]
      .querySelectorAll('td')[4];
    expect(friday.className).toContain('z');
    expect(text(friday.querySelector('[aria-hidden]'))).toBe('–');
    expect(table.querySelector('th.today')!.getAttribute('aria-label')).toBe(
      'Thursday 24 Sep, today',
    );
    expect(text(root.querySelector('.note'))).toContain('1 timer is running');
    expect(
      [...root.querySelectorAll('.foot > span')].map(n => text(n)),
    ).toEqual([
      'Billable 21:15',
      'Not billable 5:35',
      'Times in Europe/Amsterdam',
    ]);
    // Colour is never the only signal: every dot sits next to a name.
    for (const dot of root.querySelectorAll('tbody .dot'))
      expect(text(dot.parentElement)).not.toBe('');
  });

  it('B: a Week cell opens Entries at that day with the project highlighted', () => {
    const { root } = frame('b');
    expect(
      root.querySelector('[role="tab"][aria-selected="true"]')!.textContent,
    ).toBe('Entries');
    const lit = [...root.querySelectorAll('.entry.hl')].map(e =>
      text(e.querySelector('.desc')),
    );
    expect(lit).toEqual([
      'Review TestFlight feedback',
      'Offline sync: conflict sheet',
    ]);
    expect(text(root.querySelector('.dayhead h3'))).toBe('Thursday 24 Sep');
    const billable = root.querySelector('.entry .bill .sr');
    expect(text(billable)).toBe('Billable');
  });

  it('C: projects with shares summing to 100.0 and no week navigator', () => {
    const { root } = frame('c');
    expect([...root.querySelectorAll('.prow .pct')].map(n => text(n))).toEqual([
      '40.6%',
      '36.1%',
      '10.3%',
      '8.8%',
      '4.2%',
    ]);
    expect(root.querySelector('[data-k="prev"]')).toBeNull();
    expect(
      [...root.querySelectorAll('.weeknav > span')].map(n => text(n)),
    ).toEqual(['25 Aug – 24 Sep 2026', 'the whole import window']);
  });

  it('D: the drawer takes focus, keeps it inside, and Esc returns it to the row', () => {
    const { root, doc, dom } = frame('d');
    const dialog = root.querySelector('[role="dialog"]')!;
    expect(dialog.getAttribute('aria-modal')).toBe('true');
    expect(doc.activeElement?.id).toBe('sheet-h');
    expect(text(doc.activeElement)).toBe('Homepage hero, responsive pass');
    expect(text(dialog.querySelector('.prov'))).toContain(
      'Changes made in Clockify replace this copy on the next sync.',
    );

    const link = dialog.querySelector('footer a')!;
    (link as HTMLElement).focus();
    dialog.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
    );
    expect(doc.activeElement?.getAttribute('aria-label')).toBe('Close');

    doc.activeElement!.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
    );
    expect(root.querySelector('[role="dialog"]')).toBeNull();
    expect(text((doc.activeElement as Element).querySelector('.desc'))).toBe(
      'Homepage hero, responsive pass',
    );
  });

  it('E: below 560px the week is a strip of day tabs over one day', () => {
    const { root } = frame('e');
    const tabs = root.querySelectorAll('.strip [role="tab"]');
    expect(tabs).toHaveLength(7);
    expect([...tabs].map(t => (t as HTMLButtonElement).disabled)).toEqual([
      false,
      false,
      false,
      false,
      true,
      true,
      true,
    ]);
    expect(tabs[3].getAttribute('aria-selected')).toBe('true');
    const panel = root.querySelector('[role="tabpanel"]#day-panel')!;
    expect(text(panel.querySelector('h3'))).toBe('Today, 24 Sep');
    expect(root.querySelector('table.week')).toBeNull();
    // Sync now is an icon button with the same accessible name.
    expect(buttons(root, 'Sync now')).toHaveLength(1);
    expect(root.querySelector('.hdr .chip')).toBeNull();

    (tabs[0] as HTMLElement).click();
    expect(text(root.querySelector('#day-panel h3'))).toBe('Monday 21 Sep');
  });

  it('F and G: connect, wait, then choose a workspace and window', () => {
    const f = frame('f');
    expect(text(f.root.querySelector('.pill'))).toBe('Not connected');
    buttons(f.root, 'Connect Clockify')[0].click();
    expect(text(f.root.querySelector('.panel h2'))).toBe(
      'Finish connecting in the bar above this app',
    );

    const g = frame('g2');
    expect(g.root.querySelectorAll('input[type="radio"]')).toHaveLength(2);
    const pressed = g.root.querySelector('[aria-pressed="true"]');
    expect(text(pressed)).toBe('Last 30 days');
    buttons(g.root, 'Last 7 days')[0].click();
    expect(text(g.root.querySelector('[aria-pressed="true"]'))).toBe(
      'Last 7 days',
    );
    expect(text(g.root.querySelector('.hint'))).toBe(
      'Recomputed on every sync: 17 – 24 Sep today.',
    );
  });

  it('H: the first import shows a skeleton and saving progress', () => {
    const { root } = frame('h');
    expect(text(root.querySelector('.conn'))).toContain(
      'Saving 61 entries… 24 of 61',
    );
    expect(root.querySelector('.progress i')!.getAttribute('style')).toBe(
      'width: 39%',
    );
    expect(root.querySelectorAll('.skel').length).toBeGreaterThan(0);
    expect(buttons(root, 'Sync now')[0].disabled).toBe(true);
  });

  it('I: an empty window offers Sync now once, and 30 days', () => {
    const { root } = frame('i');
    expect(text(root.querySelector('.empty'))).toContain(
      'No completed time entries between 17 and 24 Sep.',
    );
    expect(buttons(root, 'Sync now')).toHaveLength(1);
    expect(buttons(root, 'Import 30 days instead')).toHaveLength(1);
  });

  it.each([
    [
      'j',
      'Clockify no longer accepts this connection.',
      'Reconnect Clockify',
      'Reconnect needed',
    ],
    [
      'j2',
      'Clockify asked for fewer requests.',
      'Try again (30 s)',
      'Sync failed',
    ],
    [
      'j3',
      'Could not reach the integration proxy.',
      'Try again',
      'Sync failed',
    ],
    [
      'j4',
      'This Clockify account cannot read time entries in Studio Veldkamp.',
      'Choose another workspace',
      'Sync failed',
    ],
    [
      'j6',
      'Clockify returned more than 10,000 entries for this window,',
      'Import 7 days instead',
      'Sync failed',
    ],
  ] as const)(
    'J (%s): the banner, its recovery and the pill; data stays',
    (id, lead, action, pillText) => {
      const { root } = frame(id);
      const alert = root.querySelector('[role="alert"]')!;
      expect(text(alert.querySelector('strong'))).toBe(lead);
      expect(buttons(alert, action)).toHaveLength(1);
      expect(text(alert.querySelector('details summary'))).toBe('Details');
      expect(text(root.querySelector('.pill'))).toBe(pillText);
      expect(root.querySelector('table.week')).not.toBeNull();
    },
  );

  it('J: a 429 disables both retries until retry-after has passed', () => {
    const { root } = frame('j2');
    expect(buttons(root, 'Try again (30 s)')[0].disabled).toBe(true);
    expect(buttons(root, 'Sync now')[0].disabled).toBe(true);
  });

  it('J: warnings are a dismissable note, not an alert', () => {
    const { root } = frame('j5');
    expect(root.querySelector('[role="alert"]')).toBeNull();
    expect(text(root.querySelector('.banner.warn strong'))).toBe(
      'Project names could not be loaded,',
    );
    buttons(root, 'Dismiss')[0].click();
    expect(root.querySelector('.banner.warn')).toBeNull();
  });

  it('K: no relay, entries still listed, no sync', () => {
    const { root } = frame('k');
    expect(text(root.querySelector('.pill'))).toBe('Offline');
    expect(buttons(root, 'Sync now')).toHaveLength(0);
    expect(text(root.querySelector('.banner.info strong'))).toBe(
      "This Atomic Server can't connect apps to Clockify yet.",
    );
    expect(root.querySelectorAll('.entry').length).toBeGreaterThan(0);
  });

  it('L: days before the window are hatched and named so; the band says why', () => {
    const { root } = frame('l');
    const monday = root.querySelector('thead th.out')!;
    expect(monday.getAttribute('aria-label')).toBe(
      'Monday 24 Aug, outside import window',
    );
    expect(text(root.querySelector('.banner.info'))).toBe(
      'Before 25 Aug is outside your 30-day import window. Only entries imported earlier are listed.',
    );
    expect(text(root.querySelector('.weektotal strong [aria-hidden]'))).toBe(
      '20:30',
    );
    expect(root.querySelector('.note')).toBeNull();
    buttons(root, 'This week')[0].click();
    expect(text(root.querySelector('.weeknav .range'))).toBe(
      '21 – 27 Sep 2026',
    );
    expect(buttons(root, 'Next week')[0].disabled).toBe(true);
  });

  it('M: the settings sheet confirms Disconnect inline', () => {
    const { root } = frame('m');
    const dialog = root.querySelector('[role="dialog"]')!;
    expect(text(dialog.querySelector('#sheet-h'))).toBe('Settings');
    expect(dialog.querySelector('label[for="set-ws"]')).not.toBeNull();
    buttons(dialog, 'Disconnect…')[0].click();
    expect(text(root.querySelector('.confirm'))).toContain(
      'The 52 entries already imported stay in this drive.',
    );
    buttons(root, 'Cancel')[1].click();
    expect(root.querySelector('[role="dialog"]')).toBeNull();
  });

  it('view tabs move with the arrow keys', () => {
    const { root, dom } = frame('a');
    const tablist = root.querySelector('.bar [role="tablist"]')!;
    tablist.dispatchEvent(
      new dom.window.KeyboardEvent('keydown', {
        key: 'ArrowRight',
        bubbles: true,
      }),
    );
    expect(
      root.querySelector('.bar [role="tab"][aria-selected="true"]')!
        .textContent,
    ).toBe('Entries');
  });
});

describe('view() against the fake store and the Clockify mock', () => {
  const NOW = Date.now();

  async function mount(configured: boolean) {
    const proxy = fixtureProxy(NOW);
    const store = fakeStore({ proxy: proxy.request });

    if (configured) {
      const schema = await ensureSchema(store);
      const app = await store.getResource(APP);
      app.set(schema.settings.workspaceId, WORKSPACE.id);
      app.set(schema.settings.userId, USER.id);
      app.set(schema.settings.lookbackDays, 30);
      await app.save();
    }

    const dom = new JSDOM('<!doctype html><body><div id="root"></div></body>');
    const root = dom.window.document.getElementById('root')!;
    await view({ root, store });

    return { root, store };
  }

  it('asks for a workspace first, then imports and shows the entries', async () => {
    const { root } = await mount(false);
    expect(text(root.querySelector('[role="status"]'))).toContain(
      'Choose the workspace',
    );
    expect(text(root.querySelector('.conn'))).toBe('Connected as Test Person');
    buttons(root, 'Last 7 days')[0].click();
    buttons(root, 'Import entries')[0].click();

    await expect
      .poll(() => text(root.querySelector('[role="status"]')))
      .toContain('2 created, 0 updated, 0 unchanged, last 7 days.');
    expect(text(root.querySelector('.hdr .chip'))).toBe(
      'CClockify · Test workspace',
    );
    buttons(root, 'Entries')[0].click();
    expect(
      [...root.querySelectorAll('.entry .desc')].map(n => text(n)).sort(),
    ).toEqual(['Fix plugin source loading', 'Weekly sync']);
  });

  it('renders the mirror on open, before and after its sync', async () => {
    const { root } = await mount(true);
    await expect
      .poll(() => text(root.querySelector('[role="status"]')))
      .toContain('Last synced');
    expect(text(root.querySelector('.pill'))).toBe('Synced just now');
    buttons(root, 'Projects')[0].click();
    expect(text(root.querySelector('.prow'))).toContain('Atomic plugins');
    expect(text(root.querySelector('.prow small'))).toBe('Test client');
  });
});
