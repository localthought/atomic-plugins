import { randomUUID } from 'node:crypto';
import type { FakePlatform, PlatformRecord } from './fake-platform.js';
import {
  cleanupTagged,
  markerOf,
  type BidirectionalReflector,
  type Driver,
  type Endpoint,
  type EventInput,
  type MarkerReader,
  type Reviewer,
  type StubReflector,
} from './roles.js';

/** Fields the oracle treats as "the content that must be reflected". */
const COMPARED_FIELDS = ['summary', 'start', 'end'] as const;

/**
 * The correctness oracle. Deliberately independent of the reflector's own
 * mapping: it checks that every source record has a matching reflected record
 * on the compared fields, and that no extra ones appeared.
 */
export function compareReflection(
  source: PlatformRecord[],
  reflected: PlatformRecord[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (reflected.length !== source.length) {
    problems.push(
      `expected ${source.length} reflected record(s), saw ${reflected.length}`,
    );
  }
  for (const src of source) {
    const match = reflected.find((r) =>
      COMPARED_FIELDS.every((f) => deepEqual(r[f], src[f])),
    );
    if (!match) {
      problems.push(
        `no reflected record matches source "${String(src['summary'])}" on ${COMPARED_FIELDS.join('/')}`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** Fields the agenda oracle validates, derived from the Calendar source. */
const AGENDA_FIELDS = ['title', 'startsAt', 'endsAt'] as const;

/**
 * Mapping-aware oracle for Calendar→Agenda. Unlike {@link compareReflection}
 * (which deep-equals identical fields), this validates a genuinely different
 * target shape against the declared field mapping — summary→title,
 * start.dateTime→startsAt, end.dateTime→endsAt — independently of the
 * reflector's own implementation.
 */
export function compareCalendarToAgenda(
  source: PlatformRecord[],
  reflected: PlatformRecord[],
): { ok: boolean; problems: string[] } {
  const problems: string[] = [];
  if (reflected.length !== source.length) {
    problems.push(
      `expected ${source.length} reflected record(s), saw ${reflected.length}`,
    );
  }
  for (const src of source) {
    const start = src['start'] as { dateTime?: unknown } | undefined;
    const end = src['end'] as { dateTime?: unknown } | undefined;
    const want: Record<(typeof AGENDA_FIELDS)[number], unknown> = {
      title: src['summary'],
      startsAt: start?.dateTime,
      endsAt: end?.dateTime,
    };
    const match = reflected.find((r) =>
      AGENDA_FIELDS.every((f) => deepEqual(r[f], want[f])),
    );
    if (!match) {
      problems.push(
        `no agenda record maps source "${String(src['summary'])}" on ${AGENDA_FIELDS.join('/')}`,
      );
    }
  }
  return { ok: problems.length === 0, problems };
}

/** An oracle judges whether `reflected` correctly reflects `source`. */
export type Oracle = (
  source: PlatformRecord[],
  reflected: PlatformRecord[],
) => { ok: boolean; problems: string[] };

export type ReflectionOutcome =
  | { status: 'reflected'; reflected: PlatformRecord[] }
  | { status: 'mismatch'; problems: string[]; reflected: PlatformRecord[] }
  | { status: 'timeout'; seen: number; expected: number };

export interface Scenario {
  driver: Driver;
  reviewer: Reviewer;
  reflector: StubReflector;
  /** Where the driver writes (needed for teardown of the source side). */
  sourcePlatform: FakePlatform;
  sourceCalendar: string;
  events: EventInput[];
  poll?: { timeoutMs?: number; intervalMs?: number };
  /** Correctness oracle (default: Calendar→Calendar content compare). */
  oracle?: Oracle;
  /** How to read the run marker on the target's records, for teardown (default: Calendar shape). */
  targetMarkerOf?: MarkerReader;
}

/**
 * One end-to-end reflection test: drive changes into the source, kick the
 * system under test, wait for the reviewer to observe the result, judge it,
 * and clean up both platforms — all in this one process.
 */
export async function runReflectionScenario(
  s: Scenario,
): Promise<ReflectionOutcome> {
  const runId = `run-${randomUUID()}`;
  const timeoutMs = s.poll?.timeoutMs ?? 3_000;
  const intervalMs = s.poll?.intervalMs ?? 50;

  try {
    // 1. drive changes into the source (awaits them landing on the platform)
    const created = await s.driver.create(s.events, runId);

    // 2. kick the system under test
    s.reflector.reflectNow(runId);

    // 3. wait for the reviewer to observe the reflection on the target
    const reflected = await s.reviewer.awaitReflected(runId, created.length, {
      timeoutMs,
      intervalMs,
    });

    // 4. judge: not-enough-in-time vs wrong vs correct
    if (reflected.length < created.length) {
      return {
        status: 'timeout',
        seen: reflected.length,
        expected: created.length,
      };
    }
    const verdict = (s.oracle ?? compareReflection)(created, reflected);
    return verdict.ok
      ? { status: 'reflected', reflected }
      : { status: 'mismatch', problems: verdict.problems, reflected };
  } finally {
    // 5. cleanup — let any in-flight reflection finish, then drop this run's
    // records from both platforms so runs don't contaminate each other.
    await s.reflector.idle().catch(() => undefined);
    cleanupTagged(s.sourcePlatform, s.sourceCalendar, runId);
    cleanupTagged(
      s.reflector.targetPlatform,
      s.reflector.targetCalendarId,
      runId,
      s.targetMarkerOf,
    );
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export type LoopOutcome =
  | { status: 'stable'; counts: { a: number; b: number } }
  | { status: 'looped'; counts: { a: number; b: number }; expected: number };

export interface LoopScenario {
  driver: Driver;
  reflector: BidirectionalReflector;
  /** The two sides being kept in sync (the driver writes onto `a`). */
  a: Endpoint;
  b: Endpoint;
  events: EventInput[];
  /** How many full A→B→A reflect cycles to run (default 3). */
  cycles?: number;
}

/**
 * Loop/echo test: drive N events onto A, run several full bidirectional
 * reflect cycles, and check that both platforms settle at exactly N run-tagged
 * records. A reflector that re-reflects its own writes makes the counts grow
 * without bound — reported as `looped`.
 */
export async function runLoopScenario(s: LoopScenario): Promise<LoopOutcome> {
  const runId = `run-${randomUUID()}`;
  const cycles = s.cycles ?? 3;
  const expected = s.events.length;

  const tagged = (e: Endpoint): number =>
    e.platform.events(e.calendar).filter((r) => markerOf(r) === runId).length;

  try {
    await s.driver.create(s.events, runId);
    for (let i = 0; i < cycles; i += 1) {
      s.reflector.reflectNow(runId);
      await s.reflector.idle();
    }
    const counts = { a: tagged(s.a), b: tagged(s.b) };
    return counts.a === expected && counts.b === expected
      ? { status: 'stable', counts }
      : { status: 'looped', counts, expected };
  } finally {
    cleanupTagged(s.a.platform, s.a.calendar, runId);
    cleanupTagged(s.b.platform, s.b.calendar, runId);
  }
}
