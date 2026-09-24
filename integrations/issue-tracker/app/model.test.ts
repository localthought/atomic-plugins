// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import type { Ready, ViewState } from './controller.js';
import {
  bannerFor,
  canMove,
  columns,
  countText,
  DONE_LIMIT,
  layoutFor,
  markers,
  matches,
  pillFor,
  short,
  typing,
} from './model.js';
import type { Held, IssueRow, PassResult } from './sync.js';
import { sizeFor } from './ui/theme.js';

const row = (n: number, patch: Partial<IssueRow> = {}): IssueRow => ({
  subject: `s${n}`,
  number: n,
  title: `Issue ${n}`,
  status: 'Todo',
  body: '',
  labels: [],
  assignees: [],
  comments: [],
  ...patch,
});

const result = (rows: IssueRow[], held: Held[] = []): PassResult => ({
  issues: rows.length,
  comments: 0,
  addedHere: 0,
  updatedHere: 0,
  sentToGitHub: 0,
  held,
  rows,
});

const ready = (patch: Partial<Ready> = {}): Ready => ({
  kind: 'ready',
  connectionId: 'c1',
  repository: 'o/r',
  last: { at: 1000, result: result([row(1), row(2)]) },
  ...patch,
});

describe('board columns', () => {
  const done = (n: number) =>
    Array.from({ length: n }, (_, i) =>
      row(i + 1, {
        status: 'Done',
        updatedAt: `2026-09-${String((i % 28) + 1).padStart(2, '0')}T00:00:00Z`,
      }),
    );

  it.each([
    [0, 0, 0],
    [20, 20, 0],
    [21, 20, 1],
    [340, 20, 320],
  ])('collapses Done at %i issues to %i shown and %i more', (n, shown, more) => {
    const col = columns(done(n), { search: '' })[2];
    expect(col).toMatchObject({ status: 'Done', total: n, hidden: more });
    expect(col.rows).toHaveLength(shown);
    expect(DONE_LIMIT).toBe(20);
  });

  it('shows every Done issue when expanded, most recent first', () => {
    const col = columns(done(25), { search: '' }, true)[2];
    expect(col.rows).toHaveLength(25);
    expect(col.rows[0].updatedAt! >= col.rows[1].updatedAt!).toBe(true);
  });

  it('orders Todo and Doing by number, new unsent issues first', () => {
    const rows = [row(5), row(2), { ...row(0), number: undefined, subject: 'new' }];
    expect(columns(rows, { search: '' })[0].rows.map(r => r.subject)).toEqual([
      'new',
      's2',
      's5',
    ]);
  });
});

describe('search and label filter', () => {
  const r = row(42, {
    title: 'Keep the selected calendar after refresh',
    labels: [{ name: 'bug', color: '#d73a4a' }, { name: 'good first issue' }],
  });

  it.each([
    ['refresh', true],
    ['REFRESH calendar', true],
    ['42', true],
    ['#42', true],
    ['4', false],
    ['good first', true],
    ['missing', false],
    ['', true],
  ])('matches %j: %s', (search, expected) => {
    expect(matches(r, { search })).toBe(expected);
  });

  it('filters by exact label name', () => {
    expect(matches(r, { search: '', label: 'bug' })).toBe(true);
    expect(matches(r, { search: '', label: 'bu' })).toBe(false);
    expect(matches(r, { search: 'refresh', label: 'design' })).toBe(false);
  });

  it('counts open and done, or what the filter shows', () => {
    const rows = [row(1), row(2, { status: 'Done' }), row(3, { status: 'Doing' })];
    expect(countText(rows, { search: '' })).toBe('2 open · 1 done');
    expect(countText(rows, { search: '2' })).toBe('1 of 3 shown');
  });
});

describe('responsive defaults', () => {
  it.each([
    [380, 's', 'list'],
    [700, 'm', 'list'],
    [719, 'm', 'list'],
    [720, 'l', 'board'],
    [1000, 'xl', 'board'],
  ] as const)('%i px is size %s with the %s', (width, size, layout) => {
    expect(sizeFor(width)).toBe(size);
    expect(layoutFor(sizeFor(width))).toBe(layout);
  });

  it('keeps an explicit choice at every width', () => {
    expect(layoutFor('s', 'board')).toBe('board');
    expect(layoutFor('xl', 'list')).toBe('list');
  });
});

describe('sync pill', () => {
  const now = 1000 + 3 * 60_000;

  it.each<[ViewState, string, string]>([
    [{ kind: 'not-connected' }, 'idle', 'Not connected'],
    [{ kind: 'connecting' }, 'syncing', 'Connecting…'],
    [ready(), 'synced', 'Synced 3 min ago'],
    [ready({ busy: 'syncing' }), 'syncing', 'Syncing…'],
    [ready({ busy: 'syncing', last: undefined }), 'syncing', 'Importing…'],
    [ready({ busy: 'sending' }), 'syncing', 'Sending…'],
    [
      ready({ problem: { kind: 'conflict', message: '', subject: 'x', fields: [] } }),
      'paused',
      'Sync paused',
    ],
    [
      ready({ problem: { kind: 'paused', message: '', reason: 'uncertain' } }),
      'paused',
      'Sync paused',
    ],
    [ready({ problem: { kind: 'reconnect', message: '' } }), 'reauth', 'Reconnect needed'],
    [ready({ problem: { kind: 'failed', message: '' } }), 'error', 'Sync failed'],
  ])('%j → %s', (state, pill, text) => {
    expect(pillFor(state, now)).toEqual({ state: pill, text });
  });

  it('shows none where the host cannot relay', () => {
    expect(pillFor({ kind: 'no-proxy' }, now)).toBeUndefined();
  });
});

describe('banners', () => {
  it('maps each problem to exactly one banner, and a transient failure to none', () => {
    const kinds = [
      [{ kind: 'reconnect', message: 'GitHub list_issues returned 401' }, 'neg', 'Reconnect GitHub'],
      [{ kind: 'conflict', message: 'm', subject: 'x', fields: ['title'], local: 's1' }, 'warn', 'Review conflict'],
      [{ kind: 'paused', message: 'Uncertain GitHub write (create_issue)', reason: 'uncertain' }, 'warn', 'Sync now'],
      [{ kind: 'paused', message: 'Missing remote record: x', reason: 'missing' }, 'warn', 'Check on GitHub'],
      [{ kind: 'paused', message: 'Atomic write rejected: x', reason: 'rejected' }, 'neg', 'Try again'],
      [{ kind: 'paused', message: 'Duplicate external identity', reason: 'other' }, 'warn', 'Sync now'],
    ] as const;

    for (const [problem, tone, action] of kinds) {
      const banner = bannerFor(ready({ problem }))!;
      expect(banner.tone).toBe(tone);
      expect(banner.actions.map(a => a.label)).toContain(action);
      expect(banner.problem).toEqual(problem);
    }

    expect(
      bannerFor(ready({ problem: { kind: 'failed', message: '502' } })),
    ).toBeUndefined();
  });

  it('names the conflicting issue by number', () => {
    const banner = bannerFor(
      ready({
        problem: { kind: 'conflict', message: '', subject: 'x', fields: ['title'], local: 's2' },
      }),
    )!;
    expect(banner.text).toMatch(/^#2 was changed both here and on GitHub/);
  });

  it('offers "Send again" for a held write that got no answer', () => {
    const held: Held = {
      subject: 'b',
      entity: 'issue',
      remoteId: 1,
      after: { title: 'x', body: '', status: 'Done' },
      key: 'k',
      unconfirmed: true,
      local: 's1',
    };
    const banner = bannerFor(ready({ last: { at: 1, result: result([row(1)], [held]) } }))!;
    expect(banner.actions.map(a => a.label)).toEqual(['Check on GitHub', 'Send again']);
  });

  it('explains the first import and keeps moving off until it completes', () => {
    const importing = ready({ busy: 'syncing', last: undefined });
    expect(bannerFor(importing)?.title).toBe('First import running.');
    expect(canMove(importing)).toBe(false);
    expect(canMove(ready({ last: { at: 0, result: result([]) } }))).toBe(false);
    expect(canMove(ready())).toBe(true);
  });
});

describe('card markers', () => {
  const held = (local: string, entity = 'issue'): Held => ({
    subject: 'b',
    entity,
    after: { body: '' },
    key: local,
    local,
  });

  it('marks held and just-edited rows, a held comment on its issue, and a conflict', () => {
    const rows = [
      row(1, { comments: [{ subject: 'm1', body: 'hi' }] }),
      row(2),
      row(3),
      row(4),
    ];
    const state = ready({
      last: { at: 1, result: result(rows, [held('s2'), held('m1', 'comment:b1')]) },
      touched: ['s3'],
      problem: { kind: 'conflict', message: '', subject: 'x', fields: [], local: 's4' },
    });
    expect(Object.fromEntries(markers(state))).toEqual({
      s1: 'waiting',
      s2: 'waiting',
      s3: 'waiting',
      s4: 'conflict',
    });
    expect(markers({ ...state, busy: 'sending' }).get('s2')).toBe('sending');
  });
});

describe('helpers', () => {
  it('writes compact list times', () => {
    const now = Date.parse('2026-09-24T12:00:00Z');
    expect(short('2026-09-24T11:59:30Z', now)).toBe('now');
    expect(short('2026-09-24T10:00:00Z', now)).toBe('2h');
    expect(short('2026-09-21T12:00:00Z', now)).toBe('3d');
    expect(short(undefined, now)).toBe('');
  });

  it('knows when a keystroke belongs to a text field', () => {
    expect(typing({ tagName: 'INPUT' } as unknown as EventTarget)).toBe(true);
    expect(typing({ tagName: 'TEXTAREA' } as unknown as EventTarget)).toBe(true);
    expect(typing({ tagName: 'BUTTON' } as unknown as EventTarget)).toBe(false);
    expect(typing(null)).toBe(false);
  });
});

describe('an issue gone from GitHub', () => {
  const problem = {
    kind: 'paused' as const,
    message: 'Missing remote record: b',
    reason: 'missing' as const,
    missing: { side: 'remote' as const, subject: 'b', entity: 'issue', local: 's2' },
  };

  it('offers Keep here only and Remove from board, and confirms removal inline', () => {
    const offer = bannerFor(ready({ problem }))!;
    expect(offer.title).toBe('#2 is on this board but no longer on GitHub.');
    expect(offer.actions.map(a => a.action)).toEqual(['keep-here', 'remove']);
    const confirm = bannerFor(ready({ problem }), true)!;
    expect(confirm.title).toBe('Remove #2 from this board?');
    expect(confirm.actions.map(a => a.action)).toEqual(['cancel-remove', 'confirm-remove']);
  });

  it('offers no removal for a record deleted from the table', () => {
    const local = { ...problem, missing: { ...problem.missing, side: 'local' as const } };
    expect(bannerFor(ready({ problem: local }), true)!.actions.map(a => a.action)).toEqual([
      'open-github',
      'sync',
    ]);
  });
});
