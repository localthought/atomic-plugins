import { describe, expect, it } from 'vitest';
import { FakePlatform } from './fake-platform.js';
import {
  Driver,
  Reviewer,
  StubReflector,
  identityMapping,
  type EventInput,
  type Mapping,
} from './roles.js';
import { runReflectionScenario, type Scenario } from './scenario.js';

const SOURCE_CAL = 'cal-a';
const TARGET_CAL = 'cal-b';

const events: EventInput[] = [
  {
    summary: 'Sprint planning',
    start: { dateTime: '2026-07-24T09:00:00Z' },
    end: { dateTime: '2026-07-24T10:00:00Z' },
  },
  {
    summary: 'Retro',
    start: { dateTime: '2026-07-24T15:00:00Z' },
    end: { dateTime: '2026-07-24T16:00:00Z' },
  },
];

interface SetupOptions {
  mapping?: Mapping;
  reflectDelayMs?: number;
}

function setup(options: SetupOptions = {}): {
  source: FakePlatform;
  target: FakePlatform;
  scenario: Omit<Scenario, 'events' | 'poll'>;
} {
  const source = new FakePlatform({ name: 'A' });
  const target = new FakePlatform({ name: 'B' });
  const driver = new Driver(source, SOURCE_CAL);
  const reviewer = new Reviewer(target, TARGET_CAL);
  const reflector = new StubReflector({
    source,
    sourceCalendar: SOURCE_CAL,
    target,
    targetCalendar: TARGET_CAL,
    mapping: options.mapping ?? identityMapping,
    reflectDelayMs: options.reflectDelayMs ?? 0,
  });
  return {
    source,
    target,
    scenario: {
      driver,
      reviewer,
      reflector,
      sourcePlatform: source,
      sourceCalendar: SOURCE_CAL,
    },
  };
}

describe('reflection harness (single A→B calendar case)', () => {
  it('reports a correct reflection and cleans up both platforms', async () => {
    const { source, target, scenario } = setup();

    const outcome = await runReflectionScenario({ ...scenario, events });

    expect(outcome.status).toBe('reflected');
    // Teardown removed this run's records from both sides.
    expect(source.events(SOURCE_CAL)).toHaveLength(0);
    expect(target.events(TARGET_CAL)).toHaveLength(0);
  });

  it('catches a reflector that drops a field (wrong reflection)', async () => {
    const dropEnd: Mapping = (src) => ({
      summary: src['summary'],
      start: src['start'],
      extendedProperties: src['extendedProperties'],
    });
    const { scenario } = setup({ mapping: dropEnd });

    const outcome = await runReflectionScenario({ ...scenario, events });

    expect(outcome.status).toBe('mismatch');
    if (outcome.status === 'mismatch') {
      expect(outcome.problems.length).toBeGreaterThan(0);
    }
  });

  it('polls through reflection latency until the change appears', async () => {
    const { scenario } = setup({ reflectDelayMs: 150 });

    const outcome = await runReflectionScenario({
      ...scenario,
      events,
      poll: { timeoutMs: 3_000, intervalMs: 25 },
    });

    expect(outcome.status).toBe('reflected');
  });

  it('reports a timeout when the reflection never arrives in time', async () => {
    const { scenario } = setup({ reflectDelayMs: 400 });

    const outcome = await runReflectionScenario({
      ...scenario,
      events,
      poll: { timeoutMs: 120, intervalMs: 25 },
    });

    expect(outcome.status).toBe('timeout');
    if (outcome.status === 'timeout') {
      expect(outcome.seen).toBeLessThan(outcome.expected);
    }
  });

  it('ignores and preserves pre-existing state on the target', async () => {
    const { target, scenario } = setup();
    target.seed(TARGET_CAL, [
      { id: 'preexisting', summary: 'Do not touch', start: {}, end: {} },
    ]);

    const outcome = await runReflectionScenario({ ...scenario, events });

    expect(outcome.status).toBe('reflected');
    // The untagged record was neither counted as a reflection nor cleaned up.
    expect(target.events(TARGET_CAL).map((e) => e['id'])).toEqual([
      'preexisting',
    ]);
  });
});
