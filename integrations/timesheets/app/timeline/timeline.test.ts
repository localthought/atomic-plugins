// @wc-ignore-file
/**
 * #123 M2: the timeline lens (map: entry → claim; aggregate: the sweep) and
 * the read-only display of unknown time and conflicts. Scenarios S1, S6 and
 * S7 (display only) run against the Clockify mock through the in-memory
 * store; the merge property, DST and forceProjects cases run on mirrors
 * built directly. The mock's time-zone and filter behaviour is its reading
 * of the live checks on #123, not a recording.
 */
import { describe, expect, it } from 'vitest';
import {
  clockifyEntry,
  PROJECT,
  USER,
  WORKSPACE,
} from '../../fixtures/clockify/scenario.mjs';
import {
  clockifyClaim,
  type TimeLabel,
} from '../../devonian/clockify/lens/claims.js';
import { canonicalEntry, rangeScope, TIME_ENTRY } from '../clockifyObserve.js';
import type { Settings } from '../config.js';
import { fakeStore } from '../fakeStore.js';
import { fixtureProxy } from '../fixtureProxy.js';
import { timesheetFromMirror } from '../model/source.js';
import type { Timesheet } from '../model/types.js';
import {
  diffObservation,
  emptyMirror,
  fold,
  recordKey,
  type Incremental,
  type Mirror,
  type Observation,
} from '../observations.js';
import { ensureSchema } from '../schema.js';
import { syncClockify } from '../sync.js';
import { relayTransport } from '../transport.js';
import { renderConflicts, renderUnknown } from '../ui/coverage.js';
import { builder } from '../ui/dom.js';
import { conflictText, spanText } from './render.js';
import { buildTimeline, claimsOf } from './sweep.js';
import type { Segment, Timeline } from './types.js';

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const NOW = Date.parse('2026-09-23T12:00:00Z');
const ZONE = 'Europe/Amsterdam';
const P = PROJECT.id;
const Q = 'dddddddddddddddddddddddd';
const settings: Settings = {
  workspaceId: WORKSPACE.id,
  userId: USER.id,
  lookbackDays: 7,
};
const WINDOW = { from: NOW - 7 * DAY, to: NOW };
const iso = (at: number) => new Date(at).toISOString().replace('.000Z', 'Z');

/** One sync against the mock, with `extra` entries added first. */
async function synced(extra: ReturnType<typeof clockifyEntry>[] = []) {
  const proxy = fixtureProxy(NOW);
  proxy.fixture.state.entries.push(...extra);
  const store = fakeStore({ proxy: proxy.request });
  const schema = await ensureSchema(store);
  const result = await syncClockify(
    store,
    relayTransport(store.proxy!, { platform: 'clockify', connectionId: 'c' }),
    settings,
    schema,
    NOW,
    { clock: () => NOW, newId: () => 'obs-1', device: 'test' },
  );
  const timeline = buildTimeline({
    mirror: result.mirror,
    settings,
    window: WINDOW,
    now: NOW,
    timeZone: result.account.timeZone!,
    forceProjects: result.account.forceProjects,
  });
  const sheet = timesheetFromMirror({
    mirror: result.mirror,
    projects: result.projects,
    members: result.members,
    settings,
    now: NOW,
    timeZone: result.account.timeZone!,
    forceProjects: result.account.forceProjects,
  });

  return { result, timeline, sheet };
}

const segments = (timeline: Timeline) => timeline.days.flatMap(d => d.segments);

const segmentAt = (timeline: Timeline, t: number): Segment | undefined =>
  segments(timeline).find(s => s.from <= t && t < s.to);

const text = (label: TimeLabel | undefined) =>
  !label
    ? '?'
    : label.kind === 'worked'
      ? `worked(${label.projectId ?? 'none'})`
      : `didNotWork${label.badge ? `(${label.badge})` : ''}`;

/** `worked(P)`, `unknown`, `conflict:whichProject[worked(P),worked(Q)]`… */
function stateAt(timeline: Timeline, t: number): string {
  const s = segmentAt(timeline, t);
  if (!s) return 'none';
  if (s.state === 'unknown') return 'unknown';
  if (s.state === 'conflict')
    return `conflict:${s.conflict!.kind}[${s.conflict!.candidates.map(text).join(',')}]`;

  return `${text(s.label)}${s.duplicate ? '+duplicate' : ''}${s.open ? '+open' : ''}`;
}

/** Every day is covered by its segments, in order, without gaps or overlap. */
function expectTiled(timeline: Timeline) {
  for (const day of timeline.days) {
    expect(day.segments[0].from).toBe(day.from);
    expect(day.segments.at(-1)!.to).toBe(day.to);

    for (let i = 1; i < day.segments.length; i++)
      expect(day.segments[i].from).toBe(day.segments[i - 1].to);
  }

  for (let i = 1; i < timeline.days.length; i++)
    expect(timeline.days[i].from).toBe(timeline.days[i - 1].to);
}

/** A mirror with `entries` and complete coverage of starts over `covered`. */
function mirrorOf(
  entries: ReturnType<typeof clockifyEntry>[],
  covered: { from: number; to: number },
): Mirror {
  const observation: Observation = {
    id: 'obs-1',
    device: 'test',
    sentAt: iso(covered.to),
    receivedAt: iso(covered.to),
    kind: 'list',
    scope: rangeScope(settings, iso(covered.from), iso(covered.to)),
    mask: Object.keys(
      canonicalEntry(entries[0] ?? clockifyEntry('x', '', 0, 1)).fields,
    ),
    complete: true,
    records: entries.map(canonicalEntry),
  };

  return fold(emptyMirror(), [diffObservation(emptyMirror(), observation)]);
}

describe('map stage: clockifyClaim', () => {
  const claim = (extra: Record<string, unknown>, end: number | null = NOW) =>
    clockifyClaim(
      canonicalEntry(clockifyEntry('e', 'd', NOW - HOUR, end, extra)),
      NOW + HOUR,
    );

  it('maps entries to claims, keeping the exact instant strings', () => {
    expect(claim({})).toEqual({
      entryId: 'e',
      from: '2026-09-23T11:00:00Z',
      to: '2026-09-23T12:00:00Z',
      label: { kind: 'worked', projectId: P },
    });
    expect(claim({ projectId: null })!.label).toEqual({
      kind: 'worked',
      projectId: null,
    });
    expect(claim({ type: 'BREAK' })!.label).toEqual({
      kind: 'didNotWork',
      badge: 'break',
    });
    expect(claim({ type: 'TIME_OFF' })!.label).toEqual({
      kind: 'didNotWork',
      badge: 'timeOff',
    });
    expect(claim({ type: 'HOLIDAY', isLocked: true })).toMatchObject({
      label: { kind: 'didNotWork', badge: 'holiday' },
      locked: true,
    });
    expect(
      claim({ customFieldValues: [{ customFieldId: 'f', value: 'x' }] }),
    ).toMatchObject({ customFields: true });
  });

  it('claims a running timer up to now, flagged open', () => {
    expect(claim({}, null)).toMatchObject({
      to: '2026-09-23T13:00:00Z',
      open: true,
    });
  });

  it('makes no claim for an entry without a valid, positive interval', () => {
    expect(claim({}, NOW - HOUR)).toBeUndefined();
    expect(
      clockifyClaim({ id: 'x', fields: { start: 'soon', end: null } }, NOW),
    ).toBeUndefined();
  });
});

describe('timeline scenarios (#123 M2, display only)', () => {
  it('S1: first sync — 2 worked, 1 open, 1 break, the rest did not work; before the window unknown', async () => {
    const { timeline, sheet } = await synced();

    expect(timeline.timeZone).toBe(ZONE);
    // Local days from the one holding the window's start (16 Sep, 14:00
    // CEST) to now (23 Sep, 14:00 CEST).
    expect(timeline.days.map(d => d.day)).toEqual([
      '2026-09-16',
      '2026-09-17',
      '2026-09-18',
      '2026-09-19',
      '2026-09-20',
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
    ]);
    expect(timeline.days[0].from).toBe(Date.parse('2026-09-15T22:00:00Z'));
    expect(timeline.days.at(-1)!.to).toBe(NOW);
    expectTiled(timeline);

    const at = (s: string) => stateAt(timeline, Date.parse(s));
    // entry-1 and entry-2 yesterday, the break (entry-5), the timer (entry-4).
    expect(at('2026-09-22T09:00:00Z')).toBe(`worked(${P})`);
    expect(at('2026-09-22T11:30:00Z')).toBe(`worked(${P})`);
    expect(at('2026-09-22T13:30:00Z')).toBe('didNotWork(break)');
    expect(at('2026-09-23T11:30:00Z')).toBe(`worked(${P})+open`);
    expect(at('2026-09-20T12:00:00Z')).toBe('didNotWork');
    expect(at('2026-09-22T10:30:00Z')).toBe('didNotWork');
    // Before the window: no complete read proves anything there.
    expect(at('2026-09-16T08:00:00Z')).toBe('unknown');
    expect(at('2026-09-16T12:00:00Z')).toBe('didNotWork');
    expect(segmentAt(timeline, Date.parse('2026-09-16T08:00:00Z'))).toEqual({
      from: Date.parse('2026-09-15T22:00:00Z'),
      to: WINDOW.from,
      state: 'unknown',
      entryIds: [],
      readOnly: ['unknown'],
    });
    // Read-only reasons carry through.
    expect(
      segmentAt(timeline, Date.parse('2026-09-23T11:30:00Z'))!.readOnly,
    ).toEqual(['running']);
    expect(
      segmentAt(timeline, Date.parse('2026-09-22T13:30:00Z'))!.readOnly,
    ).toEqual(['entryType']);
    // Inside the window everything is known, and nothing conflicts.
    expect(timeline.unknown).toEqual([]);
    expect(timeline.conflicts).toEqual([]);
    expect(sheet.conflicts).toEqual([]);
  });

  it('S6: two overlapping entries with different projects are one conflict over the overlap, shown read-only', async () => {
    const { timeline, sheet } = await synced([
      clockifyEntry(
        'entry-6',
        'Other project',
        Date.parse('2026-09-22T09:00:00Z'),
        Date.parse('2026-09-22T11:00:00Z'),
        { projectId: Q },
      ),
    ]);

    const at = (s: string) => stateAt(timeline, Date.parse(s));
    // entry-1 is 08:00–10:00 UTC with P; entry-6 09:00–11:00 with Q.
    expect(at('2026-09-22T08:30:00Z')).toBe(`worked(${P})`);
    expect(at('2026-09-22T09:30:00Z')).toBe(
      `conflict:whichProject[worked(${P}),worked(${Q})]`,
    );
    expect(at('2026-09-22T10:30:00Z')).toBe(`worked(${Q})`);
    expect(timeline.conflicts).toEqual([
      {
        entryId: 'entry-1',
        entryIds: ['entry-1', 'entry-6'],
        fields: ['projectId'],
        kind: 'whichProject',
        candidates: [
          { kind: 'worked', projectId: P },
          { kind: 'worked', projectId: Q },
        ],
        from: Date.parse('2026-09-22T09:00:00Z'),
        to: Date.parse('2026-09-22T10:00:00Z'),
      },
    ]);
    // The views' Timesheet carries it, as a Conflict with the extra fields.
    expect(sheet.conflicts).toEqual(timeline.conflicts);
    expect(conflictText(sheet.conflicts[0], sheet)).toBe(
      'Unclear which project: Atomic plugins · Project dddddd (2 entries), 22 Sep 11:00 – 12:00',
    );
  });

  it('S7: two overlapping entries of the same project are worked with a duplicate mark', async () => {
    const { timeline, sheet } = await synced([
      clockifyEntry(
        'entry-7',
        'Fix plugin source loading',
        Date.parse('2026-09-22T08:30:00Z'),
        Date.parse('2026-09-22T09:30:00Z'),
      ),
    ]);

    const overlap = segmentAt(timeline, Date.parse('2026-09-22T09:00:00Z'))!;
    expect(overlap).toMatchObject({
      state: 'worked',
      label: { kind: 'worked', projectId: P },
      duplicate: true,
      entryIds: ['entry-1', 'entry-7'],
      from: Date.parse('2026-09-22T08:30:00Z'),
      to: Date.parse('2026-09-22T09:30:00Z'),
    });
    expect(timeline.conflicts).toEqual([
      expect.objectContaining({
        kind: 'duplicate',
        fields: ['start', 'end'],
        entryIds: ['entry-1', 'entry-7'],
      }),
    ]);
    expect(conflictText(sheet.conflicts[0], sheet)).toBe(
      'Atomic plugins twice (2 entries), 22 Sep 10:30 – 11:30',
    );
  });
});

describe('conflict kinds (#97 answer 3)', () => {
  const t = (h: number) => NOW - DAY + h * HOUR;
  const covered = { from: NOW - 10 * DAY, to: NOW };
  const timelineOf = (
    entries: ReturnType<typeof clockifyEntry>[],
    forceProjects = false,
  ) =>
    buildTimeline({
      mirror: mirrorOf(entries, covered),
      settings,
      window: WINDOW,
      now: NOW,
      timeZone: ZONE,
      forceProjects,
    });

  it('worked(none) is a label; overlapping a project it is "unclear which project"', () => {
    const timeline = timelineOf([
      clockifyEntry('a', '', t(0), t(2), { projectId: null }),
      clockifyEntry('b', '', t(1), t(3)),
    ]);

    expect(stateAt(timeline, t(0.5))).toBe('worked(none)');
    expect(stateAt(timeline, t(1.5))).toBe(
      `conflict:whichProject[worked(${P}),worked(none)]`,
    );
  });

  it('worked overlapping a break is "unclear whether worked"', () => {
    const timeline = timelineOf([
      clockifyEntry('a', '', t(0), t(2)),
      clockifyEntry('b', '', t(1), t(3), { type: 'BREAK' }),
    ]);

    expect(stateAt(timeline, t(1.5))).toBe(
      `conflict:whetherWorked[worked(${P}),didNotWork(break)]`,
    );
    expect(timeline.conflicts[0]).toMatchObject({
      kind: 'whetherWorked',
      fields: ['type'],
    });
  });

  it('forceProjects: worked(none) is read-only, a project entry is not', () => {
    const entries = [
      clockifyEntry('a', '', t(0), t(1), { projectId: null }),
      clockifyEntry('b', '', t(2), t(3)),
    ];
    const on = timelineOf(entries, true);
    const off = timelineOf(entries, false);

    expect(segmentAt(on, t(0.5))!.readOnly).toEqual(['forceProjects']);
    expect(segmentAt(on, t(2.5))!.readOnly).toEqual([]);
    expect(segmentAt(off, t(0.5))!.readOnly).toEqual([]);
    // Still a label, not a conflict.
    expect(on.conflicts).toEqual([]);
  });

  it('an absence candidate is unknown, not did-not-work; a confirmed deletion is did-not-work', () => {
    const mirror = mirrorOf(
      [clockifyEntry('a', '', t(0), t(1)), clockifyEntry('b', '', t(2), t(3))],
      covered,
    );
    mirror.records[recordKey(TIME_ENTRY, 'a')].absentSince = iso(NOW);
    mirror.records[recordKey(TIME_ENTRY, 'b')].deletedAt = iso(NOW);
    const timeline = buildTimeline({
      mirror,
      settings,
      window: WINDOW,
      now: NOW,
      timeZone: ZONE,
    });

    expect(stateAt(timeline, t(0.5))).toBe('unknown');
    expect(stateAt(timeline, t(2.5))).toBe('didNotWork');
    expect(claimsOf(mirror, settings, NOW)).toEqual([]);
  });

  it("ignores other users' and workspaces' entries", () => {
    const timeline = timelineOf([
      clockifyEntry('a', '', t(0), t(1), { userId: 'someone-else' }),
    ]);

    expect(stateAt(timeline, t(0.5))).toBe('didNotWork');
  });
});

describe('daylight-saving days in the profile time zone', () => {
  const dstTimeline = (
    now: number,
    entries: ReturnType<typeof clockifyEntry>[],
  ) =>
    buildTimeline({
      mirror: mirrorOf(entries, { from: now - 20 * DAY, to: now }),
      settings,
      window: { from: now - 7 * DAY, to: now },
      now,
      timeZone: ZONE,
    });

  it('25 October 2026 is a 25-hour day; an entry across the repeated hour stays one hour', () => {
    const now = Date.parse('2026-10-27T12:00:00Z');
    // 00:30–01:30 UTC = 02:30 CEST – 02:30 CET.
    const timeline = dstTimeline(now, [
      clockifyEntry(
        'a',
        '',
        Date.parse('2026-10-25T00:30:00Z'),
        Date.parse('2026-10-25T01:30:00Z'),
      ),
    ]);
    const day = timeline.days.find(d => d.day === '2026-10-25')!;

    expect(day.to - day.from).toBe(25 * HOUR);
    expect(day.from).toBe(Date.parse('2026-10-24T22:00:00Z'));
    expectTiled(timeline);
    const worked = day.segments.filter(s => s.state === 'worked');
    expect(worked).toHaveLength(1);
    expect(worked[0].to - worked[0].from).toBe(HOUR);
    expect(spanText(worked[0], ZONE)).toBe('25 Oct 02:30 – 02:30');
  });

  it('29 March 2026 is a 23-hour day; an entry across the skipped hour stays one hour', () => {
    const now = Date.parse('2026-03-31T12:00:00Z');
    // 00:30–01:30 UTC = 01:30 CET – 03:30 CEST.
    const timeline = dstTimeline(now, [
      clockifyEntry(
        'a',
        '',
        Date.parse('2026-03-29T00:30:00Z'),
        Date.parse('2026-03-29T01:30:00Z'),
      ),
    ]);
    const day = timeline.days.find(d => d.day === '2026-03-29')!;

    expect(day.to - day.from).toBe(23 * HOUR);
    expectTiled(timeline);
    const [worked] = day.segments.filter(s => s.state === 'worked');
    expect(worked.to - worked.from).toBe(HOUR);
    expect(spanText(worked, ZONE)).toBe('29 Mar 01:30 – 03:30');
  });
});

/** Mulberry32: a small seeded PRNG, so a failure is reproducible. */
function prng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let x = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x;

    return ((x ^ (x >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(items: T[], random: () => number): T[] {
  const out = [...items];

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}

describe('merge property (#123 §5.3, provider-only claims)', () => {
  it('any two replicas with the same observations produce identical segments and conflicts', () => {
    for (let seed = 1; seed <= 40; seed++) {
      const random = prng(seed);
      const minute = 60_000;
      const at = () =>
        NOW - 8 * DAY + Math.floor(random() * 8 * 24 * 60) * minute;
      const projects = [P, Q, null];
      const types = ['REGULAR', 'REGULAR', 'REGULAR', 'BREAK'];
      // Several reads, each a list observation over part of the time, some
      // incomplete, some seeing changed versions of the same entries.
      const incrementals: Incremental[] = [];
      let mirror = emptyMirror();

      for (let read = 0; read < 6; read++) {
        const entries = Array.from(
          { length: 1 + Math.floor(random() * 8) },
          () => {
            const start = at();
            const running = random() < 0.05;

            return clockifyEntry(
              `e${Math.floor(random() * 12)}`,
              '',
              start,
              running
                ? null
                : start + (1 + Math.floor(random() * 240)) * minute,
              {
                projectId: projects[Math.floor(random() * 3)],
                type: types[Math.floor(random() * 4)],
              },
            );
          },
        );
        const from = NOW - 9 * DAY + Math.floor(random() * 3) * DAY;
        const receivedAt = iso(NOW - (6 - read) * HOUR);
        const observation: Observation = {
          id: `obs-${seed}-${read}`,
          device: `device-${read % 2}`,
          sentAt: receivedAt,
          receivedAt,
          kind: 'list',
          scope: rangeScope(settings, iso(from), iso(NOW)),
          mask: Object.keys(canonicalEntry(entries[0]).fields),
          complete: random() < 0.8,
          records: [...new Map(entries.map(e => [e.id, e])).values()]
            .filter(e => Date.parse(e.timeInterval.start) >= from)
            .map(canonicalEntry),
        };
        const incremental = diffObservation(mirror, observation);
        incrementals.push(incremental);
        mirror = fold(mirror, [incremental]);
      }

      const replica = (order: Incremental[]) => {
        const folded = fold(emptyMirror(), order);
        // Also vary the record order the sweep sees.
        folded.records = Object.fromEntries(
          shuffle(Object.entries(folded.records), random),
        );

        return buildTimeline({
          mirror: folded,
          settings,
          window: WINDOW,
          now: NOW,
          timeZone: ZONE,
        });
      };

      const a = replica(incrementals);
      const b = replica(shuffle(incrementals, random));

      expect(b).toEqual(a);
      expectTiled(a);
      expect(JSON.stringify(b)).toBe(JSON.stringify(a));
    }
  });
});

/** Just enough of a Document for `builder`: elements with text content. */
function fakeDocument(): Document {
  class Node {
    children: Node[] = [];
    attrs: Record<string, string> = {};
    constructor(
      readonly ownerDocument: unknown,
      readonly tagName: string,
      readonly data = '',
    ) {}
    setAttribute(name: string, value: string) {
      this.attrs[name] = value;
    }
    getAttribute(name: string) {
      return this.attrs[name] ?? null;
    }
    appendChild(child: Node) {
      this.children.push(child);

      return child;
    }
    get textContent(): string {
      return this.data + this.children.map(c => c.textContent).join('');
    }
  }
  const doc = {
    createElement: (tag: string) => new Node(doc, tag),
    createTextNode: (data: string) => new Node(doc, '#text', data),
  };

  return doc as unknown as Document;
}

describe('rendering hooks (ui/coverage.ts)', () => {
  const h = builder(fakeDocument());

  it('renders nothing without unknown time or conflicts', async () => {
    const { sheet } = await synced();

    expect(renderUnknown(h, sheet, WINDOW, [])).toBeNull();
    expect(renderConflicts(h, sheet)).toBeNull();
  });

  it('renders unknown spans as a "Not loaded" note in the profile time zone', async () => {
    const { sheet } = await synced();
    const note = renderUnknown(h, sheet, WINDOW, [
      { from: Date.parse('2026-09-15T22:00:00Z'), to: WINDOW.from },
    ])!;

    expect(note.getAttribute('role')).toBe('note');
    expect(note.textContent).toBe(
      'Not loaded: 16 Sep 00:00 – 14:00. No complete read of Clockify covers this time, so it is not shown as “did not work”.',
    );
  });

  it('renders conflicts as a read-only list, and a plain Conflict by entry and fields', async () => {
    const { sheet } = await synced([
      clockifyEntry(
        'entry-6',
        '',
        Date.parse('2026-09-22T09:00:00Z'),
        Date.parse('2026-09-22T11:00:00Z'),
        { projectId: null },
      ),
    ]);
    const list = renderConflicts(h, sheet)!;

    expect(list.getAttribute('aria-label')).toBe('Conflicts in Clockify');
    expect(list.textContent).toBe(
      '1 conflict in Clockify (read-only for now: fix them in Clockify)' +
        'Unclear which project: Atomic plugins · No project (2 entries), 22 Sep 11:00 – 12:00',
    );
    const plain: Timesheet = {
      ...sheet,
      conflicts: [{ entryId: 'x', fields: ['projectId'] }],
    };
    expect(conflictText(plain.conflicts[0], plain)).toBe(
      'Entry x: projectId disagree',
    );
  });
});
