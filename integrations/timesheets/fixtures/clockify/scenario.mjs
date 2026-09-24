/**
 * Synthetic Clockify fixtures. No real account data, and no writes reach a
 * real provider: the write endpoints below change only this in-memory model.
 */

/** The proxy's Clockify catalog document before the time-entry write
 * overlay, as JSON: the read-only subset of the public API with apiKey auth
 * and page-number pagination. */
export const clockifyReadOnlyDocument = {
  components: {
    crudResources: {
      timeEntry: {
        collections: {
          timeEntries: {
            urlTemplate:
              '/v1/workspaces/{workspaceId}/user/{userId}/time-entries',
          },
        },
        description: 'A time entry on a Clockify workspace.',
        identity: {
          bindings: {
            id: {
              field: 'id',
            },
          },
          urlTemplate: '/v1/workspaces/{workspaceId}/time-entries/{id}',
        },
        schema: {
          $ref: '#/components/schemas/TimeEntry',
        },
      },
    },
    paginationSchemes: {
      pageNumber: {
        description:
          "Clockify's list endpoints use 1-indexed page/page-size query parameters and return a plain JSON array with no pagination metadata in the body. Clockify also reports completion via a custom Last-Page response header, but paging stops the same way as other pageNumber platforms in this catalog: a page shorter than the requested page-size is the last one.",
        request: {
          queryParameters: {
            page: {
              role: 'page',
            },
            'page-size': {
              role: 'pageSize',
            },
          },
        },
        type: 'pageNumber',
      },
    },
    parameters: {
      End: {
        description:
          'Represents an end date in the yyyy-MM-ddThh:mm:ssZ format.',
        in: 'query',
        name: 'end',
        required: false,
        schema: {
          format: 'date-time',
          type: 'string',
        },
      },
      Page: {
        description: 'Page number.',
        in: 'query',
        name: 'page',
        required: false,
        schema: {
          default: 1,
          minimum: 1,
          type: 'integer',
        },
      },
      PageSize: {
        description: 'Page size.',
        in: 'query',
        name: 'page-size',
        required: false,
        schema: {
          default: 50,
          minimum: 1,
          type: 'integer',
        },
      },
      Start: {
        description:
          'Represents a start date in the yyyy-MM-ddThh:mm:ssZ format.',
        in: 'query',
        name: 'start',
        required: false,
        schema: {
          format: 'date-time',
          type: 'string',
        },
      },
      UserId: {
        description: 'Represents a user identifier across the system.',
        in: 'path',
        name: 'userId',
        required: true,
        schema: {
          type: 'string',
        },
      },
      WorkspaceId: {
        description: 'Represents a workspace identifier across the system.',
        in: 'path',
        name: 'workspaceId',
        required: true,
        schema: {
          type: 'string',
        },
      },
    },
    schemas: {
      TimeEntry: {
        properties: {
          billable: {
            type: 'boolean',
          },
          description: {
            nullable: true,
            type: 'string',
          },
          id: {
            type: 'string',
          },
          isLocked: {
            type: 'boolean',
          },
          kioskId: {
            nullable: true,
            type: 'string',
          },
          projectId: {
            nullable: true,
            type: 'string',
          },
          tagIds: {
            items: {
              type: 'string',
            },
            nullable: true,
            type: 'array',
          },
          taskId: {
            nullable: true,
            type: 'string',
          },
          timeInterval: {
            $ref: '#/components/schemas/TimeInterval',
          },
          type: {
            enum: ['REGULAR', 'BREAK'],
            type: 'string',
          },
          userId: {
            type: 'string',
          },
          workspaceId: {
            type: 'string',
          },
        },
        required: ['id', 'workspaceId', 'userId'],
        type: 'object',
      },
      TimeInterval: {
        nullable: true,
        properties: {
          duration: {
            nullable: true,
            type: 'string',
          },
          end: {
            format: 'date-time',
            nullable: true,
            type: 'string',
          },
          start: {
            format: 'date-time',
            nullable: true,
            type: 'string',
          },
        },
        type: 'object',
      },
    },
    securitySchemes: {
      clockifyApiKey: {
        description:
          "A personal API key generated in Clockify's Profile Settings. Clockify has no OAuth2 login; this is the only supported authentication mode.",
        in: 'header',
        name: 'X-Api-Key',
        type: 'apiKey',
      },
    },
  },
  info: {
    title: 'Synthetic Clockify',
    version: 'v1',
    description:
      'Test-only subset of the Clockify catalog document. No real account data.',
  },
  openapi: '3.0.3',
  paths: {
    // Setup and naming reads, as the read overlays declare them
    // (crud-causality-overlay.yaml + auth-overlay.yaml), in short form:
    // only what the proxy's allow check reads is needed here.
    '/v1/user': {
      get: {
        operationId: 'getClockifyCurrentUser',
        security: [{ clockifyApiKey: [] }],
      },
    },
    '/v1/workspaces': {
      get: {
        operationId: 'listClockifyWorkspaces',
        security: [{ clockifyApiKey: [] }],
      },
    },
    '/v1/workspaces/{workspaceId}/projects': {
      get: {
        operationId: 'listClockifyProjects',
        security: [{ clockifyApiKey: [] }],
      },
    },
    '/v1/workspaces/{workspaceId}/projects/{id}': {
      get: {
        operationId: 'getClockifyProject',
        security: [{ clockifyApiKey: [] }],
      },
    },
    '/v1/workspaces/{workspaceId}/users': {
      get: {
        operationId: 'listClockifyMembers',
        security: [{ clockifyApiKey: [] }],
      },
    },
    '/v1/workspaces/{workspaceId}/users/{id}': {
      get: {
        operationId: 'getClockifyMember',
        security: [{ clockifyApiKey: [] }],
      },
    },
    '/v1/workspaces/{workspaceId}/time-entries/{id}': {
      get: {
        operationId: 'get-time-entry',
        parameters: [
          {
            $ref: '#/components/parameters/WorkspaceId',
          },
          {
            description:
              'Represents a time entry identifier across the system.',
            in: 'path',
            name: 'id',
            required: true,
            schema: {
              type: 'string',
            },
          },
        ],
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  $ref: '#/components/schemas/TimeEntry',
                },
              },
            },
            description: 'A single time entry.',
          },
          401: {
            description: 'The API key is missing or invalid.',
          },
          403: {
            description: 'The request is not allowed.',
          },
          404: {
            description: 'The time entry does not exist.',
          },
        },
        security: [
          {
            clockifyApiKey: [],
          },
        ],
        summary: 'Get a specific time entry on a workspace',
        'x-crud': {
          action: 'read',
          resource: 'timeEntry',
        },
      },
    },
    '/v1/workspaces/{workspaceId}/user/{userId}/time-entries': {
      get: {
        operationId: 'get-time-entries-for-user',
        parameters: [
          {
            $ref: '#/components/parameters/WorkspaceId',
          },
          {
            $ref: '#/components/parameters/UserId',
          },
          {
            $ref: '#/components/parameters/Start',
          },
          {
            $ref: '#/components/parameters/End',
          },
          {
            $ref: '#/components/parameters/Page',
          },
          {
            $ref: '#/components/parameters/PageSize',
          },
        ],
        responses: {
          200: {
            content: {
              'application/json': {
                schema: {
                  items: {
                    $ref: '#/components/schemas/TimeEntry',
                  },
                  type: 'array',
                },
              },
            },
            description: "A page of the user's time entries on this workspace.",
          },
          401: {
            description: 'The API key is missing or invalid.',
          },
          403: {
            description: 'The request is not allowed.',
          },
        },
        security: [
          {
            clockifyApiKey: [],
          },
        ],
        summary: 'Get time entries for a user on a workspace',
        'x-crud': {
          action: 'list',
          collection: 'timeEntries',
          resource: 'timeEntry',
        },
        'x-pagination': [
          {
            scheme: 'pageNumber',
          },
        ],
      },
    },
  },
  security: [
    {
      clockifyApiKey: [],
    },
  ],
  servers: [
    {
      url: 'https://api.clockify.me/api',
    },
  ],
};

const entryIdParameter = {
  description: 'Represents a time entry identifier across the system.',
  in: 'path',
  name: 'id',
  required: true,
  schema: { type: 'string' },
};
const writeBody = {
  required: true,
  content: {
    'application/json': {
      schema: { $ref: '#/components/schemas/TimeEntryWriteRequest' },
    },
  },
};
const entryResponse = description => ({
  content: {
    'application/json': { schema: { $ref: '#/components/schemas/TimeEntry' } },
  },
  description,
});
const security = [{ clockifyApiKey: [] }];

/**
 * The catalog document with the time-entry write overlay applied
 * (`overlays/clockify.me/1.0.0-readonly/time-entry-write-overlay.yaml`,
 * #123 M0): POST on the workspace's time entries, PUT and DELETE on one
 * entry. Hand-kept in step with that overlay, like the read-only part above
 * is with the base document. `clockifyReadOnlyDocument` is the document
 * without it, for a proxy whose catalog predates the overlay.
 */
export const clockifyDocument = {
  ...clockifyReadOnlyDocument,
  components: {
    ...clockifyReadOnlyDocument.components,
    schemas: {
      ...clockifyReadOnlyDocument.components.schemas,
      TimeEntryWriteRequest: {
        properties: {
          billable: { type: 'boolean' },
          customFields: {
            items: {
              properties: { customFieldId: { type: 'string' }, value: {} },
              required: ['customFieldId'],
              type: 'object',
            },
            type: 'array',
          },
          description: { type: 'string' },
          end: { format: 'date-time', type: 'string' },
          projectId: { type: 'string' },
          start: { format: 'date-time', type: 'string' },
          tagIds: { items: { type: 'string' }, type: 'array' },
          taskId: { type: 'string' },
          type: { enum: ['REGULAR', 'BREAK'], type: 'string' },
        },
        required: ['start'],
        type: 'object',
      },
    },
  },
  info: {
    ...clockifyReadOnlyDocument.info,
    description:
      'Test-only subset of the Clockify catalog document, with the time-entry write overlay. No real account data.',
  },
  paths: {
    ...clockifyReadOnlyDocument.paths,
    '/v1/workspaces/{workspaceId}/time-entries': {
      post: {
        operationId: 'create-time-entry',
        parameters: [{ $ref: '#/components/parameters/WorkspaceId' }],
        requestBody: writeBody,
        responses: {
          201: entryResponse('The created time entry.'),
          400: { description: 'The request body is not a valid time entry.' },
          401: { description: 'The API key is missing or invalid.' },
          403: { description: 'The request is not allowed.' },
        },
        security,
        summary: 'Add a new time entry for the connected user',
        'x-crud': {
          action: 'create',
          addedFields: {
            id: { schema: { type: 'string' }, source: 'generated' },
          },
          resource: 'timeEntry',
          url: { source: 'template' },
        },
      },
    },
    '/v1/workspaces/{workspaceId}/time-entries/{id}': {
      ...clockifyReadOnlyDocument.paths[
        '/v1/workspaces/{workspaceId}/time-entries/{id}'
      ],
      put: {
        operationId: 'update-time-entry',
        parameters: [
          { $ref: '#/components/parameters/WorkspaceId' },
          entryIdParameter,
        ],
        requestBody: writeBody,
        responses: {
          200: entryResponse('The updated time entry.'),
          400: { description: 'The request body is not a valid time entry.' },
          401: { description: 'The API key is missing or invalid.' },
          403: { description: 'The request is not allowed.' },
          404: { description: 'The time entry does not exist.' },
        },
        security,
        summary: 'Replace a time entry on a workspace',
        'x-crud': { action: 'update', mode: 'replace', resource: 'timeEntry' },
      },
      delete: {
        operationId: 'delete-time-entry',
        parameters: [
          { $ref: '#/components/parameters/WorkspaceId' },
          entryIdParameter,
        ],
        responses: {
          204: { description: 'The time entry was deleted.' },
          401: { description: 'The API key is missing or invalid.' },
          403: { description: 'The request is not allowed.' },
          404: { description: 'The time entry does not exist.' },
        },
        security,
        summary: 'Delete a time entry from a workspace',
        'x-crud': { action: 'delete', resource: 'timeEntry' },
      },
    },
  },
};

export const WORKSPACE = {
  id: 'aaaaaaaaaaaaaaaaaaaaaaaa',
  name: 'Test workspace',
};
export const USER = { id: 'bbbbbbbbbbbbbbbbbbbbbbbb', name: 'Test Person' };
const hour = 3_600_000;
const iso = ms => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** One synthetic time entry in Clockify's response shape. */
export function clockifyEntry(id, description, start, end, extra = {}) {
  return {
    id,
    description,
    userId: USER.id,
    workspaceId: WORKSPACE.id,
    billable: true,
    projectId: 'cccccccccccccccccccccccc',
    taskId: null,
    tagIds: null,
    kioskId: null,
    isLocked: false,
    type: 'REGULAR',
    timeInterval: {
      start: iso(start),
      end: end === null ? null : iso(end),
      duration: end === null ? null : 'PT1H',
    },
    ...extra,
  };
}

/** Entries relative to `now`, so a 7-day window always finds some: two
 * completed entries yesterday, one older completed entry, a running timer
 * and a break (both skipped by the lens). */
export function clockifyEntries(now = Date.now()) {
  const day = 24 * hour;
  const entry = clockifyEntry;

  return [
    entry(
      'entry-1',
      'Fix plugin source loading',
      now - day - 4 * hour,
      now - day - 2 * hour,
    ),
    entry('entry-2', 'Weekly sync', now - day - hour, now - day, {
      billable: false,
    }),
    entry(
      'entry-3',
      'Plugin catalog evidence',
      now - 20 * day,
      now - 20 * day + 3 * hour,
    ),
    entry('entry-4', 'Still running', now - hour, null),
    entry('entry-5', 'Lunch', now - day + hour, now - day + 2 * hour, {
      type: 'BREAK',
    }),
  ];
}

export const PROJECT = {
  id: 'cccccccccccccccccccccccc',
  name: 'Atomic plugins',
};

const PREFIX = '/proxy/clockify/api';

/** integration-proxy's body for a 404 it answers itself (`proxy.rs`). */
export const NOT_IN_CATALOG = 'method or path is not in the catalog';
const WRITES = ['POST', 'PUT', 'DELETE'];

/** Does `document` declare `method` on the provider path `path`, the way
 * integration-proxy's `Catalog::allows` decides it? */
function declares(document, method, path) {
  const segments = path.split('/');

  return Object.entries(document.paths).some(([template, item]) => {
    const parts = template.split('/');

    return (
      parts.length === segments.length &&
      parts.every(
        (part, i) =>
          (part.startsWith('{') && segments[i] !== '') || part === segments[i],
      ) &&
      typeof item[method.toLowerCase()] === 'object'
    );
  });
}

const durationOf = (start, end) => {
  if (end === null) return null;
  const seconds = Math.round((Date.parse(end) - Date.parse(start)) / 1000);

  return `PT${seconds}S`;
};

/**
 * The mock's model of Clockify's create and full-replacement update. Not a
 * recording: it follows the documented behaviour (#123 §3.5, *unverified
 * live*): only `start` is required, every field left out is cleared, and a
 * body without `end` makes a running timer. Server-owned fields (`id`,
 * `userId`, `workspaceId`, `isLocked`, `kioskId`) come from `base`.
 */
function fromBody(body, base) {
  if (!body || typeof body !== 'object' || typeof body.start !== 'string')
    return { error: 'start is required' };
  const start = body.start;
  const end = typeof body.end === 'string' ? body.end : null;
  if (!Number.isFinite(Date.parse(start)))
    return { error: 'start is not a date-time' };
  if (end !== null && !(Date.parse(end) >= Date.parse(start)))
    return { error: 'end is before start' };

  return {
    entry: {
      ...base,
      description: typeof body.description === 'string' ? body.description : '',
      billable: body.billable === true,
      projectId: typeof body.projectId === 'string' ? body.projectId : null,
      taskId: typeof body.taskId === 'string' ? body.taskId : null,
      tagIds: Array.isArray(body.tagIds) ? [...body.tagIds] : null,
      type: typeof body.type === 'string' ? body.type : 'REGULAR',
      customFieldValues: Array.isArray(body.customFields)
        ? body.customFields.map(f => ({
            customFieldId: f.customFieldId,
            value: f.value,
          }))
        : null,
      timeInterval: { start, end, duration: durationOf(start, end) },
    },
  };
}

/**
 * `withNames: false` keeps the original behaviour of answering the projects
 * and users lists with 404, so a client's "names unavailable" path stays
 * testable.
 */
export function clockifyFixture({ withNames = true } = {}) {
  const fresh = () => ({
    entries: clockifyEntries(),
    /** Every provider request, as `METHOD /path?query`. */
    requests: [],
    /** Every write, with its parsed JSON body (for body assertions). */
    writes: [],
    /** Status to answer the next `failures.count` time-entry requests with. */
    failures: { count: 0, status: 500 },
    /** Methods answered `status` without being applied (`forbid`). */
    forbidden: { methods: [], status: 403 },
    /** Serve the catalog as it was before the write overlay. */
    readOnlyCatalog: false,
    /** One-shot write behaviours; see `control`. */
    applyThenDrop: null,
    failBefore: null,
    onNextRequest: [],
    deleteDuringPaging: null,
    created: 0,
  });
  const state = fresh();
  const find = id => state.entries.find(e => e.id === id);

  const remove = id => {
    const at = state.entries.findIndex(e => e.id === id);
    if (at >= 0) state.entries.splice(at, 1);

    return at >= 0;
  };

  /** Applies an `onNextRequest`/`deleteDuringPaging` style change. */
  const apply = change => {
    if (change.delete) remove(change.delete);
    if (change.add) state.entries.push(structuredClone(change.add));

    if (change.id && change.patch) {
      const entry = find(change.id);
      if (entry) Object.assign(entry, structuredClone(change.patch));
    }
  };

  const write = (method, id, body) => {
    if (method === 'POST') {
      state.created++;
      const newId = `e${String(state.created).padStart(23, '0')}`;
      const made = fromBody(body, {
        id: newId,
        userId: USER.id,
        workspaceId: WORKSPACE.id,
        isLocked: false,
        kioskId: null,
      });
      if (made.error) return { status: 400, body: { message: made.error } };
      state.entries.push(made.entry);

      return { status: 201, body: structuredClone(made.entry) };
    }

    const existing = find(id);
    if (!existing) return { status: 404, body: { message: 'Not found' } };
    // The live status for writing a locked entry is not documented
    // (unverified); the mock answers 400.
    if (existing.isLocked)
      return { status: 400, body: { message: 'Time entry is locked' } };

    if (method === 'DELETE') {
      remove(id);

      return { status: 204, body: null };
    }

    const { id: _, userId, workspaceId, isLocked, kioskId } = existing;
    const made = fromBody(body, {
      id,
      userId,
      workspaceId,
      isLocked,
      kioskId,
    });
    if (made.error) return { status: 400, body: { message: made.error } };
    state.entries[state.entries.indexOf(existing)] = made.entry;

    return { status: 200, body: structuredClone(made.entry) };
  };

  const serve = (method, url, body) => {
    const path = url.pathname;
    // The proxy only forwards what its catalog declares, and answers
    // anything else, read or write, with this 404 before Clockify sees it.
    const document = state.readOnlyCatalog
      ? clockifyReadOnlyDocument
      : clockifyDocument;
    if (
      !path.startsWith(PREFIX) ||
      !declares(document, method, path.slice(PREFIX.length))
    )
      return { status: 404, body: NOT_IN_CATALOG };
    const named = path.match(
      /^\/proxy\/clockify\/api\/v1\/workspaces\/([^/]+)\/(projects|users)$/,
    );

    if (named && method === 'GET' && withNames) {
      if (named[1] !== WORKSPACE.id)
        return { status: 403, body: { message: 'Forbidden' } };
      const page = Number(url.searchParams.get('page') ?? 1);
      const all = named[2] === 'projects' ? [PROJECT] : [USER];

      return { status: 200, body: page === 1 ? all : [] };
    }

    if (method === 'GET' && path === `${PREFIX}/v1/user`)
      return {
        status: 200,
        body: { ...USER, activeWorkspace: WORKSPACE.id },
      };
    if (method === 'GET' && path === `${PREFIX}/v1/workspaces`)
      return {
        status: 200,
        body: [WORKSPACE, { id: 'dddddddddddddddddddddddd', name: 'Personal' }],
      };

    const list = path.match(
      /^\/proxy\/clockify\/api\/v1\/workspaces\/([^/]+)\/user\/([^/]+)\/time-entries$/,
    );
    const one = path.match(
      /^\/proxy\/clockify\/api\/v1\/workspaces\/([^/]+)\/time-entries(?:\/([^/]+))?$/,
    );
    if (!list && !one) return { status: 404, body: { message: 'Not found' } };
    if ((list && list[1] !== WORKSPACE.id) || (list && list[2] !== USER.id))
      return { status: 403, body: { message: 'Forbidden' } };
    if (one && one[1] !== WORKSPACE.id)
      return { status: 403, body: { message: 'Forbidden' } };

    if (state.forbidden.methods.includes(method))
      return {
        status: state.forbidden.status,
        body: { message: 'Simulated refusal' },
      };

    if (state.failures.count > 0) {
      state.failures.count--;

      return {
        status: state.failures.status,
        body: { message: 'Simulated Clockify failure' },
      };
    }

    if (one && method === 'GET') {
      if (!one[2]) return { status: 404, body: { message: 'Not found' } };
      const entry = find(one[2]);

      return entry
        ? { status: 200, body: structuredClone(entry) }
        : { status: 404, body: { message: 'Not found' } };
    }

    if (one) {
      state.writes.push({ method, path, body: body ?? null });

      if (state.failBefore) {
        const { status } = state.failBefore;
        state.failBefore = null;

        return { status, body: { message: 'Simulated failure before write' } };
      }

      const result = write(method, one[2], body);

      if (state.applyThenDrop) {
        const { status, hang } = state.applyThenDrop;
        state.applyThenDrop = null;
        // The write took effect; the caller never learns it did.
        if (hang) return new Promise(() => {});

        return { status, body: { message: 'Simulated lost response' } };
      }

      return result;
    }

    // The list: filtered on the entry's *start* (the mock's reading of the
    // unverified live semantics, #123 §2.3), newest start first, with
    // Clockify's `Last-Page` header.
    const start = Date.parse(url.searchParams.get('start') ?? '') || -Infinity;
    const end = Date.parse(url.searchParams.get('end') ?? '') || Infinity;
    const size = Number(url.searchParams.get('page-size') ?? 50);
    const page = Number(url.searchParams.get('page') ?? 1);
    const matching = state.entries
      .filter(e => {
        const at = Date.parse(e.timeInterval.start);

        return at >= start && at <= end;
      })
      .sort(
        (a, b) =>
          Date.parse(b.timeInterval.start) - Date.parse(a.timeInterval.start),
      );
    const served = structuredClone(
      matching.slice((page - 1) * size, page * size),
    );

    if (page === 1 && state.deleteDuringPaging) {
      remove(state.deleteDuringPaging.id);
      state.deleteDuringPaging = null;
    }

    return {
      status: 200,
      body: served,
      headers: { 'Last-Page': String(page * size >= matching.length) },
    };
  };

  return {
    state,
    /**
     * Test-side driver, reached through mock-proxy.mjs's local-only
     * `POST /__fixture/clockify` (never through the proxy's own routes):
     *   { action: 'requests' }                -> the request and write logs
     *   { action: 'update', id, patch }       -> merge `patch` into an entry
     *   { action: 'add', entry }              -> add an entry (see clockifyEntry)
     *   { action: 'delete', id }              -> delete an entry in "Clockify"
     *   { action: 'fail', status?, count? }   -> fail time-entry requests
     *   { action: 'forbid', methods?, status? }
     *        -> answer these methods on time entries with `status` (403)
     *           without applying them; `methods: []` lifts it. Default: writes.
     *   { action: 'catalog', readOnly }       -> the proxy's catalog without
     *                                            the write overlay: writes 404
     *   { action: 'applyThenDrop', status?, hang? }
     *        -> apply the next write, then answer `status` (502) or never
     *   { action: 'failBefore', status? }     -> answer the next write 503,
     *                                            without applying it
     *   { action: 'onNextRequest', match, id?, patch?, delete?, add? }
     *        -> apply the change just before serving the next request whose
     *           `METHOD /path?query` contains `match`
     *   { action: 'deleteDuringPaging', id }  -> delete `id` after serving
     *                                            page 1 of the next list read
     *   { action: 'reset' }                   -> fresh entries, no switches
     */
    control(command) {
      switch (command?.action) {
        case 'requests':
          return { requests: state.requests, writes: state.writes };

        case 'update': {
          const entry = find(command.id);
          if (!entry) return { error: `no entry ${command.id}` };
          Object.assign(entry, command.patch ?? {});

          return { entry };
        }

        case 'add':
          if (!command.entry?.id) return { error: 'entry needs an id' };
          state.entries.push(structuredClone(command.entry));

          return { entry: command.entry };
        case 'delete':
          return { deleted: remove(command.id) };
        case 'fail':
          state.failures = {
            count: Number(command.count ?? 1),
            status: Number(command.status ?? 500),
          };

          return { failures: state.failures };
        case 'forbid':
          state.forbidden = {
            methods: Array.isArray(command.methods)
              ? command.methods.map(String)
              : [...WRITES],
            status: Number(command.status ?? 403),
          };

          return { forbidden: state.forbidden };
        case 'catalog':
          state.readOnlyCatalog = command.readOnly === true;

          return { readOnly: state.readOnlyCatalog };
        case 'applyThenDrop':
          state.applyThenDrop = {
            status: Number(command.status ?? 502),
            hang: command.hang === true,
          };

          return { applyThenDrop: state.applyThenDrop };
        case 'failBefore':
          state.failBefore = { status: Number(command.status ?? 503) };

          return { failBefore: state.failBefore };
        case 'onNextRequest':
          if (typeof command.match !== 'string')
            return { error: 'match is required' };
          state.onNextRequest.push(structuredClone(command));

          return { pending: state.onNextRequest.length };
        case 'deleteDuringPaging':
          state.deleteDuringPaging = { id: String(command.id) };

          return { deleteDuringPaging: state.deleteDuringPaging };
        case 'reset':
          Object.assign(state, fresh());

          return {};
        default:
          return { error: 'unknown action' };
      }
    },
    request(method, url, body) {
      const line = `${method} ${url.pathname}${url.search}`;
      state.requests.push(line);
      const due = state.onNextRequest.findIndex(c => line.includes(c.match));
      if (due >= 0) apply(state.onNextRequest.splice(due, 1)[0]);

      return serve(method, url, body);
    },
  };
}

export default {
  title: 'Clockify',
  document: clockifyDocument,
  /** Writes carry a JSON body (mock-proxy.mjs parses it for the fixture). */
  jsonBody: true,
  create: clockifyFixture,
};
