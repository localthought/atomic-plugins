// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import {
  PROJECTS,
  SAMPLE_NOW,
  SAMPLE_WINDOW,
  SAMPLE_ZONE,
  sampleEntries,
} from './sample.js';
import {
  addDays,
  ago,
  dayKey,
  formatDuration,
  formatRange,
  formatTime,
  shiftWeek,
  spokenDuration,
  startOfDay,
  weekContaining,
  weekOf,
  weekSpan,
  weekStartOf,
} from './time.js';
import type { TimeEntry } from './types.js';
import {
  apportion,
  dayList,
  formatShare,
  projectSummary,
  weekGrid,
} from './views.js';

const H = 3_600_000;
const M = 60_000;

describe('durations', () => {
  it('formats h:mm from integer ms, rounding only at the end', () => {
    expect(formatDuration(0)).toBe('0:00');
    expect(formatDuration(2 * H + 5 * M)).toBe('2:05');
    expect(formatDuration(26 * H + 50 * M)).toBe('26:50');
    expect(formatDuration(29_999)).toBe('0:00');
    expect(formatDuration(30_000)).toBe('0:01');
  });

  it('speaks durations', () => {
    expect(spokenDuration(2 * H + 30 * M)).toBe('2 hours 30 minutes');
    expect(spokenDuration(H)).toBe('1 hour');
    expect(spokenDuration(M)).toBe('1 minute');
    expect(spokenDuration(45 * M)).toBe('45 minutes');
    expect(spokenDuration(0)).toBe('0 minutes');
  });

  it('says how long ago', () => {
    expect(ago(SAMPLE_NOW - 20_000, SAMPLE_NOW)).toBe('just now');
    expect(ago(SAMPLE_NOW - 4 * M, SAMPLE_NOW)).toBe('4 min ago');
    expect(ago(SAMPLE_NOW - 2 * H, SAMPLE_NOW)).toBe('2 h ago');
  });
});

describe('days and weeks', () => {
  it('finds the local day in the given zone, not UTC', () => {
    const lateEvening = Date.parse('2026-09-23T22:30:00Z'); // 00:30 CEST
    expect(dayKey(lateEvening, SAMPLE_ZONE)).toBe('2026-09-24');
    expect(dayKey(lateEvening, 'UTC')).toBe('2026-09-23');
    expect(formatTime(lateEvening, SAMPLE_ZONE)).toBe('00:30');
  });

  it('builds weeks from the Clockify week start', () => {
    expect(weekOf(SAMPLE_NOW, 'MONDAY', SAMPLE_ZONE).days).toEqual([
      '2026-09-21',
      '2026-09-22',
      '2026-09-23',
      '2026-09-24',
      '2026-09-25',
      '2026-09-26',
      '2026-09-27',
    ]);
    expect(weekOf(SAMPLE_NOW, 'SUNDAY', SAMPLE_ZONE).start).toBe('2026-09-20');
    expect(weekStartOf('sunday')).toBe('SUNDAY');
    expect(weekStartOf(undefined)).toBe('MONDAY');
    expect(shiftWeek(weekOf(SAMPLE_NOW, 'MONDAY', SAMPLE_ZONE), -4).start).toBe(
      '2026-08-24',
    );
  });

  it('formats week ranges across months and years', () => {
    expect(formatRange('2026-09-21', '2026-09-27')).toBe('21 – 27 Sep 2026');
    expect(formatRange('2026-08-31', '2026-09-06')).toBe('31 Aug – 6 Sep 2026');
    expect(formatRange('2026-12-28', '2027-01-03')).toBe(
      '28 Dec 2026 – 3 Jan 2027',
    );
    expect(formatRange('2026-08-25', '2026-09-24', false)).toBe(
      '25 Aug – 24 Sep',
    );
  });

  it('has a 23-hour and a 25-hour day around DST in Europe/Amsterdam', () => {
    expect(
      startOfDay('2026-03-30', SAMPLE_ZONE) -
        startOfDay('2026-03-29', SAMPLE_ZONE),
    ).toBe(23 * H);
    expect(
      startOfDay('2026-10-26', SAMPLE_ZONE) -
        startOfDay('2026-10-25', SAMPLE_ZONE),
    ).toBe(25 * H);
    const week = weekContaining('2026-10-25', 'MONDAY');
    const span = weekSpan(week, SAMPLE_ZONE);
    expect(span.to - span.from).toBe(7 * 24 * H + H);
  });

  it('keeps a skipped midnight on its own day', () => {
    // America/Santiago skips 00:00–01:00 on its spring-forward day.
    const start = startOfDay('2026-09-06', 'America/Santiago');
    expect(dayKey(start, 'America/Santiago')).toBe('2026-09-06');
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('the mockup numbers', () => {
  const entries = sampleEntries();
  const week = weekOf(SAMPLE_NOW, 'MONDAY', SAMPLE_ZONE);
  const grid = weekGrid(entries, week, {
    timeZone: SAMPLE_ZONE,
    now: SAMPLE_NOW,
    window: SAMPLE_WINDOW,
  });

  it('frame A: week 21–27 Sep totals 26:50', () => {
    expect(formatDuration(grid.total)).toBe('26:50');
    expect(grid.dayTotals.map(formatDuration)).toEqual([
      '6:45',
      '7:00',
      '7:25',
      '5:40',
      '0:00',
      '0:00',
      '0:00',
    ]);
    expect(
      grid.rows.map(r => [
        r.project?.name,
        formatDuration(r.total),
        ...r.cells.map(formatDuration),
      ]),
    ).toEqual([
      [
        'Harbor Lights website',
        '11:30',
        '3:00',
        '4:00',
        '2:30',
        '2:00',
        '0:00',
        '0:00',
        '0:00',
      ],
      [
        'Kestrel iOS app',
        '9:45',
        '2:00',
        '1:30',
        '3:30',
        '2:45',
        '0:00',
        '0:00',
        '0:00',
      ],
      [
        'Admin & email',
        '2:20',
        '0:45',
        '0:30',
        '0:40',
        '0:25',
        '0:00',
        '0:00',
        '0:00',
      ],
      [
        'Atomic onboarding',
        '2:15',
        '1:00',
        '0:00',
        '0:45',
        '0:30',
        '0:00',
        '0:00',
        '0:00',
      ],
      [
        'Workshop prep',
        '1:00',
        '0:00',
        '1:00',
        '0:00',
        '0:00',
        '0:00',
        '0:00',
        '0:00',
      ],
    ]);
    expect(formatDuration(grid.billable)).toBe('21:15');
    expect(formatDuration(grid.notBillable)).toBe('5:35');
    expect(grid.days.map(d => [d.isToday, d.isFuture])).toEqual([
      [false, false],
      [false, false],
      [false, false],
      [true, false],
      [false, true],
      [false, true],
      [false, true],
    ]);
  });

  it('frame B: days newest first, entries newest first, empty days omitted', () => {
    const days = dayList(entries, week, SAMPLE_ZONE);
    expect(days.map(d => [d.key, formatDuration(d.total)])).toEqual([
      ['2026-09-24', '5:40'],
      ['2026-09-23', '7:25'],
      ['2026-09-22', '7:00'],
      ['2026-09-21', '6:45'],
    ]);
    expect(days[0].entries.map(e => formatTime(e.start, SAMPLE_ZONE))).toEqual([
      '14:15',
      '12:15',
      '11:00',
      '09:15',
      '08:50',
    ]);
  });

  it('frame C: the window totals 94:50 with shares summing to 100.0', () => {
    const summary = projectSummary(entries, SAMPLE_WINDOW);
    expect(formatDuration(summary.total)).toBe('94:50');
    expect(formatDuration(summary.billable)).toBe('69:15');
    expect(formatDuration(summary.notBillable)).toBe('25:35');
    expect(
      summary.rows.map(r => [
        r.project?.name,
        formatDuration(r.total),
        formatShare(r.shareTenths),
      ]),
    ).toEqual([
      ['Harbor Lights website', '38:30', '40.6%'],
      ['Kestrel iOS app', '34:15', '36.1%'],
      ['Atomic onboarding', '9:45', '10.3%'],
      ['Admin & email', '8:20', '8.8%'],
      ['Workshop prep', '4:00', '4.2%'],
    ]);
    expect(summary.rows.reduce((s, r) => s + r.shareTenths, 0)).toBe(1000);
    expect(summary.rows[0].barPercent).toBe(100);
    expect(summary.rows[1].barPercent).toBe(89);
    expect(summary.rows[1].billableBarPercent).toBe(79.9);
    expect(summary.rows[2].billableBarPercent).toBe(0);
  });

  it('frame L: the week of 24 Aug has Monday outside the window, 20:30 in total', () => {
    const early = shiftWeek(week, -4);
    const l = weekGrid(entries, early, {
      timeZone: SAMPLE_ZONE,
      now: SAMPLE_NOW,
      window: SAMPLE_WINDOW,
    });
    expect(l.days.map(d => d.inWindow)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
    ]);
    expect(formatDuration(l.total)).toBe('20:30');
    expect(l.dayTotals.slice(0, 5).map(formatDuration)).toEqual([
      '0:00',
      '5:45',
      '5:45',
      '4:35',
      '4:25',
    ]);
  });
});

describe('edge cases', () => {
  const e = (
    id: string,
    start: string,
    end: string,
    extra: Partial<TimeEntry> = {},
  ): TimeEntry => ({
    id,
    description: id,
    start: Date.parse(start),
    end: Date.parse(end),
    billable: false,
    ...extra,
  });

  it('counts an entry crossing midnight wholly on its start day', () => {
    const week = weekContaining('2026-09-21', 'MONDAY');
    const grid = weekGrid(
      [e('late', '2026-09-22T23:00:00+02:00', '2026-09-23T01:30:00+02:00')],
      week,
      { timeZone: SAMPLE_ZONE, now: SAMPLE_NOW },
    );
    expect(grid.dayTotals.map(formatDuration).slice(0, 3)).toEqual([
      '0:00',
      '2:30',
      '0:00',
    ]);
  });

  it('buckets a DST-change week by local day', () => {
    const week = weekContaining('2026-10-25', 'MONDAY');
    const grid = weekGrid(
      [
        // 02:30 CEST, then the clock goes back: 02:30 CET is another hour.
        e('a', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z'),
        e('b', '2026-10-25T23:30:00Z', '2026-10-26T00:30:00Z'),
      ],
      week,
      { timeZone: SAMPLE_ZONE, now: SAMPLE_NOW },
    );
    expect(week.days[6]).toBe('2026-10-25');
    expect(grid.dayTotals.map(formatDuration)).toEqual([
      '0:00',
      '0:00',
      '0:00',
      '0:00',
      '0:00',
      '0:00',
      '1:00',
    ]);
    // 'b' starts at 00:30 CET on Monday 26 Oct: the next week.
    expect(grid.total).toBe(H);
  });

  it('puts "No project" last even when it is largest', () => {
    const week = weekContaining('2026-09-21', 'MONDAY');
    const grid = weekGrid(
      [
        e('x', '2026-09-21T09:00:00+02:00', '2026-09-21T15:00:00+02:00'),
        e('y', '2026-09-21T15:00:00+02:00', '2026-09-21T16:00:00+02:00', {
          project: PROJECTS.admin,
        }),
      ],
      week,
      { timeZone: SAMPLE_ZONE, now: SAMPLE_NOW },
    );
    expect(grid.rows.map(r => r.key)).toEqual(['p-admin', '']);
  });

  it('apportions by largest remainder', () => {
    expect(apportion([1, 1, 1], 1000)).toEqual([334, 333, 333]);
    expect(apportion([0, 0], 1000)).toEqual([0, 0]);
    expect(projectSummary([], undefined).rows).toEqual([]);
  });
});
