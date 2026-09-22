import { describe, expect, it } from 'vitest';
import { FakePlatform } from './fake-platform.js';
import {
  BidirectionalReflector,
  Driver,
  type Endpoint,
  type EventInput,
} from './roles.js';
import { runLoopScenario } from './scenario.js';

const CAL_A = 'cal-a';
const CAL_B = 'cal-b';

const events: EventInput[] = [
  {
    summary: 'Sprint planning',
    start: { dateTime: '2026-07-24T09:00:00Z' },
    end: { dateTime: '2026-07-24T10:00:00Z' },
  },
];

function setup(options: { suppressEchoes: boolean }): {
  a: Endpoint;
  b: Endpoint;
  driver: Driver;
  reflector: BidirectionalReflector;
} {
  const platformA = new FakePlatform({ name: 'A' });
  const platformB = new FakePlatform({ name: 'B' });
  const a: Endpoint = { platform: platformA, calendar: CAL_A };
  const b: Endpoint = { platform: platformB, calendar: CAL_B };
  const driver = new Driver(platformA, CAL_A);
  const reflector = new BidirectionalReflector({
    a,
    b,
    suppressEchoes: options.suppressEchoes,
  });
  return { a, b, driver, reflector };
}

describe('reflection harness — loop/echo suppression', () => {
  it('stays stable across cycles when the reflector suppresses echoes', async () => {
    const { a, b, driver, reflector } = setup({ suppressEchoes: true });

    const outcome = await runLoopScenario({
      driver,
      reflector,
      a,
      b,
      events,
      cycles: 3,
    });

    expect(outcome.status).toBe('stable');
    if (outcome.status === 'stable') {
      // The one driven event exists once on each side — never duplicated back.
      expect(outcome.counts).toEqual({ a: 1, b: 1 });
    }
  });

  it('detects a ping-pong loop when the reflector does not suppress echoes', async () => {
    const { a, b, driver, reflector } = setup({ suppressEchoes: false });

    const outcome = await runLoopScenario({
      driver,
      reflector,
      a,
      b,
      events,
      cycles: 3,
    });

    expect(outcome.status).toBe('looped');
    if (outcome.status === 'looped') {
      // The record bounced back and forth, so at least one side grew past N.
      expect(outcome.counts.a).toBeGreaterThan(outcome.expected);
    }
  });
});
