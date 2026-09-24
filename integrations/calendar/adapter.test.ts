// @wc-ignore-file
import { describe, it, expect } from 'vitest';
import {
  applyEdit,
  endpoint,
  preview,
  project,
  planEdit,
  manifest,
  type Event,
  type Projection,
} from './adapter.js';
import { validateManifest } from '../../browser/lib/src/plugin-manifest.js';

const timed = (id: string, overrides: Partial<Event> = {}): Event => ({
  id,
  status: 'confirmed',
  summary: `Event ${id}`,
  description: '',
  location: '',
  start: { dateTime: '2026-09-22T10:00:00+02:00' },
  end: { dateTime: '2026-09-22T11:00:00+02:00' },
  etag: `"${id}"`,
  ...overrides,
});

describe('Google Calendar package', () => {
  it('uses a strict calendar-scoped manifest', () => {
    expect(validateManifest(manifest('primary')).operations).toHaveLength(4);
    expect(() => manifest('../escape')).toThrow();
    expect(() => manifest('primary?token=x')).toThrow();
  });

  it('reads every page and excludes recurring and cancelled events', async () => {
    const events = Array.from({ length: 251 }, (_, i) => timed(`e${i + 1}`));
    events[100].recurringEventId = 'series-1';
    events[150].status = 'cancelled';
    const pages = [events.slice(0, 250), events.slice(250)];
    const result = await preview(
      {
        read: async intent => {
          const token = new URL(intent.url).searchParams.get('pageToken');
          const index = token ? Number(token) : 0;
          const items = pages[index];
          const nextPageToken =
            index + 1 < pages.length ? String(index + 1) : undefined;

          return {
            status: 200,
            body: JSON.stringify({ items, nextPageToken }),
          };
        },
        cards: async () => [],
        state: async () => ({ revision: 0, records: {}, cursor: null }),
      },
      'primary',
    );
    expect(result.changes).toHaveLength(249);
    expect(result.skipped).toEqual({ recurring: 1, cancelled: 1 });
    // The ETag each later edit is conditioned on comes from this same read.
    expect(result.changes[0]).toMatchObject({ id: 'e1', etag: '"e1"' });
  });

  it('fails loudly past the page cap instead of importing a partial calendar', async () => {
    let reads = 0;
    await expect(
      preview(
        {
          read: async () => {
            reads++;

            return {
              status: 200,
              body: JSON.stringify({ items: [], nextPageToken: 'more' }),
            };
          },
          cards: async () => [],
          state: async () => ({ revision: 0, records: {}, cursor: null }),
        },
        'primary',
        { maxPages: 3 },
      ),
    ).rejects.toThrow('at most 750 events');
    expect(reads).toBe(3);
  });

  it('refuses failed reads instead of treating them as deletions', async () => {
    await expect(
      preview(
        {
          read: async () => ({ status: 429, body: '{}' }),
          cards: async () => [],
          state: async () => ({ revision: 0, records: {}, cursor: null }),
        },
        'primary',
      ),
    ).rejects.toThrow('429');
  });

  it('projects timed and all-day events, rejecting invalid intervals', () => {
    expect(project(timed('e1'))).toEqual({
      title: 'Event e1',
      description: '',
      location: '',
      start: '2026-09-22T10:00:00+02:00',
      end: '2026-09-22T11:00:00+02:00',
      allDay: false,
    });
    expect(
      project(
        timed('e2', {
          start: { date: '2026-09-22' },
          end: { date: '2026-09-23' },
        }),
      ),
    ).toEqual({
      title: 'Event e2',
      description: '',
      location: '',
      start: '2026-09-22',
      end: '2026-09-23',
      allDay: true,
    });
    expect(() =>
      project(
        timed('e3', {
          start: { date: '2026-09-22' },
          end: { date: '2026-09-22' },
        }),
      ),
    ).toThrow('invalid all-day interval');
    expect(() =>
      project(timed('e4', { end: { dateTime: '2026-09-22T09:00:00+02:00' } })),
    ).toThrow('invalid timed interval');
  });

  it('skips recurring instances and cancelled events without throwing', () => {
    expect(
      project(timed('e5', { recurringEventId: 'series-1' })),
    ).toBeUndefined();
    expect(
      project(timed('e6', { recurrence: ['RRULE:FREQ=WEEKLY'] })),
    ).toBeUndefined();
    expect(project(timed('e7', { status: 'cancelled' }))).toBeUndefined();
  });

  it('plans only the fields an edit actually changed', () => {
    const remote: Projection = {
      title: 'Before',
      description: 'Same',
      location: '',
      start: '2026-09-22T10:00:00+02:00',
      end: '2026-09-22T11:00:00+02:00',
      allDay: false,
    };
    const desired: Projection = { ...remote, title: 'After' };
    const edit = planEdit('e1', desired, remote)!;
    expect(edit.patch).toEqual({ summary: 'After' });
    expect(planEdit('e1', remote, remote)).toBeUndefined();
  });

  it('writes edits without emailing guests about them', async () => {
    const urls: string[] = [];
    await applyEdit(
      {
        read: async intent => {
          urls.push(intent.url);

          return { status: 200, body: JSON.stringify(timed('e1')) };
        },
        cards: async () => [],
        state: async () => ({ revision: 0, records: {}, cursor: null }),
      },
      endpoint('primary'),
      { id: 'e1', patch: { summary: 'After' } },
      '"e1"',
    );
    expect(urls).toHaveLength(1);
    expect(new URL(urls[0]).searchParams.get('sendUpdates')).toBe('none');
  });
});
