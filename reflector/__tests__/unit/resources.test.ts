import { join } from 'node:path';
import { beforeAll, describe, expect, it } from 'vitest';
import { loadConfig, type ReflectorConfig } from '../../src/config/index.js';
import { buildDocument } from '../../src/sync/document.js';
import {
  discoverResourceModel,
  generateId,
  type ResourceModel,
} from '../../src/sync/resources.js';

const cwd = process.cwd();
const config: ReflectorConfig = {
  ...loadConfig(),
  openApiPath: join(cwd, 'spec/google-calendar-v3.openapi.yaml'),
  overlayDir: join(cwd, 'spec/overlays'),
};

let model: ResourceModel;
beforeAll(async () => {
  model = discoverResourceModel(await buildDocument(config));
});

describe('discoverResourceModel', () => {
  it('discovers the calendar/event collections from crudResources', () => {
    const events = model.byName('events');
    expect(events?.collectionUrl).toBe('/calendars/{calendarId}/events');
    expect(events?.itemUrl).toBe('/calendars/{calendarId}/events/{eventId}');
    expect(events?.itemsField).toBe('items');
    expect(events?.contextParams).toEqual(['calendarId']);
    expect(events?.paths).toEqual([
      '/calendars/{calendarId}/events',
      '/calendars/{calendarId}/events/{eventId}',
    ]);
  });

  it('marks top-level collections as context-free', () => {
    expect(model.byName('calendarList')?.contextParams).toEqual([]);
    expect(model.byName('settings')?.contextParams).toEqual([]);
  });

  it('links a nested context param to the enumerable parent that provides it', () => {
    // `calendarId` comes from listing `calendarList` and reading each id — not
    // from `calendar`, which binds calendarId too but has no listable collection.
    expect(model.providerFor('calendarId')).toEqual({
      collection: 'calendarList',
      field: 'id',
    });
  });

  it('reads the client-generated id policy for events from the overlay', () => {
    const events = model.byName('events');
    expect(events?.generatesId).toBe(true);
    expect(events?.idPattern).toBe('^[a-v0-9]{26}$');
  });
});

describe('generateId', () => {
  it('mints an id matching a simple charset/length pattern', () => {
    expect(generateId('^[a-v0-9]{26}$')).toMatch(/^[0-9a-v]{26}$/);
  });

  it('honours a min/max length range', () => {
    const id = generateId('^[a-f]{4,8}$');
    expect(id.length).toBeGreaterThanOrEqual(4);
    expect(id.length).toBeLessThanOrEqual(8);
    expect(id).toMatch(/^[a-f]+$/);
  });

  it('falls back to a uuid when there is no usable pattern', () => {
    expect(generateId()).toMatch(/^[0-9a-f-]{36}$/);
    expect(generateId('not-a-charset-pattern')).toMatch(/^[0-9a-f-]{36}$/);
  });
});
