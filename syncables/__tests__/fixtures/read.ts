/**
 * Documents for the browser read path's tests (`__tests__/unit/read/`).
 * The pets, calendar and workspace shapes are carried over from the
 * browser port in ontola/atomic-plugins PR #76
 * (`integrations/localthought/reflector-read.test.ts`), which this read
 * path replaces; the Notion shape is new, for POST-body pagination.
 */
import type { OpenApiDocument } from '../../src/browser.js';
import type { OverlayDocument } from '../../src/browser.js';
import type { ResponseObject } from '../../src/openapi/types.js';

const json = (schema: Record<string, unknown>): Record<string, ResponseObject> => ({
  '200': {
    description: 'OK',
    content: { 'application/json': { schema } },
  },
});

/** The shape of integrations/pets/fixtures/pets/document.json: Link-header pagination. */
export const pets: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Pets', version: '1.0.0' },
  servers: [{ url: 'https://pets.example' }],
  paths: {
    '/pets': {
      get: {
        'x-pagination': [{ scheme: 'nextLink' }],
        responses: json({
          type: 'array',
          items: { $ref: '#/components/schemas/Pet' },
        }),
      },
    },
  },
  components: {
    paginationSchemes: {
      nextLink: {
        type: 'nextLink',
        response: { headers: { Link: { role: 'nextLink' } } },
      },
    },
    schemas: {
      Pet: {
        type: 'object',
        required: ['id', 'name'],
        properties: {
          id: { type: 'integer' },
          name: { type: 'string' },
          age: { type: 'integer' },
          vaccinated: { type: 'boolean' },
          weight: { type: 'number' },
          updated_at: { type: 'string', format: 'date-time' },
        },
      },
    },
    crudResources: {
      pet: {
        schema: { $ref: '#/components/schemas/Pet' },
        identity: {
          urlTemplate: '/pets/{pet_id}',
          bindings: { pet_id: { field: 'id' } },
        },
        collections: { pets: { urlTemplate: '/pets' } },
      },
    },
  },
};

export const petRows = ['Rex', 'Whiskers', 'Tweety', 'Nibbles', 'Bubbles'].map(
  (name, i) => ({
    id: i + 1,
    name,
    age: i + 1,
    vaccinated: i % 2 === 0,
    weight: i + 0.5,
    updated_at: '2026-09-09T00:00:00Z',
  }),
);

/** Calendar-shaped: events nested under each calendar, pageToken in the query. */
export const calendar: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Calendar', version: '1' },
  servers: [{ url: 'https://api.example/v3' }],
  paths: {
    '/users/me/calendarList': {
      get: {
        responses: json({
          type: 'object',
          properties: {
            items: { type: 'array', items: { type: 'object' } },
          },
        }),
      },
    },
    '/calendars/{calendarId}/events': {
      get: {
        parameters: [{ name: 'pageToken', in: 'query' }],
        responses: json({ $ref: '#/components/schemas/Events' }),
      },
    },
  },
  components: {
    paginationSchemes: {
      token: {
        type: 'pageToken',
        request: { queryParameters: { pageToken: { role: 'pageToken' } } },
        response: { bodyFields: { nextPageToken: { role: 'nextPageToken' } } },
      },
    },
    schemas: {
      Events: {
        type: 'object',
        properties: {
          nextPageToken: { type: 'string' },
          items: {
            type: 'array',
            items: { $ref: '#/components/schemas/Event' },
          },
        },
      },
      Event: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          summary: { type: 'string' },
          start: { type: 'object' },
        },
      },
    },
    crudResources: {
      calendar: {
        schema: {
          type: 'object',
          properties: { id: { type: 'string' }, summary: { type: 'string' } },
        },
        identity: {
          urlTemplate: '/calendars/{calendarId}',
          bindings: { calendarId: { field: 'id' } },
        },
        collections: {
          calendarList: { urlTemplate: '/users/me/calendarList' },
        },
      },
      event: {
        schema: { $ref: '#/components/schemas/Event' },
        identity: {
          urlTemplate: '/calendars/{calendarId}/events/{eventId}',
          bindings: { calendarId: { field: 'id' }, eventId: { field: 'id' } },
        },
        collections: {
          events: { urlTemplate: '/calendars/{calendarId}/events' },
        },
      },
    },
  },
};

/** Clockify-shaped: a workspace the user names, page numbers, a selection. */
export const workspace: OpenApiDocument = {
  openapi: '3.0.3',
  info: { title: 'Timesheets', version: '1' },
  servers: [{ url: 'https://api.example/api/v1' }],
  paths: {
    '/workspaces/{workspaceId}/entries': {
      get: {
        parameters: [
          { name: 'page', in: 'query' },
          { $ref: '#/components/parameters/start' },
        ],
        responses: {},
      },
    },
  },
  components: {
    parameters: { start: { name: 'start', in: 'query' } },
    paginationSchemes: {
      pages: {
        type: 'pageNumber',
        request: { queryParameters: { page: { role: 'page' } } },
      },
    },
    crudResources: {
      entry: {
        schema: { type: 'object', properties: { id: { type: 'string' } } },
        identity: {
          urlTemplate: '/workspaces/{workspaceId}/entries/{entryId}',
          bindings: { entryId: { field: 'id' } },
        },
        collections: {
          entries: {
            urlTemplate: '/workspaces/{workspaceId}/entries',
            'x-list-query': { hydrated: true },
          },
        },
      },
    },
  },
} as unknown as OpenApiDocument;

/**
 * Notion-shaped, with no pagination or crudResources of its own: those come
 * from the two overlays below, as they would for a vendored upstream
 * document. Both list endpoints are POSTs with the cursor in the JSON body.
 */
export const notion: Record<string, unknown> = {
  openapi: '3.0.3',
  info: { title: 'Notion', version: '2022-06-28' },
  servers: [{ url: 'https://api.notion.com' }],
  paths: {
    '/v1/search': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  query: { type: 'string' },
                  filter: { type: 'object' },
                  start_cursor: { type: 'string' },
                  page_size: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: json({ $ref: '#/components/schemas/List' }),
      },
    },
    '/v1/databases/{database_id}/query': {
      post: {
        requestBody: {
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  start_cursor: { type: 'string' },
                  page_size: { type: 'integer' },
                },
              },
            },
          },
        },
        responses: json({ $ref: '#/components/schemas/List' }),
      },
    },
  },
  components: {
    schemas: {
      List: {
        type: 'object',
        properties: {
          object: { type: 'string' },
          next_cursor: { type: 'string', nullable: true },
          has_more: { type: 'boolean' },
          results: { type: 'array', items: { type: 'object' } },
        },
      },
      Database: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          object: { type: 'string' },
          last_edited_time: { type: 'string', format: 'date-time' },
        },
      },
      Page: {
        type: 'object',
        required: ['id'],
        properties: {
          id: { type: 'string' },
          object: { type: 'string' },
          properties: { type: 'object' },
          last_edited_time: { type: 'string', format: 'date-time' },
        },
      },
    },
  },
};

export const notionPaginationOverlay: OverlayDocument = {
  overlay: '1.0.0',
  info: { title: 'Notion pagination', version: '1' },
  actions: [
    {
      target: '$.components',
      update: {
        paginationSchemes: {
          notionCursor: {
            type: 'pageToken',
            request: {
              bodyFields: {
                start_cursor: { role: 'cursor' },
                page_size: { role: 'pageSize' },
              },
            },
            response: {
              bodyFields: { next_cursor: { role: 'nextCursor' } },
            },
          },
        },
      },
    },
  ],
};

export const notionCrudOverlay: OverlayDocument = {
  overlay: '1.0.0',
  info: { title: 'Notion CRUD resources', version: '1' },
  actions: [
    {
      target: '$.components',
      update: {
        crudResources: {
          database: {
            schema: { $ref: '#/components/schemas/Database' },
            identity: {
              urlTemplate: '/v1/databases/{database_id}',
              bindings: { database_id: { field: 'id' } },
            },
            collections: {
              databases: {
                urlTemplate: '/v1/search',
                'x-list-method': 'POST',
                'x-list-body': {
                  filter: { property: 'object', value: 'database' },
                },
              },
            },
          },
          page: {
            schema: { $ref: '#/components/schemas/Page' },
            identity: {
              urlTemplate: '/v1/pages/{page_id}',
              bindings: { page_id: { field: 'id' } },
            },
            collections: {
              rows: {
                urlTemplate: '/v1/databases/{database_id}/query',
                'x-list-method': 'POST',
              },
            },
          },
        },
      },
    },
  ],
};
