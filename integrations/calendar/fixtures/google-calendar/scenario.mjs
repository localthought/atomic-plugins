/** Synthetic Google Calendar fixtures. No real calendar data or provider writes. */
const string = { type: 'string' };
const dateTime = {
  type: 'object',
  properties: {
    date: { ...string, format: 'date' },
    dateTime: { ...string, format: 'date-time' },
    timeZone: string,
  },
};

export const calendarDocument = {
  openapi: '3.0.3',
  info: { title: 'Synthetic Calendar', version: 'v3' },
  servers: [{ url: 'https://www.googleapis.com/calendar/v3' }],
  paths: {
    '/calendars/{calendarId}/events': {
      get: {
        parameters: [
          { name: 'calendarId', in: 'path', required: true, schema: string },
          ...['pageToken', 'timeMin', 'timeMax', 'orderBy'].map(name => ({
            name,
            in: 'query',
            schema: string,
          })),
          { name: 'singleEvents', in: 'query', schema: { type: 'boolean' } },
          { name: 'showDeleted', in: 'query', schema: { type: 'boolean' } },
        ],
        'x-pagination': [{ scheme: 'pageToken' }],
        responses: {
          200: {
            description: 'Events',
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    items: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/event' },
                    },
                    nextPageToken: string,
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  components: {
    paginationSchemes: {
      pageToken: {
        type: 'pageToken',
        request: { queryParameters: { pageToken: { role: 'pageToken' } } },
        response: { bodyFields: { nextPageToken: { role: 'nextPageToken' } } },
      },
    },
    schemas: {
      event: {
        type: 'object',
        properties: {
          id: string,
          summary: string,
          status: string,
          start: dateTime,
          end: dateTime,
          recurringEventId: string,
          originalStartTime: dateTime,
          recurrence: { type: 'array', items: string },
          htmlLink: string,
          attendees: {
            type: 'array',
            items: {
              type: 'object',
              properties: { email: string, responseStatus: string },
            },
          },
        },
      },
    },
    crudResources: {
      event: {
        schema: { $ref: '#/components/schemas/event' },
        identity: {
          urlTemplate: '/calendars/{calendarId}/events/{eventId}',
          bindings: { eventId: { field: 'id' } },
        },
        collections: {
          events: { urlTemplate: '/calendars/{calendarId}/events' },
        },
      },
    },
  },
};
/** The primary calendar's id, as Google reports it in calendarList. */
export const PRIMARY = 'synthetic@example.com';
/** A second, read-only calendar, so choosing one is a real choice. */
export const TEAM = 'team@group.calendar.google.com';
/** Events per list page. Google may return fewer than `maxResults`; a small
 * page makes the adapter's pagination run on only a handful of events. */
export const PAGE = 2;

const patchable = ['summary', 'description', 'location', 'start', 'end'];

/**
 * A stateful synthetic Google Calendar. Events are kept per calendar;
 * `primary` is an alias for {@link PRIMARY}, as it is at Google.
 *
 * Primary holds one all-day event, one timed event, a weekly series (its
 * master and one instance) and one cancelled event. Only the first two are
 * importable in the adapter's scope; the others exercise its skip rules.
 *
 * Writes: `PATCH .../events/{eventId}` only, and only with an `If-Match`
 * header. The fixture refuses an unconditional write with 428. Google itself
 * would accept one, so here it would be a bug in the caller. A stale
 * `If-Match` gets 412. Every accepted write gives the event a new ETag.
 */
export function calendarFixture(day = new Date().toISOString().slice(0, 10)) {
  const tomorrow = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000)
    .toISOString()
    .slice(0, 10);
  let version = 0;
  const etag = () => `"v${++version}"`;
  const calendars = [
    {
      id: PRIMARY,
      summary: 'Synthetic',
      primary: true,
      accessRole: 'owner',
      backgroundColor: '#9fe1e7',
    },
    {
      id: TEAM,
      summary: 'Team',
      accessRole: 'reader',
      backgroundColor: '#f691b2',
    },
  ];
  const primary = [
    {
      id: 'all-day',
      summary: 'Calendar all-day fixture',
      status: 'confirmed',
      start: { date: day },
      end: { date: tomorrow },
    },
    {
      id: 'timed',
      summary: 'Calendar timed fixture',
      description: 'Synthetic agenda',
      location: 'Room 4',
      status: 'confirmed',
      start: {
        dateTime: `${day}T09:30:00+02:00`,
        timeZone: 'Europe/Amsterdam',
      },
      end: { dateTime: `${day}T10:30:00+02:00`, timeZone: 'Europe/Amsterdam' },
    },
    {
      id: 'series',
      summary: 'Calendar weekly fixture',
      status: 'confirmed',
      recurrence: ['RRULE:FREQ=WEEKLY'],
      start: {
        dateTime: `${day}T00:30:00+02:00`,
        timeZone: 'Europe/Amsterdam',
      },
      end: { dateTime: `${day}T01:30:00+02:00`, timeZone: 'Europe/Amsterdam' },
    },
    {
      id: 'series_1',
      summary: 'Calendar weekly fixture',
      status: 'confirmed',
      start: {
        dateTime: `${day}T00:30:00+02:00`,
        timeZone: 'Europe/Amsterdam',
      },
      end: { dateTime: `${day}T01:30:00+02:00`, timeZone: 'Europe/Amsterdam' },
      recurringEventId: 'series',
      originalStartTime: { dateTime: `${day}T00:30:00+02:00` },
      attendees: [
        { email: 'synthetic@example.com', responseStatus: 'accepted' },
      ],
    },
    { id: 'gone', status: 'cancelled' },
  ];
  const team = [
    {
      id: 'standup',
      summary: 'Team standup',
      status: 'confirmed',
      start: { dateTime: `${day}T11:00:00+02:00` },
      end: { dateTime: `${day}T11:15:00+02:00` },
    },
  ];
  const byCalendar = new Map([
    [PRIMARY, primary],
    [TEAM, team],
  ]);
  for (const list of byCalendar.values())
    for (const event of list) event.etag = etag();
  const requests = [];
  const writes = [];
  const listOf = id => byCalendar.get(id === 'primary' ? PRIMARY : id);
  const find = (calendarId, eventId) =>
    listOf(calendarId)?.find(e => e.id === eventId);

  const listEvents = (list, url) => {
    // Both modes must request cancellation tombstones. Retained masters need
    // every exception, so applying date bounds in that mode is a data-loss bug.
    const series = url.searchParams.get('singleEvents') === 'false';
    if (
      url.searchParams.get('showDeleted') !== 'true' ||
      (series
        ? url.searchParams.has('timeMin') || url.searchParams.has('timeMax')
        : !url.searchParams.has('timeMin') ||
          !url.searchParams.has('timeMax') ||
          url.searchParams.get('singleEvents') !== 'true')
    )
      return { status: 400, body: { error: 'Invalid recurrence query' } };
    const token = url.searchParams.get('pageToken');
    const offset = token === null ? 0 : Number(token);
    if (
      token !== null &&
      (!Number.isInteger(offset) || offset <= 0 || offset >= list.length)
    )
      return { status: 400, body: { error: 'Invalid pageToken' } };
    const next = offset + PAGE;

    return {
      status: 200,
      body: structuredClone({
        items: list.slice(offset, next),
        ...(next < list.length ? { nextPageToken: String(next) } : {}),
      }),
    };
  };

  const patch = (event, body, headers, url) => {
    const ifMatch = headers['if-match'];
    if (!ifMatch)
      return { status: 428, body: { error: 'Fixture writes need If-Match' } };
    if (ifMatch !== event.etag)
      return { status: 412, body: { error: 'Precondition Failed' } };
    const sendUpdates = url.searchParams.get('sendUpdates');
    if (sendUpdates && !['all', 'externalOnly', 'none'].includes(sendUpdates))
      return { status: 400, body: { error: 'Invalid sendUpdates' } };
    if (
      !body ||
      typeof body !== 'object' ||
      !Object.keys(body).length ||
      Object.keys(body).some(key => !patchable.includes(key))
    )
      return { status: 400, body: { error: 'Unsupported patch field' } };
    Object.assign(event, structuredClone(body), { etag: etag() });
    writes.push({ id: event.id, patch: structuredClone(body), ifMatch });

    return {
      status: 200,
      body: structuredClone(event),
      headers: { ETag: event.etag },
    };
  };

  return {
    /** The primary calendar's events; the array is live. */
    events: primary,
    calendars,
    requests,
    /** Accepted PATCHes, in order. */
    writes,
    /** Test driver: an edit made in Google, outside the app under test. */
    editRemote(eventId, fields, calendarId = PRIMARY) {
      const event = find(calendarId, eventId);
      if (!event) throw new Error(`No fixture event ${eventId}`);
      Object.assign(event, structuredClone(fields), { etag: etag() });

      return structuredClone(event);
    },
    /** Test driver: accepted writes and the primary calendar, as JSON. */
    state() {
      return structuredClone({ writes, events: primary });
    },
    /** Test driver: the event is cancelled in Google; a tombstone remains. */
    cancel(eventId, calendarId = PRIMARY) {
      const event = find(calendarId, eventId);
      if (!event) throw new Error(`No fixture event ${eventId}`);
      event.status = 'cancelled';
      event.etag = etag();
    },
    /** `headers` are the request's, with lower-cased names. */
    request(method, url, body = {}, headers = {}) {
      requests.push({
        method,
        path: url.pathname,
        query: Object.fromEntries(url.searchParams),
        ...(headers['if-match'] ? { ifMatch: headers['if-match'] } : {}),
      });
      const path = url.pathname.replace(
        /^\/proxy\/google-calendar\/calendar\/v3(?=\/)/,
        '',
      );
      if (path === url.pathname) return { status: 404, body: {} };

      if (path === '/users/me/calendarList') {
        if (method !== 'GET') return { status: 405, body: {} };

        return { status: 200, body: structuredClone({ items: calendars }) };
      }

      const match = path.match(/^\/calendars\/([^/]+)\/events(?:\/([^/]+))?$/);
      if (!match) return { status: 404, body: {} };
      const list = listOf(decodeURIComponent(match[1]));
      if (!list) return { status: 404, body: { error: 'Not Found' } };

      if (!match[2]) {
        if (method !== 'GET') return { status: 405, body: {} };

        return listEvents(list, url);
      }

      const event = list.find(e => e.id === decodeURIComponent(match[2]));
      if (!event) return { status: 404, body: { error: 'Not Found' } };
      if (method === 'GET')
        return {
          status: 200,
          body: structuredClone(event),
          headers: { ETag: event.etag },
        };
      if (method === 'PATCH') return patch(event, body, headers, url);

      return { status: 405, body: {} };
    },
  };
}

export default {
  title: 'Google Calendar',
  document: calendarDocument,
  jsonBody: true,
  // Callable from an e2e spec as POST /fixture/google-calendar/<name>.
  drivers: ['editRemote', 'cancel', 'state'],
  create: () => calendarFixture(),
};
