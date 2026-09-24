// @wc-ignore-file
/**
 * Fold property tests (#123 §5.3), pure: no mock, no store. Random
 * observation sets come from a seeded generator, so a failure names the
 * seed that reproduces it.
 */
import { describe, expect, it } from 'vitest';
import {
  addCoverage,
  diffObservation,
  emptyMirror,
  fold,
  mirrorDigest,
  recordKey,
  sortCoverage,
  type Incremental,
  type Json,
  type Mirror,
  type Observation,
} from './observations.js';

const T0 = Date.parse('2026-09-01T00:00:00Z');
const HOUR = 3_600_000;
const at = (hours: number) =>
  new Date(T0 + hours * HOUR).toISOString().replace('.000', '');
/** Scope params are record fields, so a read that proves absence must
 * return them (Clockify's reads return every field). */
const MASK = [
  'start',
  'end',
  'projectId',
  'description',
  'workspaceId',
  'userId',
];
const PARAMS = { workspaceId: 'ws', userId: 'u' };

/** mulberry32: small, seedable, good enough for test data. */
function random(seed: number) {
  let a = seed >>> 0;

  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface World {
  /** What "the provider" holds at each step, by id. */
  entries: Map<string, Record<string, Json>>;
}

/**
 * A sequence of observations of a changing provider: range reads over a
 * random span of starts (sometimes incomplete) and point reads (sometimes
 * of a deleted entry), with coarse `receivedAt` values so that ties occur.
 */
function scenario(seed: number, steps = 40): Observation[] {
  const next = random(seed);
  const pick = <T>(xs: T[]) => xs[Math.floor(next() * xs.length)];
  const world: World = { entries: new Map() };
  const ids = Array.from({ length: 8 }, (_, i) => `e${i}`);
  const observations: Observation[] = [];

  for (let step = 0; step < steps; step++) {
    // The provider changes a little between reads.
    const id = pick(ids);

    if (next() < 0.2) world.entries.delete(id);
    else {
      const start = Math.floor(next() * 48);
      world.entries.set(id, {
        start: at(start),
        end: next() < 0.1 ? null : at(start + 1 + Math.floor(next() * 3)),
        projectId: pick(['p1', 'p2', null]),
        description: pick(['a', 'b', 'c']),
        workspaceId: 'ws',
        userId: 'u',
      });
    }

    const receivedAt = at(100 + Math.floor(step / 3));
    const base = {
      id: `o${String(step).padStart(3, '0')}`,
      device: pick(['d1', 'd2']),
      sentAt: receivedAt,
      receivedAt,
      mask: next() < 0.2 ? ['description'] : MASK,
    };

    if (next() < 0.7) {
      const from = Math.floor(next() * 40);
      const to = from + 1 + Math.floor(next() * 20);
      const records = [...world.entries.entries()]
        .filter(([, f]) => {
          const h = (Date.parse(f.start as string) - T0) / HOUR;

          return h >= from && h < to;
        })
        .map(([rid, fields]) => ({ id: rid, fields }));
      const complete = next() < 0.85;
      observations.push({
        ...base,
        kind: 'list',
        scope: {
          type: 'range',
          collection: 'timeEntry',
          params: PARAMS,
          field: 'start',
          from: at(from),
          to: at(to),
        },
        complete,
        records: complete ? records : records.slice(0, records.length >> 1),
      });
    } else {
      const target = pick(ids);
      const fields = world.entries.get(target);
      observations.push({
        ...base,
        kind: 'point',
        scope: { type: 'id', collection: 'timeEntry', id: target },
        complete: true,
        records: fields ? [{ id: target, fields }] : [],
      });
    }
  }

  return observations;
}

/** Appends observations in order, as one device does: diff, then fold. */
function append(observations: Observation[], start: Mirror = emptyMirror()) {
  let mirror = start;
  const incrementals: Incremental[] = [];

  for (const observation of observations) {
    const incremental = diffObservation(mirror, observation);
    incrementals.push(incremental);
    mirror = fold(mirror, [incremental]);
  }

  return { mirror, incrementals };
}

function shuffle<T>(xs: T[], seed: number): T[] {
  const next = random(seed);
  const out = [...xs];

  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }

  return out;
}

const SEEDS = Array.from({ length: 40 }, (_, i) => 1000 + i);

describe('fold properties', () => {
  it.each(SEEDS)(
    'seed %i: appending one by one equals folding the stored incrementals from scratch',
    seed => {
      const { mirror, incrementals } = append(scenario(seed));

      expect(mirrorDigest(fold(emptyMirror(), incrementals))).toBe(
        mirrorDigest(mirror),
      );
    },
  );

  it.each(SEEDS)(
    'seed %i: any permutation of the incrementals folds to the same mirror',
    seed => {
      const { incrementals } = append(scenario(seed));
      const expected = mirrorDigest(fold(emptyMirror(), incrementals));

      for (const shuffleSeed of [1, 2, 3])
        expect(
          mirrorDigest(
            fold(emptyMirror(), shuffle(incrementals, seed * 10 + shuffleSeed)),
          ),
        ).toBe(expected);
    },
  );

  it.each(SEEDS)(
    'seed %i: a snapshot of any prefix plus the tail equals the full fold',
    seed => {
      const { incrementals } = append(scenario(seed));
      const full = mirrorDigest(fold(emptyMirror(), incrementals));

      for (let cut = 0; cut <= incrementals.length; cut += 7) {
        const snapshot = fold(emptyMirror(), incrementals.slice(0, cut));
        // A snapshot survives a JSON round trip, as it does in storage.
        const stored = JSON.parse(JSON.stringify(snapshot)) as Mirror;
        expect(mirrorDigest(fold(stored, incrementals.slice(cut)))).toBe(full);
      }
    },
  );

  it.each(SEEDS)(
    'seed %i: two devices that exchange their incrementals fold to the same mirror',
    seed => {
      const observations = scenario(seed);
      // Each device diffs only its own reads against its own mirror.
      const one = append(observations.filter(o => o.device === 'd1'));
      const two = append(observations.filter(o => o.device === 'd2'));
      // Each device folds the union from scratch (another device's
      // incrementals can sort before its own, so they are not folded on
      // top of its mirror; see ObservationLog.open).
      const onDeviceOne = [...one.incrementals, ...two.incrementals];
      const onDeviceTwo = [...two.incrementals, ...one.incrementals];

      expect(mirrorDigest(fold(emptyMirror(), onDeviceOne))).toBe(
        mirrorDigest(fold(emptyMirror(), onDeviceTwo)),
      );
      expect(
        mirrorDigest(fold(emptyMirror(), shuffle(onDeviceOne, seed))),
      ).toBe(mirrorDigest(fold(emptyMirror(), onDeviceTwo)));
    },
  );

  it.each(SEEDS)(
    "seed %i: every record's fields are those of the latest read that returned them",
    seed => {
      const observations = scenario(seed);
      const { mirror } = append(observations);
      const latest = new Map<string, Record<string, Json>>();

      for (const o of observations)
        for (const r of o.records)
          latest.set(r.id, {
            ...(latest.get(r.id) ?? {}),
            ...Object.fromEntries(o.mask.map(f => [f, r.fields[f] ?? null])),
          });

      for (const [id, fields] of latest)
        expect(mirror.records[recordKey('timeEntry', id)].fields).toEqual(
          fields,
        );
    },
  );
});

describe('mask-diff', () => {
  const read = (
    id: string,
    records: Observation['records'],
    extra: Partial<Observation> = {},
  ): Observation => ({
    id,
    device: 'd',
    sentAt: at(100),
    receivedAt: at(100),
    kind: 'list',
    scope: {
      type: 'range',
      collection: 'timeEntry',
      params: PARAMS,
      field: 'start',
      from: at(0),
      to: at(10),
    },
    mask: MASK,
    complete: true,
    records,
    ...extra,
  });
  const entry = (id: string, fields: Record<string, Json> = {}) => ({
    id,
    fields: {
      start: at(1),
      end: at(2),
      projectId: 'p1',
      description: 'a',
      workspaceId: 'ws',
      userId: 'u',
      ...fields,
    },
  });

  it('never clears a field outside the mask', () => {
    const { mirror } = append([
      read('o1', [entry('e1')]),
      read('o2', [entry('e1', { description: 'b', projectId: null })], {
        receivedAt: at(101),
        mask: ['description'],
      }),
    ]);

    expect(mirror.records['timeEntry/e1'].fields).toMatchObject({
      description: 'b',
      projectId: 'p1',
    });
  });

  it('stores nothing for an unchanged read, and only a candidate for a missing record', () => {
    const first = append([read('o1', [entry('e1'), entry('e2')])]);
    const same = diffObservation(
      first.mirror,
      read('o2', [entry('e1'), entry('e2')]),
    );
    const missing = diffObservation(first.mirror, read('o3', [entry('e1')]));
    const partial = diffObservation(
      first.mirror,
      read('o4', [entry('e1')], { complete: false }),
    );

    expect(same).toMatchObject({ upserts: [], absent: [], unchanged: 2 });
    expect(missing).toMatchObject({ upserts: [], absent: ['e2'] });
    expect(partial.absent).toEqual([]);
    const after = fold(first.mirror, [missing]);
    expect(after.records['timeEntry/e2']).toMatchObject({
      absentSince: at(100),
    });
    expect(after.records['timeEntry/e2'].deletedAt).toBeUndefined();
  });

  it('confirms a deletion only from a point read, and a later read restores the record', () => {
    const { mirror } = append([
      read('o1', [entry('e1')]),
      read('o2', [], { receivedAt: at(101) }),
      read('o3', [], {
        receivedAt: at(102),
        kind: 'point',
        scope: { type: 'id', collection: 'timeEntry', id: 'e1' },
      }),
    ]);

    expect(mirror.records['timeEntry/e1']).toMatchObject({
      deletedAt: at(102),
    });
    const back = append(
      [read('o4', [entry('e1')], { receivedAt: at(103) })],
      mirror,
    ).mirror;
    expect(back.records['timeEntry/e1'].deletedAt).toBeUndefined();
    expect(back.records['timeEntry/e1'].absentSince).toBeUndefined();
  });

  it('judges scope from the mirror: a record moved out of the window is a candidate, not a deletion', () => {
    const first = append([read('o1', [entry('e1')])]);
    // The provider moved e1 to start at hour 20, outside [0, 10).
    const moved = diffObservation(first.mirror, read('o2', []));

    expect(moved.absent).toEqual(['e1']);
    expect(fold(first.mirror, [moved]).records['timeEntry/e1'].deletedAt).toBe(
      undefined,
    );
  });
});

describe('coverage', () => {
  it('keeps the latest confirmation per span and merges equal neighbours', () => {
    let coverage = addCoverage([], 'k', at(0), at(10), at(100));
    coverage = addCoverage(coverage, 'k', at(5), at(15), at(101));
    coverage = addCoverage(coverage, 'k', at(15), at(20), at(101));
    coverage = addCoverage(coverage, 'other', at(0), at(1), at(99));

    expect(sortCoverage(coverage)).toEqual([
      { key: 'k', from: at(0), to: at(5), confirmedAt: at(100) },
      { key: 'k', from: at(5), to: at(20), confirmedAt: at(101) },
      { key: 'other', from: at(0), to: at(1), confirmedAt: at(99) },
    ]);
    // An older confirmation does not move a newer one back.
    expect(
      sortCoverage(addCoverage(coverage, 'k', at(0), at(20), at(50))),
    ).toEqual(sortCoverage(coverage));
  });
});
