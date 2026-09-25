// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  agendaDays,
  busyDays,
  nextEvent,
  packWeek,
  type CalEvent,
} from './events.js';
import {
  addDays,
  hhmm,
  instant,
  mondayOf,
  offsetAt,
  offsetLabel,
  parseHhmm,
  rangeTitle,
  shortDay,
  longDay,
  toDateTime,
  wall,
} from './time.js';

const AMS = 'Europe/Amsterdam';
const NY = 'America/New_York';

let n = 0;

function ev(fields: Partial<CalEvent>): CalEvent {
  return {
    subject: `did:ad:row-${++n}`,
    id: `e${n}`,
    title: `Event ${n}`,
    description: '',
    location: '',
    start: '2026-09-24T10:00:00+02:00',
    end: '2026-09-24T11:00:00+02:00',
    allDay: false,
    pending: false,
    conflict: false,
    readOnly: false,
    calendar: { name: 'Work', color: '#039be5' },
    ...fields,
  };
}

describe('time', () => {
  it('reads wall-clock time and offsets in a named zone', () => {
    const at = Date.parse('2026-09-24T09:30:00+02:00');
    expect(wall(at, AMS)).toEqual({ date: '2026-09-24', minutes: 570 });
    expect(wall(at, NY)).toEqual({ date: '2026-09-24', minutes: 210 });
    expect(offsetAt(at, AMS)).toBe(120);
    expect(offsetAt(at, NY)).toBe(-240);
    expect(offsetAt(Date.parse('2026-12-01T12:00:00Z'), AMS)).toBe(60);
    expect(offsetLabel(at, AMS)).toBe('GMT+2');
    expect(offsetLabel(at, 'UTC')).toBe('GMT');
  });

  it('attaches the viewer zone offset to an edited time, including across DST', () => {
    expect(toDateTime('2026-09-24', 600, AMS)).toBe(
      '2026-09-24T10:00:00+02:00',
    );
    // Summer time ends on 25 October 2026 in Amsterdam.
    expect(toDateTime('2026-10-26', 600, AMS)).toBe(
      '2026-10-26T10:00:00+01:00',
    );
    expect(toDateTime('2026-09-24', 600, NY)).toBe('2026-09-24T10:00:00-04:00');
    expect(instant('2026-09-24', 0, AMS)).toBe(
      Date.parse('2026-09-24T00:00:00+02:00'),
    );
  });

  it('formats dates and ranges like the mockups', () => {
    expect(shortDay('2026-09-24')).toBe('Thu 24 Sep');
    expect(longDay('2026-09-22')).toBe('Tuesday 22 September');
    expect(rangeTitle('2026-09-21', '2026-09-27')).toBe(
      '21 – 27 September 2026',
    );
    expect(rangeTitle('2026-09-28', '2026-10-04')).toBe(
      '28 September – 4 October 2026',
    );
    expect(rangeTitle('2026-12-28', '2027-01-03')).toBe(
      '28 December 2026 – 3 January 2027',
    );
    expect(mondayOf('2026-09-24')).toBe('2026-09-21');
    expect(mondayOf('2026-09-21')).toBe('2026-09-21');
    expect(mondayOf('2026-09-27')).toBe('2026-09-21');
    expect(addDays('2026-09-30', 1)).toBe('2026-10-01');
    expect(hhmm(570)).toBe('09:30');
    expect(parseHhmm('9:05')).toBe(545);
    expect(parseHhmm('24:00')).toBeUndefined();
    expect(parseHhmm('noon')).toBeUndefined();
  });
});

describe('agendaDays', () => {
  it('uses the exclusive all-day end: a 3-day event covers exactly 3 days', () => {
    const offsite = ev({
      title: 'Team offsite',
      allDay: true,
      start: '2026-09-23',
      end: '2026-09-26',
    });
    const days = agendaDays([offsite], '2026-09-22', 6, AMS);
    expect(days.map(d => d.items.length)).toEqual([0, 1, 1, 1, 0, 0]);
    expect(days[2].items[0]).toMatchObject({
      allDay: true,
      dayOf: { n: 2, total: 3 },
    });
  });

  it('a one-day all-day event has no "Day n of m"', () => {
    const one = ev({ allDay: true, start: '2026-09-24', end: '2026-09-25' });
    const [day] = agendaDays([one], '2026-09-24', 1, AMS);
    expect(day.items[0].dayOf).toBeUndefined();
  });

  it('splits a timed event that crosses midnight into one piece per day', () => {
    const late = ev({
      start: '2026-09-24T22:00:00+02:00',
      end: '2026-09-25T01:30:00+02:00',
    });
    const days = agendaDays([late], '2026-09-24', 2, AMS);
    expect(days[0].items[0]).toMatchObject({
      startMin: 1320,
      endMin: 1440,
      allDay: false,
      dayOf: { n: 1, total: 2 },
    });
    expect(days[1].items[0]).toMatchObject({
      startMin: 0,
      endMin: 90,
      dayOf: { n: 2, total: 2 },
    });
  });

  it('an event ending exactly at midnight stays on its own day', () => {
    const evening = ev({
      start: '2026-09-24T20:00:00+02:00',
      end: '2026-09-25T00:00:00+02:00',
    });
    const days = agendaDays([evening], '2026-09-24', 2, AMS);
    expect(days.map(d => d.items.length)).toEqual([1, 0]);
    expect(days[0].items[0].dayOf).toBeUndefined();
  });

  it('places timed events in the viewer zone, not the event zone', () => {
    // 23:30 in New York is 05:30 the next day in Amsterdam.
    const call = ev({
      start: '2026-09-24T23:30:00-04:00',
      end: '2026-09-25T00:30:00-04:00',
    });
    const days = agendaDays([call], '2026-09-24', 2, AMS);
    expect(days[0].items).toEqual([]);
    expect(days[1].items[0]).toMatchObject({ startMin: 330, endMin: 390 });
  });

  it('orders all-day first, then by start time', () => {
    const a = ev({
      title: 'B',
      start: '2026-09-24T14:00:00+02:00',
      end: '2026-09-24T15:00:00+02:00',
    });
    const b = ev({
      title: 'A',
      start: '2026-09-24T10:00:00+02:00',
      end: '2026-09-24T11:00:00+02:00',
    });
    const c = ev({
      title: 'Z',
      allDay: true,
      start: '2026-09-24',
      end: '2026-09-25',
    });
    const [day] = agendaDays([a, b, c], '2026-09-24', 1, AMS);
    expect(day.items.map(i => i.event.title)).toEqual(['Z', 'A', 'B']);
  });

  it('skips events with an interval it cannot place', () => {
    const bad = ev({ start: 'garbage', end: 'garbage' });
    expect(agendaDays([bad], '2026-09-24', 1, AMS)[0].items).toEqual([]);
  });
});

describe('packWeek', () => {
  it('spans multi-day all-day bars across columns and stacks overlapping bars', () => {
    const offsite = ev({
      allDay: true,
      start: '2026-09-23',
      end: '2026-09-26',
    });
    const deadline = ev({
      allDay: true,
      start: '2026-09-21',
      end: '2026-09-22',
    });
    const holiday = ev({
      allDay: true,
      start: '2026-09-24',
      end: '2026-09-25',
    });
    const week = packWeek([offsite, deadline, holiday], '2026-09-21', 7, AMS);
    const bar = (e: CalEvent) => week.bars.find(b => b.event === e)!;
    expect(bar(offsite)).toMatchObject({ col: 2, span: 3, row: 0 });
    expect(bar(deadline)).toMatchObject({ col: 0, span: 1, row: 0 });
    expect(bar(holiday)).toMatchObject({ col: 3, span: 1, row: 1 });
    expect(week.rows).toBe(2);
  });

  it('clips bars to the visible days', () => {
    const long = ev({ allDay: true, start: '2026-09-19', end: '2026-09-23' });
    const week = packWeek([long], '2026-09-21', 3, AMS);
    expect(week.bars[0]).toMatchObject({ col: 0, span: 2 });
  });

  it('packs overlapping timed events into lanes of one cluster', () => {
    const t = (s: string, e: string, title: string) =>
      ev({
        title,
        start: `2026-09-22T${s}:00+02:00`,
        end: `2026-09-22T${e}:00+02:00`,
      });
    const oneOnOne = t('11:00', '12:00', '1:1');
    const dentist = t('11:30', '12:30', 'Dentist');
    const later = t('12:15', '13:00', 'Later');
    const alone = t('16:00', '17:00', 'Sync');
    const week = packWeek(
      [alone, later, dentist, oneOnOne],
      '2026-09-21',
      7,
      AMS,
    );
    const col = week.columns[1];
    const of = (e: CalEvent) => col.find(b => b.segment.event === e)!;
    expect(of(oneOnOne)).toMatchObject({ lane: 0, lanes: 2 });
    expect(of(dentist)).toMatchObject({ lane: 1, lanes: 2 });
    // Reuses lane 0 once 1:1 has ended, still in the same cluster.
    expect(of(later)).toMatchObject({ lane: 0, lanes: 2 });
    expect(of(alone)).toMatchObject({ lane: 0, lanes: 1 });
    expect(week.columns[0]).toEqual([]);
  });

  it('draws a timed event covering whole days in the all-day row', () => {
    const trip = ev({
      start: '2026-09-21T18:00:00+02:00',
      end: '2026-09-23T09:00:00+02:00',
    });
    const week = packWeek([trip], '2026-09-21', 7, AMS);
    expect(week.bars).toEqual([expect.objectContaining({ col: 1, span: 1 })]);
    expect(week.columns[0][0].segment).toMatchObject({
      startMin: 1080,
      endMin: 1440,
    });
    expect(week.columns[2][0].segment).toMatchObject({
      startMin: 0,
      endMin: 540,
    });
  });
});

describe('nextEvent and busyDays', () => {
  it('finds the first event on or after a date', () => {
    const early = ev({
      title: 'Early',
      start: '2026-09-01T10:00:00+02:00',
      end: '2026-09-01T11:00:00+02:00',
    });
    const next = ev({
      title: 'Next',
      start: '2026-10-13T10:00:00+02:00',
      end: '2026-10-13T11:00:00+02:00',
    });
    const later = ev({
      title: 'Later',
      allDay: true,
      start: '2026-10-20',
      end: '2026-10-21',
    });
    expect(nextEvent([later, early, next], '2026-10-05', AMS)).toMatchObject({
      event: next,
      date: '2026-10-13',
    });
    expect(nextEvent([early], '2026-10-05', AMS)).toBeUndefined();
  });

  it('marks the days with events', () => {
    const e = ev({ allDay: true, start: '2026-09-23', end: '2026-09-25' });
    expect([...busyDays([e], '2026-09-21', 7, AMS)]).toEqual([
      '2026-09-23',
      '2026-09-24',
    ]);
  });
});
