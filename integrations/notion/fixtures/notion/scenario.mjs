/**
 * Synthetic Notion fixture for the mock integration proxy: one shared data
 * source with three pages, read-only. Authored from Notion's documented
 * response shapes (API version 2026-03-11), not recorded from a live
 * workspace; see PARALLEL_LANES.md for the recorder that does not exist yet.
 *
 * What it checks, so a reader that gets these wrong fails here rather than
 * against Notion:
 * - both list operations are POST with a JSON body (`jsonBody`);
 * - the data source query pages two at a time whatever `page_size` asks for,
 *   so the third page is only reachable by sending `next_cursor` back as the
 *   body's `start_cursor`. An unknown cursor is a 400, as in Notion;
 * - search honours `filter.value` (`data_source` or `page`);
 * - every other method is a 403: nothing here accepts a write.
 *
 * `requests` records `{ method, path, body }` for tests.
 */
import { readFileSync } from 'node:fs';

export const DATA_SOURCE = '248104cd-477e-80af-bc30-000bd28de8f9';
const DATABASE = '248104cd-477e-8045-a9b1-e1b1b54c0b9f';
const USER = { object: 'user', id: '6794760a-1f15-45cd-9c65-0dfe42f5135a' };
const STAMP = '2026-09-01T10:00:00.000Z';

const text = (content, annotations = {}) => ({
  type: 'text',
  text: { content, link: null },
  annotations: {
    bold: false,
    italic: false,
    strikethrough: false,
    underline: false,
    code: false,
    color: 'default',
    ...annotations,
  },
  plain_text: content,
  href: null,
});

const option = (id, name, color) => ({ id, name, color });
const TODO = option(
  'b1f5a3c2-0001-4000-8000-000000000001',
  'Not started',
  'default',
);
const DOING = option(
  'b1f5a3c2-0001-4000-8000-000000000002',
  'In progress',
  'blue',
);
const DONE = option('b1f5a3c2-0001-4000-8000-000000000003', 'Done', 'green');
const DOCS = option('c2e6b4d3-0002-4000-8000-000000000001', 'docs', 'purple');
const RELEASE = option(
  'c2e6b4d3-0002-4000-8000-000000000002',
  'release',
  'red',
);

/** Property ids are Notion's short, case-sensitive, percent-encoded ids. */
const schema = {
  Name: { id: 'title', name: 'Name', type: 'title', title: {} },
  Status: {
    id: '%3AUPp',
    name: 'Status',
    type: 'status',
    status: { options: [TODO, DOING, DONE], groups: [] },
  },
  Done: { id: 'BJXS', name: 'Done', type: 'checkbox', checkbox: {} },
  Points: {
    id: 'n%3D1',
    name: 'Points',
    type: 'number',
    number: { format: 'number' },
  },
  Tags: {
    id: 'Tg%5Cq',
    name: 'Tags',
    type: 'multi_select',
    multi_select: { options: [DOCS, RELEASE] },
  },
  Notes: { id: 'Nt0s', name: 'Notes', type: 'rich_text', rich_text: {} },
};

export const dataSource = {
  object: 'data_source',
  id: DATA_SOURCE,
  created_time: STAMP,
  last_edited_time: STAMP,
  created_by: USER,
  last_edited_by: USER,
  title: [text('Roadmap')],
  description: [],
  properties: schema,
  parent: { type: 'database_id', database_id: DATABASE },
  database_parent: { type: 'workspace', workspace: true },
  url: `https://www.notion.so/${DATABASE.replaceAll('-', '')}`,
  archived: false,
  in_trash: false,
};

function page(id, { name, status, done, points, tags, notes }) {
  const value = (key, content) => ({
    id: schema[key].id,
    type: schema[key].type,
    [schema[key].type]: content,
  });

  return {
    object: 'page',
    id,
    created_time: STAMP,
    last_edited_time: STAMP,
    created_by: USER,
    last_edited_by: USER,
    cover: null,
    icon: null,
    parent: {
      type: 'data_source_id',
      data_source_id: DATA_SOURCE,
      database_id: DATABASE,
    },
    archived: false,
    in_trash: false,
    properties: {
      Name: value('Name', [text(name)]),
      Status: value('Status', status),
      Done: value('Done', done),
      Points: value('Points', points),
      Tags: value('Tags', tags),
      Notes: value('Notes', notes),
    },
    url: `https://www.notion.so/${name.replaceAll(' ', '-')}-${id.replaceAll('-', '')}`,
    public_url: null,
  };
}

export const pages = [
  page('1a2b3c4d-0000-4000-8000-000000000001', {
    name: 'Launch plan',
    status: DOING,
    done: false,
    points: 3,
    tags: [RELEASE, DOCS],
    notes: [text('Plain notes')],
  }),
  page('1a2b3c4d-0000-4000-8000-000000000002', {
    name: 'Write changelog',
    status: DONE,
    done: true,
    points: 0,
    tags: [],
    notes: [],
  }),
  page('1a2b3c4d-0000-4000-8000-000000000003', {
    name: 'Retrospective',
    status: TODO,
    done: false,
    points: null,
    tags: [DOCS],
    // Formatted text: the read-only lens leaves this unprojected and says so.
    notes: [text('Keep this '), text('bold', { bold: true })],
  }),
];

/** Page size the fixture serves, whatever the request asks for. */
export const FIXTURE_PAGE_SIZE = 2;

const normalize = id => String(id).replaceAll('-', '').toLowerCase();
const error = (status, code, message) => ({
  status,
  body: { object: 'error', status, code, message },
});
const list = (results, next, type) => ({
  status: 200,
  body: {
    object: 'list',
    results,
    next_cursor: next,
    has_more: next !== null,
    type,
    [type]: {},
  },
});

function paginate(items, body, type) {
  const size = Math.min(Number(body.page_size ?? 100), FIXTURE_PAGE_SIZE);
  if (!Number.isInteger(size) || size < 1)
    return error(400, 'validation_error', 'page_size should be 1 to 100');
  let offset = 0;

  if (body.start_cursor !== undefined) {
    const match = /^cursor-(\d+)$/.exec(String(body.start_cursor));
    if (!match || Number(match[1]) >= items.length)
      return error(400, 'validation_error', 'start_cursor is invalid');
    offset = Number(match[1]);
  }

  const end = offset + size;

  return list(
    items.slice(offset, end),
    end < items.length ? `cursor-${end}` : null,
    type,
  );
}

export function notionFixture() {
  const requests = [];

  return {
    requests,
    request(method, url, body) {
      const path = url.pathname.replace(/^\/proxy\/notion/, '');
      requests.push({ method, path, body });

      if (method === 'POST' && path === '/v1/search') {
        const kind = body?.filter?.value;
        const results =
          kind === 'data_source'
            ? [dataSource]
            : kind === 'page'
              ? pages
              : [dataSource, ...pages];

        return paginate(results, body ?? {}, 'page_or_data_source');
      }

      const query = path.match(/^\/v1\/data_sources\/([^/]+)\/query$/);

      if (method === 'POST' && query) {
        if (normalize(query[1]) !== normalize(DATA_SOURCE))
          return error(404, 'object_not_found', 'Data source not found');

        return paginate(pages, body ?? {}, 'page_or_data_source');
      }

      const source = path.match(/^\/v1\/data_sources\/([^/]+)$/);

      if (method === 'GET' && source)
        return normalize(source[1]) === normalize(DATA_SOURCE)
          ? { status: 200, body: dataSource }
          : error(404, 'object_not_found', 'Data source not found');

      const one = path.match(/^\/v1\/pages\/([^/]+)$/);

      if (method === 'GET' && one) {
        const found = pages.find(p => normalize(p.id) === normalize(one[1]));

        return found
          ? { status: 200, body: found }
          : error(404, 'object_not_found', 'Page not found');
      }

      // Anything else that is not a read: page creation (POST /v1/pages),
      // PATCH, DELETE.
      if (method !== 'GET')
        return error(403, 'restricted_resource', 'This fixture is read-only');

      return error(404, 'invalid_request_url', 'Not in the Notion fixture');
    },
  };
}

export default {
  title: 'Notion',
  // overlays/catalog.json's notion entry as the proxy composes it; see
  // catalog/generate.py.
  document: JSON.parse(
    readFileSync(new URL('../../catalog/notion.json', import.meta.url), 'utf8'),
  ),
  jsonBody: true,
  create: notionFixture,
};
