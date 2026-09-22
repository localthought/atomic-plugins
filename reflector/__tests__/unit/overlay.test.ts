import { describe, expect, it } from 'vitest';
import {
  adaptSchemesForSyncables,
  applyOverlay,
  parseTarget,
  type OverlayDocument,
} from '../../src/sync/overlay.js';

describe('parseTarget', () => {
  it('parses the document root', () => {
    expect(parseTarget('$')).toEqual([]);
  });

  it('parses dot paths', () => {
    expect(parseTarget('$.components.paginationSchemes')).toEqual([
      'components',
      'paginationSchemes',
    ]);
  });

  it('parses quoted bracket paths containing slashes and braces', () => {
    expect(parseTarget("$.paths['/calendars/{calendarId}/events'].get")).toEqual([
      'paths',
      '/calendars/{calendarId}/events',
      'get',
    ]);
  });
});

describe('applyOverlay', () => {
  it('deep-merges update actions and creates missing parents', () => {
    const doc = { paths: { "/calendars/{calendarId}/events": { get: {} } } };
    const overlay: OverlayDocument = {
      overlay: '1.0.0',
      info: { title: 't', version: '1' },
      actions: [
        {
          target: "$.paths['/calendars/{calendarId}/events'].get",
          update: { 'x-pagination': [{ scheme: 'eventSync' }] },
        },
      ],
    };
    const result = applyOverlay(doc, overlay);
    expect(result.paths['/calendars/{calendarId}/events'].get).toEqual({
      'x-pagination': [{ scheme: 'eventSync' }],
    });
  });

  it('does not mutate the input document', () => {
    const doc = { components: {} as Record<string, unknown> };
    applyOverlay(doc, {
      overlay: '1.0.0',
      info: { title: 't', version: '1' },
      actions: [{ target: '$.components', update: { added: true } }],
    });
    expect(doc.components).toEqual({});
  });
});

describe('adaptSchemesForSyncables', () => {
  it('rewrites incrementalSync to pageToken and drops sync-token roles', () => {
    const doc = {
      openapi: '3.0.0',
      info: { title: 't', version: '1' },
      paths: {},
      components: {
        paginationSchemes: {
          eventSync: {
            type: 'incrementalSync',
            request: {
              queryParameters: {
                maxResults: { role: 'pageSize' },
                pageToken: { role: 'pageToken' },
                syncToken: { role: 'syncToken' },
              },
            },
            response: {
              envelope: { itemsField: 'items' },
              bodyFields: {
                nextPageToken: { role: 'nextPageToken' },
                nextSyncToken: { role: 'nextSyncToken' },
              },
            },
          },
        },
      },
    };
    const adapted = adaptSchemesForSyncables(doc as never) as unknown as typeof doc;
    const scheme = adapted.components.paginationSchemes.eventSync;
    expect(scheme.type).toBe('pageToken');
    expect(Object.keys(scheme.request.queryParameters)).toEqual(['maxResults', 'pageToken']);
    expect(Object.keys(scheme.response.bodyFields)).toEqual(['nextPageToken']);
    // The envelope hint is preserved and harmless.
    expect(scheme.response.envelope).toEqual({ itemsField: 'items' });
  });
});
