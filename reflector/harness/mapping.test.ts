import { describe, expect, it } from 'vitest';
import { FakePlatform } from './fake-platform.js';
import {
  Driver,
  Reviewer,
  StubReflector,
  agendaMarkerOf,
  calendarToAgenda,
  markerOf,
  type EventInput,
  type Mapping,
} from './roles.js';
import { compareCalendarToAgenda, runReflectionScenario } from './scenario.js';

const CALENDAR = 'cal-a';
const AGENDA = 'agenda-b';

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

function setup(mapping: Mapping): {
  source: FakePlatform;
  target: FakePlatform;
  driver: Driver;
  reviewer: Reviewer;
  reflector: StubReflector;
} {
  const source = new FakePlatform({ name: 'Calendar' });
  const target = new FakePlatform({ name: 'Agenda' });
  const driver = new Driver(source, CALENDAR);
  // The target is a different shape, so the reviewer reads its marker differently.
  const reviewer = new Reviewer(target, AGENDA, agendaMarkerOf);
  const reflector = new StubReflector({
    source,
    sourceCalendar: CALENDAR,
    target,
    targetCalendar: AGENDA,
    mapping,
  });
  return { source, target, driver, reviewer, reflector };
}

describe('reflection harness — cross-shape mapping (Calendar → Agenda)', () => {
  it('reflects into a differently-shaped platform per the field mapping', async () => {
    const { source, target, driver, reviewer, reflector } =
      setup(calendarToAgenda);

    const outcome = await runReflectionScenario({
      driver,
      reviewer,
      reflector,
      sourcePlatform: source,
      sourceCalendar: CALENDAR,
      events,
      oracle: compareCalendarToAgenda,
      targetMarkerOf: agendaMarkerOf,
    });

    expect(outcome.status).toBe('reflected');
    if (outcome.status === 'reflected') {
      // The target really holds the agenda shape, not the Calendar shape.
      const record = outcome.reflected[0] as Record<string, unknown>;
      expect(record).toHaveProperty('title');
      expect(record).toHaveProperty('startsAt');
      expect(record['summary']).toBeUndefined();
    }
    // And nothing leaked past teardown.
    expect(target.events(AGENDA)).toHaveLength(0);
  });

  it('catches a mapping that drops a field', async () => {
    const dropEndsAt: Mapping = (src) => ({
      title: src['summary'],
      startsAt: (src['start'] as { dateTime?: unknown } | undefined)?.dateTime,
      reflectorRunId: markerOf(src),
    });
    const { source, driver, reviewer, reflector } = setup(dropEndsAt);

    const outcome = await runReflectionScenario({
      driver,
      reviewer,
      reflector,
      sourcePlatform: source,
      sourceCalendar: CALENDAR,
      events,
      oracle: compareCalendarToAgenda,
      targetMarkerOf: agendaMarkerOf,
    });

    expect(outcome.status).toBe('mismatch');
    if (outcome.status === 'mismatch') {
      expect(outcome.problems.length).toBeGreaterThan(0);
    }
  });
});
