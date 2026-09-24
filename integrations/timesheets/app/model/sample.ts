// @wc-ignore-file
/**
 * The invented sample data of `design/mockups.html` (#89): a designer, Mira
 * Janssen, in workspace Studio Veldkamp; "today" is Thursday 24 September
 * 2026 in Europe/Amsterdam. Week 21–27 Sep totals 26:50 and the 30-day
 * window 94:50, split 38:30 / 34:15 / 9:45 / 8:20 / 4:00. Test and
 * screenshot data only; not bundled.
 */
import type { Project, TimeEntry, Timesheet } from './types.js';

export const SAMPLE_ZONE = 'Europe/Amsterdam';
/** Thursday 24 Sep 2026, 15:20 in Amsterdam (CEST, UTC+2). */
export const SAMPLE_NOW = Date.parse('2026-09-24T15:20:00+02:00');
/** 30 days back from `SAMPLE_NOW`: 25 Aug 15:20. */
export const SAMPLE_WINDOW = {
  from: SAMPLE_NOW - 30 * 86_400_000,
  to: SAMPLE_NOW,
};

export const PROJECTS = {
  harbor: {
    id: 'p-harbor',
    name: 'Harbor Lights website',
    color: '#0B8A8A',
    client: 'Havenbedrijf Rotterdam',
  },
  kestrel: {
    id: 'p-kestrel',
    name: 'Kestrel iOS app',
    color: '#7B4FD6',
    client: 'Kestrel BV',
  },
  admin: {
    id: 'p-admin',
    name: 'Admin & email',
    color: '#8A8F98',
    client: 'Studio Veldkamp',
  },
  atomic: {
    id: 'p-atomic',
    name: 'Atomic onboarding',
    color: '#C9622A',
    client: 'Internal',
  },
  workshop: {
    id: 'p-workshop',
    name: 'Workshop prep',
    color: '#D6457A',
    client: 'Studio Veldkamp',
  },
} satisfies Record<string, Project>;

type Key = keyof typeof PROJECTS;
/** Harbor and Kestrel are billable unless an entry says otherwise. */
const BILLABLE: Record<Key, boolean> = {
  harbor: true,
  kestrel: true,
  admin: false,
  atomic: false,
  workshop: false,
};

const at = (day: string, time: string) =>
  Date.parse(`2026-${day}T${time}:00+02:00`);

let seq = 0;

const entry = (
  day: string,
  from: string,
  to: string,
  project: Key,
  description: string,
  billable = BILLABLE[project],
): TimeEntry => ({
  id: `e${String(++seq).padStart(3, '0')}`,
  description,
  start: at(day, from),
  end: at(day, to),
  billable,
  project: PROJECTS[project],
  member: 'Mira Janssen',
});

/** Frames A, B, E: the week of 21 Sep. */
function thisWeek(): TimeEntry[] {
  return [
    entry('09-21', '08:45', '09:30', 'admin', 'Inbox'),
    entry('09-21', '09:30', '12:30', 'harbor', 'Homepage wireframes'),
    entry('09-21', '13:00', '15:00', 'kestrel', 'Onboarding flow'),
    entry('09-21', '15:00', '16:00', 'atomic', 'Reading the plugin docs'),
    entry('09-22', '08:45', '09:15', 'admin', 'Inbox and invoices'),
    entry('09-22', '09:15', '11:45', 'harbor', 'Homepage hero, first pass'),
    entry('09-22', '12:30', '13:30', 'workshop', 'Slides: local-first sync'),
    entry(
      '09-22',
      '13:30',
      '15:00',
      'harbor',
      'Content model review with client',
    ),
    entry('09-22', '15:00', '16:30', 'kestrel', 'Settings screen layout'),
    entry('09-23', '08:30', '09:10', 'admin', ''),
    entry('09-23', '09:10', '11:40', 'harbor', 'Accessibility audit fixes'),
    entry('09-23', '12:30', '14:00', 'kestrel', 'Push notification settings'),
    entry('09-23', '14:00', '14:45', 'atomic', 'Docs: integration proxy'),
    entry('09-23', '14:45', '16:45', 'kestrel', 'Crash on cold start (#412)'),
    entry('09-24', '08:50', '09:15', 'admin', 'Inbox, invoices'),
    entry('09-24', '09:15', '11:00', 'kestrel', 'Offline sync: conflict sheet'),
    entry(
      '09-24',
      '11:00',
      '11:30',
      'atomic',
      'Pairing with Joep on plugin host',
    ),
    entry(
      '09-24',
      '12:15',
      '14:15',
      'harbor',
      'Homepage hero, responsive pass',
    ),
    entry('09-24', '14:15', '15:15', 'kestrel', 'Review TestFlight feedback'),
  ];
}

/** Frame L: the week of 24 Aug, which starts before the window. */
function firstWeek(): TimeEntry[] {
  return [
    entry('08-25', '15:30', '18:45', 'harbor', 'Kick-off notes'),
    entry('08-25', '18:45', '20:45', 'kestrel', 'Estimate'),
    entry('08-25', '20:45', '21:15', 'admin', 'Inbox'),
    entry('08-26', '09:00', '11:00', 'harbor', 'Sitemap'),
    entry('08-26', '11:00', '14:00', 'kestrel', 'Design system audit'),
    entry('08-26', '14:00', '14:45', 'admin', 'Inbox'),
    entry('08-27', '09:00', '10:45', 'harbor', 'Sitemap review'),
    entry('08-27', '10:45', '13:15', 'kestrel', 'Navigation'),
    entry('08-27', '13:15', '13:35', 'admin', 'Inbox'),
    entry('08-28', '09:00', '11:30', 'harbor', 'Moodboard'),
    entry('08-28', '11:30', '12:45', 'kestrel', 'Navigation'),
    entry('08-28', '12:45', '13:25', 'admin', 'Invoices'),
  ];
}

/**
 * The weeks of 31 Aug, 7 Sep and 14 Sep: what is left of each project's
 * window total, 2:30 blocks on weekdays from 09:00.
 */
function middleWeeks(): TimeEntry[] {
  const rest: [Key, number, boolean?][] = [
    ['harbor', 17 * 60 + 30],
    ['kestrel', 12 * 60 + 15],
    ['kestrel', 3 * 60 + 30, false],
    ['atomic', 7 * 60 + 30],
    ['admin', 3 * 60 + 45],
    ['workshop', 3 * 60],
  ];
  const days = [
    '08-31',
    '09-01',
    '09-02',
    '09-03',
    '09-04',
    '09-07',
    '09-08',
    '09-09',
    '09-10',
    '09-11',
    '09-14',
    '09-15',
    '09-16',
    '09-17',
    '09-18',
  ];
  const clock = new Map<string, number>(days.map(d => [d, 9 * 60]));
  const out: TimeEntry[] = [];
  let d = 0;
  const hm = (m: number) =>
    `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;

  for (const [project, minutes, billable] of rest) {
    let left = minutes;

    while (left > 0) {
      const day = days[d++ % days.length];
      const chunk = Math.min(150, left);
      const from = clock.get(day)!;
      clock.set(day, from + chunk);
      out.push(
        entry(
          day,
          hm(from),
          hm(from + chunk),
          project,
          'Project work',
          billable,
        ),
      );
      left -= chunk;
    }
  }

  return out;
}

export function sampleEntries(): TimeEntry[] {
  seq = 0;

  return [...firstWeek(), ...middleWeeks(), ...thisWeek()];
}

export function sampleTimesheet(overrides: Partial<Timesheet> = {}): Timesheet {
  return {
    entries: sampleEntries(),
    running: 1,
    breaks: 0,
    window: SAMPLE_WINDOW,
    lastChecked: new Date(SAMPLE_NOW - 4 * 60_000).toISOString(),
    weekStart: 'MONDAY',
    timeZone: SAMPLE_ZONE,
    unknown: [],
    conflicts: [],
    ...overrides,
  };
}
