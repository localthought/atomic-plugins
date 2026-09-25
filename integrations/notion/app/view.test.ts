// @vitest-environment jsdom
// @wc-ignore-file
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ViewState } from './controller.js';
import type { SyncRecord } from './record.js';
import type { Row } from './rows.js';
import type { DataSourceReport, SchemaProperty } from './sync.js';
import { createApp, type App } from './view/app.js';
import {
  ALL,
  columnsFor,
  groupRows,
  nextSort,
  notes,
  pill,
  searchRows,
  sortRows,
  sources,
} from './view/model.js';

const NOW = Date.parse('2026-09-24T10:16:00Z');
const o = (id: string, name: string, color: string) => ({ id, name, color });
const STATUS = [
  o('s1', 'Not started', 'default'),
  o('s2', 'In progress', 'blue'),
  o('s3', 'Done', 'green'),
];
const READ = [o('r1', 'To read', 'gray'), o('r2', 'Finished', 'green')];
const P = (
  id: string,
  name: string,
  type: string,
  options?: typeof STATUS,
): SchemaProperty => ({
  id,
  name,
  type,
  ...(type === 'people' ? {} : { shortname: `notion-${id}` }),
  ...(options ? { options } : {}),
});

const report = (
  id: string,
  title: string,
  properties: SchemaProperty[],
  extra: Partial<DataSourceReport> = {},
): DataSourceReport => ({
  id,
  title,
  pages: 0,
  created: 0,
  updated: 0,
  unchanged: 0,
  properties,
  formatted: [],
  archived: [],
  errors: [],
  ...extra,
});

const roadmap = report(
  'd1',
  'Roadmap',
  [
    P('title', 'Name', 'title'),
    P('st', 'Status', 'status', STATUS),
    P('pt', 'Points', 'number'),
    P('dn', 'Done', 'checkbox'),
    P('ow', 'Owner', 'people'),
  ],
  { formatted: [{ page: 'p1', title: 'Launch plan', property: 'Notes' }] },
);
const reading = report('d2', 'Reading list', [
  P('title', 'Title', 'title'),
  P('st2', 'Status', 'status', READ),
  P('ln', 'Link', 'url'),
]);

const last: SyncRecord = {
  version: 1,
  at: NOW - 4 * 60_000,
  durationMs: 3000,
  created: 5,
  updated: 0,
  unchanged: 0,
  dataSources: [roadmap, reading],
  general: [],
};

const row = (
  subject: string,
  name: string,
  dataSource: string,
  lastEdited: number,
  values: Row['values'],
): Row => ({
  subject,
  name,
  pageId: subject.replace('row', 'p'),
  dataSource,
  url: `https://www.notion.so/${subject}`,
  lastEdited,
  values,
});

const rows: Row[] = [
  row('row1', 'Launch plan', 'Roadmap', NOW - 1000, {
    'notion-st': 's2',
    'notion-pt': 3,
    'notion-dn': false,
  }),
  row('row2', 'Write changelog', 'Roadmap', NOW - 5000, {
    'notion-st': 's3',
    'notion-pt': 0,
    'notion-dn': true,
  }),
  row('row3', 'Retrospective', 'Roadmap', NOW - 9000, {
    'notion-st': 'gone-option',
  }),
  row('row4', 'Thinking in Systems', 'Reading list', NOW - 3000, {
    'notion-st2': 'r1',
    'notion-ln': 'https://example.org/book',
  }),
  row('row5', 'Untitled draft', 'Roadmap', NOW - 20000, {}),
];

const ready: ViewState = { kind: 'ready', connectionId: 'c', rows, last };

describe('view model', () => {
  it('shows a database’s own columns in Notion order, without skipped types', () => {
    const cols = columnsFor('Roadmap', sources(rows, last));
    expect(cols.map(c => c.name)).toEqual([
      'Name',
      'Status',
      'Points',
      'Done',
      'Last edited in Notion',
    ]);
  });

  it('shows in "All" only the columns every database has by name and type', () => {
    const cols = columnsFor(ALL, sources(rows, last));
    expect(cols.map(c => c.name)).toEqual([
      'Name',
      'Database',
      'Status',
      'Last edited in Notion',
    ]);
    // The two "Status" properties have different ids, merged for display.
    expect(cols[2]!.shortnames).toEqual(['notion-st', 'notion-st2']);
  });

  it('counts rows per database for the chips', () => {
    expect(sources(rows, last).map(s => [s.title, s.count])).toEqual([
      ['Roadmap', 4],
      ['Reading list', 1],
    ]);
  });

  it('searches titles and option names, not option ids', () => {
    const cols = columnsFor(ALL, sources(rows, last));
    expect(searchRows(rows, cols, 'progress').map(r => r.name)).toEqual([
      'Launch plan',
    ]);
    expect(searchRows(rows, cols, 's2')).toEqual([]);
    expect(searchRows(rows, cols, 'THINKING').map(r => r.name)).toEqual([
      'Thinking in Systems',
    ]);
  });

  it('sorts ascending, descending, then off; options in Notion order; empties last', () => {
    const cols = columnsFor('Roadmap', sources(rows, last));
    expect(nextSort(null, 'notion-pt')).toEqual({
      key: 'notion-pt',
      dir: 'asc',
    });
    expect(nextSort({ key: 'notion-pt', dir: 'asc' }, 'notion-pt')).toEqual({
      key: 'notion-pt',
      dir: 'desc',
    });
    expect(nextSort({ key: 'notion-pt', dir: 'desc' }, 'notion-pt')).toBeNull();
    const roadmapRows = rows.filter(r => r.dataSource === 'Roadmap');
    expect(
      sortRows(roadmapRows, cols, { key: 'notion-pt', dir: 'desc' }).map(
        r => r.name,
      ),
    ).toEqual([
      'Launch plan',
      'Write changelog',
      'Retrospective',
      'Untitled draft',
    ]);
    expect(
      sortRows(roadmapRows, cols, { key: 'notion-st', dir: 'asc' }).map(
        r => r.name,
      ),
    ).toEqual([
      'Launch plan',
      'Write changelog',
      'Retrospective',
      'Untitled draft',
    ]);
    expect(
      sortRows(roadmapRows, cols, { key: 'edited', dir: 'desc' })[0]!.name,
    ).toBe('Launch plan');
  });

  it('groups a board in Notion’s option order, unknown options after, "No value" last', () => {
    const cols = columnsFor('Roadmap', sources(rows, last));
    const status = cols.find(c => c.name === 'Status')!;
    const groups = groupRows(
      rows.filter(r => r.dataSource === 'Roadmap'),
      status,
    );
    expect(groups.map(g => [g.option?.name ?? g.key, g.rows.length])).toEqual([
      ['Not started', 0],
      ['In progress', 1],
      ['Done', 1],
      ['gone-option', 1],
      ['', 1],
    ]);
  });

  it('says what the pill says per state', () => {
    expect(pill(ready, NOW)).toEqual({ tone: 'warn', text: 'Synced · 1 note' });
    expect(
      pill({ ...ready, last: { ...last, dataSources: [reading] } }, NOW),
    ).toEqual({ tone: 'ok', text: 'Synced 4 min ago' });
    expect(
      pill(
        {
          kind: 'syncing',
          connectionId: 'c',
          rows,
          last,
          progress: [
            { dataSource: 'd1', title: 'Roadmap', phase: 'done', pages: 4 },
            {
              dataSource: 'd2',
              title: 'Reading list',
              phase: 'reading',
              pages: 1,
            },
          ],
        },
        NOW,
      ),
    ).toEqual({ tone: 'sync', text: 'Syncing… Reading list' });
    expect(
      pill(
        {
          kind: 'importing',
          connectionId: 'c',
          rows: [],
          progress: [
            { dataSource: 'd1', title: 'Roadmap', phase: 'done', pages: 4 },
            {
              dataSource: 'd2',
              title: 'Reading list',
              phase: 'reading',
              pages: 1,
            },
            { dataSource: 'd3', title: 'Hiring', phase: 'listing', pages: 0 },
          ],
        },
        NOW,
      )?.text,
    ).toBe('Importing 2 of 3 databases');
    expect(pill({ kind: 'reauth', rows }, NOW)).toEqual({
      tone: 'neg',
      text: 'Reconnect needed',
    });
    expect(
      pill({ kind: 'no-databases', connectionId: 'c', rows: [] }, NOW)?.text,
    ).toBe('No databases shared');
    expect(
      pill(
        {
          kind: 'failed',
          connectionId: 'c',
          rows,
          title: '',
          message: '',
          technical: '',
        },
        NOW,
      )?.text,
    ).toBe('Sync failed');
    expect(pill({ kind: 'not-connected' }, NOW)).toBeUndefined();
  });

  it('counts grouped notes, one per property with formatting', () => {
    expect(
      notes({
        ...last,
        general: ['Column "X" exists with another datatype; not imported'],
        dataSources: [
          {
            ...roadmap,
            formatted: [
              { page: 'a', title: 'a', property: 'Notes' },
              { page: 'b', title: 'b', property: 'Notes' },
            ],
            archived: ['c'],
          },
        ],
      }),
    ).toBe(3);
  });
});

describe('view (DOM)', () => {
  let app: App;
  let root: HTMLElement;
  let width = 1200;
  const actions = { sync: vi.fn(), connect: vi.fn() };

  beforeEach(() => {
    document.body.innerHTML = '<div id="root"></div>';
    root = document.getElementById('root')!;
    width = 1200;
    actions.sync.mockReset();
    actions.connect.mockReset();
    app = createApp(root, actions, {
      now: () => NOW,
      locale: 'en-GB',
      width: () => width,
    });
  });

  afterEach(() => {
    app.destroy();
    vi.useRealTimers();
  });

  const q = <T extends Element = HTMLElement>(selector: string) =>
    root.querySelector<T>(selector);
  const all = (selector: string) => [
    ...root.querySelectorAll<HTMLElement>(selector),
  ];
  const buttons = () => all('button').map(b => b.textContent?.trim());
  const key = (el: Element, k: string) =>
    el.dispatchEvent(new KeyboardEvent('keydown', { key: k, bubbles: true }));

  it('S1: a host without the relay explains and offers no action', () => {
    app.render({ kind: 'no-proxy' });
    expect(q('h2')?.textContent).toMatch(
      /can’t connect apps to other services/,
    );
    expect(q('[role=status]')?.hidden).toBe(true);
    expect(buttons()).toEqual([]);
  });

  it('S2: first run offers exactly one action, Connect Notion', () => {
    app.render({ kind: 'not-connected' });
    expect(q('h2')?.textContent).toBe(
      'Bring your Notion databases into Atomic',
    );
    expect(buttons()).toEqual(['Connect Notion']);
    q<HTMLButtonElement>('button')!.click();
    expect(actions.connect).toHaveBeenCalledOnce();
  });

  it('S3: connecting shows a busy, disabled button', () => {
    app.render({ kind: 'connecting' });
    const button = q<HTMLButtonElement>('.pl-empty button')!;
    expect(button.textContent).toMatch(/Waiting for confirmation/);
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
  });

  it('S4: first import lists each database’s progress', () => {
    app.render({
      kind: 'importing',
      connectionId: 'c',
      rows: [],
      progress: [
        { dataSource: 'd1', title: 'Roadmap', phase: 'done', pages: 24 },
        { dataSource: 'd2', title: 'Reading list', phase: 'reading', pages: 8 },
      ],
    });
    expect(all('.nt-progress li').map(li => li.textContent)).toEqual([
      'Roadmap24 pages',
      'Reading listReading… 8 pages',
    ]);
    expect(q('[role=status]')?.textContent).toBe('Importing 2 of 2 databases');
    expect(q<HTMLButtonElement>('[data-key=sync-now]')!.disabled).toBe(true);
  });

  it('S5: nothing shared offers "Choose pages in Notion"', () => {
    app.render({
      kind: 'no-databases',
      connectionId: 'c',
      rows: [],
      last: { ...last, dataSources: [] },
    });
    expect(q('h2')?.textContent).toMatch(/didn’t share any databases/);
    q<HTMLButtonElement>('[data-key=choose]')!.click();
    expect(actions.connect).toHaveBeenCalledOnce();
  });

  it('S6: a real table with scoped headers, sort state and typed cells', () => {
    app.render(ready);
    q<HTMLButtonElement>('[data-key="chip:Roadmap"]')!.click();
    expect(all('th').map(th => th.getAttribute('scope'))).toEqual(
      Array(5).fill('col'),
    );
    expect(all('th').map(th => th.textContent)).toEqual([
      'Name',
      'Status',
      'Points',
      'Done',
      'Last edited in Notion',
    ]);
    expect(q('th[aria-sort]')?.textContent).toBe('Last edited in Notion');
    expect(q('th[aria-sort]')?.getAttribute('aria-sort')).toBe('descending');
    const first = all('tbody tr')[0]!;
    const cells = [...first.querySelectorAll('td')];
    expect(cells[0]!.textContent).toBe('Launch plan');
    expect(cells[1]!.textContent).toBe('In progress');
    expect(cells[1]!.querySelector('.nt-tag.nt-status.c-blue')).toBeTruthy();
    expect(cells[2]!.className).toBe('num');
    expect(
      cells[3]!.querySelector('[role=img]')?.getAttribute('aria-label'),
    ).toBe('No');
    expect(cells[4]!.textContent).toMatch(/^Today, /);
    // An option id the schema does not know is not shown as an id.
    const retro = all('tbody tr').find(tr =>
      tr.textContent?.startsWith('Retrospective'),
    )!;
    expect(retro.textContent).toContain('Unknown option');
    expect(retro.textContent).not.toContain('gone-option');
    // Header clicks: ascending, descending, off.
    q<HTMLButtonElement>('[data-key="th:notion-pt"]')!.click();
    expect(q('th[aria-sort]')?.textContent).toBe('Points');
    expect(q('th[aria-sort]')?.getAttribute('aria-sort')).toBe('ascending');
  });

  it('keeps the one role=status element across renders', () => {
    app.render(ready);
    const status = q('[role=status]');
    app.render({ ...ready, kind: 'syncing', progress: [] });
    expect(q('[role=status]')).toBe(status);
    expect(status?.textContent).toBe('Syncing…');
    expect(all('[role=status]')).toHaveLength(1);
  });

  it('filters with search after a 150 ms pause', () => {
    vi.useFakeTimers();
    app.render(ready);
    const input = q<HTMLInputElement>('input[type=search]')!;
    input.value = 'changelog';
    input.dispatchEvent(new Event('input'));
    expect(all('tbody tr')).toHaveLength(5);
    vi.advanceTimersByTime(150);
    expect(
      all('tbody tr').map(tr => tr.querySelector('td')!.textContent),
    ).toEqual(['Write changelog']);
    expect(q('.nt-count')?.textContent).toBe('1 of 5 rows');
    // The input is the same node, so typing is not interrupted.
    expect(q('input[type=search]')).toBe(input);
  });

  it('S7: Enter opens the side peek, arrows move, Esc closes and returns focus', () => {
    app.render(ready);
    const tr = all('tbody tr')[0]!;
    tr.focus();
    key(tr, 'Enter');
    const peek = q('aside[aria-label="Row details"]')!;
    expect(peek.querySelector('h3')?.textContent).toBe('Launch plan');
    expect(peek.textContent).toContain('Not copied from this page');
    expect(peek.textContent).toContain('Owner');
    expect(peek.textContent).toContain('has formatting');
    expect(peek.textContent).toContain('Read-only copy');
    key(peek, 'ArrowDown');
    expect(q('aside h3')?.textContent).toBe('Thinking in Systems');
    key(q('aside')!, 'Escape');
    expect(q('aside')).toBeNull();
    expect(document.activeElement?.getAttribute('data-key')).toBe('row:row4');
  });

  it('S14: below 640px the list is the default and the peek is a modal sheet', () => {
    width = 360;
    app.destroy();
    app = createApp(root, actions, { now: () => NOW, width: () => width });
    app.render(ready);
    expect(q('.nt-list')).toBeTruthy();
    expect(q('table')).toBeNull();
    expect(q('.pl-select select')).toBeTruthy();
    q<HTMLButtonElement>('.nt-li')!.click();
    const dialog = q<HTMLDialogElement>('dialog')!;
    expect(dialog.hasAttribute('open')).toBe(true);
    expect(dialog.getAttribute('aria-labelledby')).toBe('nt-peek-title');
    dialog.dispatchEvent(new Event('cancel'));
    expect(q('dialog')).toBeNull();
  });

  it('S8: board is off on "All" and groups one database by status', () => {
    app.render(ready);
    expect(q<HTMLButtonElement>('[data-key="view:board"]')!.disabled).toBe(
      true,
    );
    q<HTMLButtonElement>('[data-key="chip:Roadmap"]')!.click();
    q<HTMLButtonElement>('[data-key="view:board"]')!.click();
    expect(all('.nt-col h3').map(h => h.textContent)).toEqual([
      'Not started0',
      'In progress1',
      'Done1',
      'Unknown option1',
      'No value1',
    ]);
  });

  it('S10: sync details group warnings per database', () => {
    app.render(ready);
    q<HTMLButtonElement>('[data-key=details-toggle]')!.click();
    const details = q('[role=dialog][aria-label="Sync details"]')!;
    expect(details.textContent).toContain('Not copied: Owner people');
    expect(details.textContent).toContain(
      '1 page has formatting in Notes, so Notes was not copied for it.',
    );
    expect(details.querySelector('details summary')?.textContent).toBe(
      'Technical details',
    );
  });

  it('S11–S13: one banner with one recovery action; role=alert only after a sync', () => {
    app.render({ kind: 'reauth', connectionId: 'c', rows, last });
    expect(q('.pl-banner')?.textContent).toContain('Your 5 rows are kept');
    expect(q('.pl-banner')?.getAttribute('role')).toBeNull();
    expect(all('.pl-banner button').map(b => b.textContent)).toEqual([
      'Reconnect Notion',
    ]);
    expect(q('[data-key=sync-now]')).toBeNull();

    app.render({ ...ready, kind: 'syncing', progress: [] });
    app.render({
      kind: 'failed',
      connectionId: 'c',
      rows,
      last,
      title: 'Notion didn’t answer properly',
      message: 'Error (502).',
      technical: 'POST /v1/search → 502',
    });
    expect(q('.pl-banner')?.getAttribute('role')).toBe('alert');
    expect(q('.pl-banner pre')?.textContent).toBe('POST /v1/search → 502');
    q<HTMLButtonElement>('[data-key=try-again]')!.click();
    expect(actions.sync).toHaveBeenCalledOnce();
  });

  it('S12: rate-limited retries by itself at retry-after', () => {
    vi.useFakeTimers();
    app.render({
      kind: 'rate-limited',
      connectionId: 'c',
      rows,
      last,
      retryAt: NOW + 30_000,
      pagesRead: 31,
      technical: '',
    });
    expect(q('.pl-banner')?.textContent).toContain('paused after 31 pages');
    expect(q<HTMLButtonElement>('[data-key=sync-now]')!.disabled).toBe(true);
    vi.advanceTimersByTime(29_000);
    expect(actions.sync).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1_000);
    expect(actions.sync).toHaveBeenCalledOnce();
  });

  it('falls back to a copyable URL on a host without openExternal', () => {
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    app.render(ready);
    q<HTMLButtonElement>('[data-key="chip:Reading list"]')!.click();
    const link = all('a.nt-link')[0]!;
    link.click();
    expect(open).toHaveBeenCalledWith('https://example.org/book', '_blank');
    expect(q('.pl-copy code')?.textContent).toBe('https://example.org/book');
    open.mockRestore();
  });

  describe('host operations since atomic-server 007869464', () => {
    const host = {
      sync: vi.fn(),
      connect: vi.fn(),
      openExternal: vi.fn(async (_url: string) => true),
      openTable: vi.fn(),
      disconnect: vi.fn(),
    };
    const flush = () => new Promise(resolve => setTimeout(resolve, 0));

    beforeEach(() => {
      app.destroy();
      for (const f of Object.values(host)) f.mockClear();
      host.openExternal.mockImplementation(async () => true);
      app = createApp(root, host, {
        now: () => NOW,
        locale: 'en-GB',
        width: () => width,
      });
    });

    it('opens "Open in Notion" and link cells through openExternal, no copy box', async () => {
      const open = vi.spyOn(window, 'open');
      app.render(ready);
      q<HTMLButtonElement>('[data-key="chip:Reading list"]')!.click();
      all('a.nt-link')[0]!.click();
      await flush();
      expect(host.openExternal).toHaveBeenCalledWith(
        'https://example.org/book',
      );
      q<HTMLElement>('tbody tr')!.click();
      q<HTMLButtonElement>('[data-key="peek:open"]')!.click();
      await flush();
      expect(host.openExternal).toHaveBeenLastCalledWith(
        'https://www.notion.so/row4',
      );
      expect(open).not.toHaveBeenCalled();
      expect(q('.pl-copy')).toBeNull();
      open.mockRestore();
    });

    it('shows the URL to copy only when openExternal fails', async () => {
      host.openExternal.mockImplementation(async () => {
        throw new Error('Only http(s) links');
      });
      app.render(ready);
      q<HTMLButtonElement>('[data-key="chip:Reading list"]')!.click();
      all('a.nt-link')[0]!.click();
      await flush();
      expect(q('.pl-copy code')?.textContent).toBe('https://example.org/book');
    });

    it('offers "Open data table" in the menu', () => {
      app.render(ready);
      q<HTMLButtonElement>('[data-key="menu:More"]')!.click();
      const item = all('[role=menuitem]').find(
        b => b.textContent === 'Open data table',
      )!;
      item.click();
      expect(host.openTable).toHaveBeenCalledOnce();
    });

    it('asks before disconnecting, in place of the state banner; Cancel does nothing', () => {
      app.render({ kind: 'no-databases', connectionId: 'c', rows, last });
      q<HTMLButtonElement>('[data-key="menu:More"]')!.click();
      all('[role=menuitem]')
        .find(b => b.textContent === 'Disconnect Notion…')!
        .click();
      expect(all('.pl-banner').map(b => b.textContent)).toEqual([
        expect.stringContaining('Disconnect Notion from this app?'),
      ]);
      expect(document.activeElement?.getAttribute('data-key')).toBe(
        'disconnect-cancel',
      );
      q<HTMLButtonElement>('[data-key=disconnect-cancel]')!.click();
      expect(q('.pl-banner')?.textContent).toContain(
        'no longer shares any databases',
      );
      expect(host.disconnect).not.toHaveBeenCalled();
      q<HTMLButtonElement>('[data-key="menu:More"]')!.click();
      all('[role=menuitem]')
        .find(b => b.textContent === 'Disconnect Notion…')!
        .click();
      q<HTMLButtonElement>('[data-key=disconnect-confirm]')!.click();
      expect(host.disconnect).toHaveBeenCalledOnce();
    });

    it('shows a disconnected app with its rows and one Connect action', () => {
      app.render({ kind: 'disconnected', rows, last });
      expect(q('[role=status]')?.textContent).toBe('Not connected');
      expect(q('.pl-banner')?.textContent).toContain(
        'Your 5 rows are kept but won’t update',
      );
      expect(all('.pl-banner button').map(b => b.textContent)).toEqual([
        'Connect Notion',
      ]);
      expect(q('[data-key=sync-now]')).toBeNull();
      expect(all('tbody tr')).toHaveLength(5);
      q<HTMLButtonElement>('[data-key=reconnect]')!.click();
      expect(host.connect).toHaveBeenCalledOnce();
    });

    it('follows the host’s colour scheme, not a guess from the background', () => {
      app.setColorScheme('dark');
      expect(q('.pl-app')?.getAttribute('data-scheme')).toBe('dark');
      app.setColorScheme('light');
      expect(q('.pl-app')?.getAttribute('data-scheme')).toBe('light');
    });
  });
});

describe('theme tokens', () => {
  it('takes the success colour from the host', async () => {
    const { PL_CSS } = await import('./ui/styles.js');
    expect(PL_CSS).toContain('--pl-pos:var(--t-color-success,#2f8f5b)');
    expect(PL_CSS).toMatch(
      /\.pl-app\[data-scheme='dark'\]\{color-scheme:dark\}/,
    );
  });
});
