import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { loadConfig, type ReflectorConfig } from '../../src/config/index.js';
import { TokenManager } from '../../src/oauth/authed-fetch.js';
import { deriveAuthProfile, type OAuthTokens } from '../../src/oauth/oauth.js';
import { buildDocument } from '../../src/sync/document.js';
import { SyncEngine, type FullReadSummary } from '../../src/sync/engine.js';

const cwd = process.cwd();

interface GoogleMock {
  fetchImpl: typeof fetch;
  events: Record<string, Map<string, Record<string, unknown>>>;
}

/** A tiny in-memory stand-in for the Google Calendar API, routed by URL. */
function makeGoogleMock(): GoogleMock {
  const events: Record<string, Map<string, Record<string, unknown>>> = {
    primary: new Map([
      ['e1', { id: 'e1', summary: 'Standup', start: { dateTime: '2026-07-20T09:00:00Z' } }],
      ['e2', { id: 'e2', summary: 'Lunch', start: { dateTime: '2026-07-20T12:00:00Z' } }],
      ['e3', { id: 'e3', summary: 'Review', start: { dateTime: '2026-07-20T15:00:00Z' } }],
    ]),
    broken: new Map([['bad1', { id: 'bad1', summary: 'Bad', start: { dateTime: '2026-07-21T09:00:00Z' } }]]),
  };

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

  const fetchImpl = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace('/calendar/v3', '');

    if (path === '/users/me/calendarList') {
      return json({
        items: [
          { id: 'primary', summary: 'Primary' },
          { id: 'broken', summary: 'Broken' },
        ],
      });
    }

    // Top-level, read-only settings collection — part of the generic walk.
    if (path === '/users/me/settings') {
      return json({
        items: [
          { id: 'timezone', value: 'Europe/Amsterdam' },
          { id: 'locale', value: 'en' },
        ],
        nextSyncToken: 'SYNC',
      });
    }

    // Nested acl collection (empty here) — exercises a second nested collection.
    if (/^\/calendars\/([^/]+)\/acl$/.test(path)) {
      return json({ items: [], nextSyncToken: 'SYNC' });
    }

    const listMatch = /^\/calendars\/([^/]+)\/events$/.exec(path);
    if (listMatch) {
      const calendarId = decodeURIComponent(listMatch[1] as string);
      const store = events[calendarId] ?? new Map();
      const all = [...store.values()];
      if (method === 'POST') {
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        store.set(String(body['id']), body);
        return json(body, 200);
      }
      // Paginate `primary` across two pages to exercise the full read.
      if (calendarId === 'primary' && !url.searchParams.get('pageToken')) {
        return json({ items: all.slice(0, 2), nextPageToken: 'PAGE2' });
      }
      if (calendarId === 'primary') {
        return json({ items: all.slice(2), nextSyncToken: 'SYNC' });
      }
      return json({ items: all, nextSyncToken: 'SYNC' });
    }

    const itemMatch = /^\/calendars\/([^/]+)\/events\/([^/]+)$/.exec(path);
    if (itemMatch) {
      const calendarId = decodeURIComponent(itemMatch[1] as string);
      const eventId = decodeURIComponent(itemMatch[2] as string);
      const store = events[calendarId] ?? new Map();
      if (method === 'PUT') {
        // The `broken` calendar always rejects writes, to drive the rollback path.
        if (calendarId === 'broken') {
          return json({ error: 'boom' }, 500);
        }
        const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
        store.set(eventId, body);
        return json(body, 200);
      }
      if (method === 'DELETE') {
        store.delete(eventId);
        return new Response(null, { status: 204 });
      }
      return json(store.get(eventId) ?? {}, 200);
    }

    return new Response('not found', { status: 404 });
  }) as unknown as typeof fetch;

  return { fetchImpl, events };
}

function countOf(summary: FullReadSummary, collection: string): number {
  return summary.collections
    .filter((c) => c.collection === collection)
    .reduce((sum, c) => sum + c.count, 0);
}

async function makeEngine(dataDir: string, mockFetch: typeof fetch): Promise<SyncEngine> {
  const base = loadConfig();
  const config: ReflectorConfig = {
    ...base,
    dataDir,
    openApiPath: join(cwd, 'spec/google-calendar-v3.openapi.yaml'),
    overlayDir: join(cwd, 'spec/overlays'),
    retry: { baseDelayMs: 5, maxDelayMs: 10, maxAttempts: 2 },
  };
  const document = await buildDocument(config);
  const profile = deriveAuthProfile(document);
  const tokens: OAuthTokens = {
    accessToken: 'access',
    refreshToken: 'refresh',
    expiresAt: Date.now() + 3_600_000,
  };
  const manager = new TokenManager(profile, config.oauth, tokens, mockFetch);
  return new SyncEngine(config, document, manager);
}

describe('SyncEngine', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'reflector-engine-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('walks the discovered hierarchy: calendars, their events, and top-level settings', async () => {
    const { fetchImpl } = makeGoogleMock();
    const engine = await makeEngine(dir, fetchImpl);

    const summary = await engine.fullRead();
    expect(summary.errors).toEqual([]);
    expect(countOf(summary, 'calendarList')).toBe(2);
    expect(countOf(summary, 'events')).toBe(4); // primary 3 (two pages) + broken 1
    expect(countOf(summary, 'settings')).toBe(2);

    const primaryEvents = await engine.list('events', { calendarId: 'primary' });
    expect(primaryEvents).toHaveLength(3);
    expect(primaryEvents.map((e) => e['summary']).sort()).toEqual(['Lunch', 'Review', 'Standup']);
  });

  it('creates an event local-first with a document-valid id and marks it synced', async () => {
    const { fetchImpl, events } = makeGoogleMock();
    const engine = await makeEngine(dir, fetchImpl);
    await engine.fullRead();

    const { item, change } = await engine.create(
      'events',
      {
        summary: 'New meeting',
        start: { dateTime: '2026-07-22T09:00:00Z' },
        end: { dateTime: '2026-07-22T10:00:00Z' },
      },
      { calendarId: 'primary' },
    );

    // The id was minted to match the overlay-declared pattern (base32hex).
    expect(String(item['id'])).toMatch(/^[0-9a-v]{26}$/);
    // Local copy reflects it immediately (before the server confirms).
    expect(change.state).toBe('syncing');
    expect(await engine.list('events', { calendarId: 'primary' })).toHaveLength(4);
    expect(await engine.get('events', String(item['id']), { calendarId: 'primary' })).toMatchObject({
      summary: 'New meeting',
    });

    await engine.drain();
    const settled = engine.status().changes.find((c) => c.changeId === change.changeId);
    expect(settled?.state).toBe('synced');
    // And it reached the (mock) server.
    expect(events.primary?.has(String(item['id']))).toBe(true);
  });

  it('updates and deletes local-first and syncs to the server', async () => {
    const { fetchImpl, events } = makeGoogleMock();
    const engine = await makeEngine(dir, fetchImpl);
    await engine.fullRead();

    const update = await engine.update('events', 'e1', { summary: 'Standup (moved)' }, { calendarId: 'primary' });
    expect(await engine.get('events', 'e1', { calendarId: 'primary' })).toMatchObject({
      summary: 'Standup (moved)',
    });
    await engine.drain();
    expect(engine.status().changes.find((c) => c.changeId === update.change.changeId)?.state).toBe(
      'synced',
    );
    expect(events.primary?.get('e1')).toMatchObject({ summary: 'Standup (moved)' });

    const del = await engine.remove('events', 'e2', { calendarId: 'primary' });
    expect(await engine.get('events', 'e2', { calendarId: 'primary' })).toBeUndefined();
    await engine.drain();
    expect(engine.status().changes.find((c) => c.changeId === del.change.changeId)?.state).toBe(
      'synced',
    );
    expect(events.primary?.has('e2')).toBe(false);
  });

  it('rolls back a local change when the server sync fails', async () => {
    const { fetchImpl } = makeGoogleMock();
    const engine = await makeEngine(dir, fetchImpl);
    await engine.fullRead();

    const { change } = await engine.update('events', 'bad1', { summary: 'Should not stick' }, { calendarId: 'broken' });
    // Optimistically applied locally first.
    expect(await engine.get('events', 'bad1', { calendarId: 'broken' })).toMatchObject({
      summary: 'Should not stick',
    });

    await engine.drain();

    const settled = engine.status().changes.find((c) => c.changeId === change.changeId);
    expect(settled?.state).toBe('failed');
    expect(settled?.error).toBeTruthy();
    // Local copy was rolled back to the pre-edit value.
    expect(await engine.get('events', 'bad1', { calendarId: 'broken' })).toMatchObject({ summary: 'Bad' });
    expect(engine.status().failed).toBeGreaterThanOrEqual(1);
  });
});
