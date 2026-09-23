/**
 * Records the todoist mock-proxy fixture from live sources. Never hand-edit
 * what it writes; re-run it instead (PARALLEL_LANES.md §4: "realistic" is
 * enforced by recording, not asserted).
 *
 * Writes, next to this file:
 *   document.yaml   the catalog document the real integration-proxy serves at
 *                   /catalog/todoist.yaml. Public; needs no token.
 *   api/GET__api__v1__projects__page-<n>.json
 *   api/GET__api__v1__tasks__page-<n>.json
 *                   { status, headers, body } per page of Todoist API v1,
 *                   body redacted per REDACTIONS below.
 *   api/meta.json   when and how the recording was made, and every field the
 *                   redactor did not recognise (redacted to "redacted").
 *
 * Commands, from the repo root:
 *
 *   # catalog document only (no credentials):
 *   node integrations/issue-tracker/fixtures/todoist/record.mjs --document-only
 *
 *   # document and API bodies, against a dedicated test account:
 *   TODOIST_TOKEN=<personal API token> \
 *     node integrations/issue-tracker/fixtures/todoist/record.mjs
 *
 * TODOIST_TOKEN is a Todoist personal API token (Settings > Integrations >
 * Developer). It is sent only to https://api.todoist.com as a Bearer header
 * and is never written to disk. Only GET requests are made, and only on the
 * two collections the proxy's read-only catalog allows (/projects, /tasks).
 *
 * Options (all optional):
 *   --proxy <url>      real integration-proxy to take document.yaml from
 *                      (default https://localthought.io)
 *   --limit <n>        page size sent as `limit` (default 3)
 *   --max-pages <n>    stop after this many pages per collection (default 3)
 *
 * Use an account with at least limit+1 active tasks, so the recording has a
 * second page (next_cursor) to exercise pagination; the script warns if not.
 * For todoist.ts coverage, include a task with `due.date`, one with
 * `due.datetime`, one with no due date, and several priorities.
 *
 * After recording, register the fixture in the shared registry,
 * integrations/localthought/fixtures/index.mjs, which imports each plugin's
 * fixture by relative path, sorted by that path:
 *   import todoist from '../../issue-tracker/fixtures/todoist/scenario.mjs';
 * (right after the github-issues import), and add `todoist,` to `fixtures`.
 * Whether atomic-server's dagger e2e resolves these cross-folder imports is
 * tracked in ontola/atomic-server#1639.
 * integrations/localthought/mock-proxy.test.mjs uses todoist as its example
 * of a platform with no fixture (`platforms: 'pets,todoist,pets'`) and lists
 * every served platform, so change it in the same commit. Then run
 * integrations/issue-tracker/todoist-fixture.test.ts (its header has the
 * command) and `node --test integrations/localthought/mock-proxy.test.mjs`.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';

const API = 'https://api.todoist.com/api/v1';

/**
 * The redaction list. Every string in a recorded body is either kept
 * verbatim because its field is in KEEP, mapped to a stable fake,
 * or replaced. Numbers, booleans and null are kept (priority, child_order,
 * is_* flags). A string field listed nowhere is replaced with "redacted" and
 * reported in api/meta.json, so an API change fails closed.
 */
export const REDACTIONS = [
  {
    field: 'id, *_id, *_uid, v2_id, v2_*_id (any string)',
    replace: '<kind>-<n>, e.g. task-1, project-2, user-1',
    reason:
      'Account-identifying. Mapped consistently across all files, so ' +
      'task.project_id still points at a recorded project.',
  },
  {
    field: 'task.content',
    replace: 'Redacted task <n>',
    reason: 'User-written text. Kept non-empty: todoist.ts names rows by it.',
  },
  {
    field: 'project.name',
    replace: 'Redacted project <n>; "Inbox" when inbox_project is true',
    reason: 'User-written text.',
  },
  {
    field: 'description (task and project)',
    replace: '"" when empty, otherwise "Redacted description"',
    reason: 'User-written text.',
  },
  {
    field: 'labels[]',
    replace: 'label-<n>',
    reason: 'User-chosen names.',
  },
  {
    field: 'due.string, deadline.string',
    replace: 'redacted',
    reason:
      'The natural-language date the user typed. due.date and due.datetime, ' +
      'which todoist.ts reads, are kept.',
  },
  {
    field: 'url',
    replace: 'https://app.todoist.com/app/<kind>/<fake id>',
    reason: 'Embeds the real id.',
  },
  {
    field: 'next_cursor',
    replace: 'page-<n+1>, or null on the last page',
    reason: 'Opaque server state; the mock only needs a stable token.',
  },
  {
    field: 'any other string field',
    replace: 'redacted (reported in api/meta.json)',
    reason: 'Fail closed on fields this list does not know about.',
  },
];

/** String fields kept verbatim: timestamps, dates and enum-like values. */
const KEEP = new Set([
  'added_at',
  'updated_at',
  'completed_at',
  'created_at',
  'color',
  'view_style',
  'role',
  'due.date',
  'due.datetime',
  'due.timezone',
  'due.lang',
  'deadline.date',
  'deadline.lang',
  'duration.unit',
]);

const ID = /(^id$|_id$|_uid$|^v2_id$)/;
const ID_KIND = {
  project_id: 'project',
  v2_project_id: 'project',
  section_id: 'section',
  v2_section_id: 'section',
  workspace_id: 'workspace',
  folder_id: 'folder',
};

export function redactor() {
  const ids = new Map();
  const counters = {};
  const unknown = new Set();
  const next = kind => (counters[kind] = (counters[kind] ?? 0) + 1);

  const fake = (kind, raw) => {
    const key = `${kind}:${raw}`;
    if (!ids.has(key)) ids.set(key, `${kind}-${next(`id:${kind}`)}`);

    return ids.get(key);
  };

  const idKind = (field, resource) => {
    if (field === 'id' || field === 'v2_id') return resource;
    if (field === 'parent_id' || field === 'v2_parent_id') return resource;
    if (ID_KIND[field]) return ID_KIND[field];
    if (field.endsWith('_uid') || field === 'user_id') return 'user';

    return 'id';
  };

  const value = (v, path, resource, row) => {
    const field = path.split('.').pop();
    if (v === null || typeof v === 'number' || typeof v === 'boolean') return v;
    if (Array.isArray(v))
      return field === 'labels'
        ? v.map(label => fake('label', label))
        : v.map(item => value(item, path, resource, row));
    if (typeof v === 'object')
      return Object.fromEntries(
        Object.entries(v).map(([k, inner]) => [
          k,
          value(inner, `${path}.${k}`, resource, row),
        ]),
      );
    if (KEEP.has(path)) return v;
    if (!path.includes('.') && ID.test(field))
      return fake(idKind(field, resource), v);
    if (path === 'content' && resource === 'task')
      return `Redacted task ${next('content')}`;
    if (path === 'name' && resource === 'project')
      return row.inbox_project === true
        ? 'Inbox'
        : `Redacted project ${next('name')}`;
    if (path === 'description') return v === '' ? '' : 'Redacted description';
    if (path === 'due.string' || path === 'deadline.string') return 'redacted';
    if (path === 'url')
      return `https://app.todoist.com/app/${resource}/${fake(resource, row.id)}`;
    unknown.add(`${resource}.${path}`);

    return 'redacted';
  };

  return {
    row: (resource, row) =>
      Object.fromEntries(
        Object.entries(row).map(([k, v]) => [k, value(v, k, resource, row)]),
      ),
    unknown: () => [...unknown].sort(),
  };
}

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);

  return i === -1 ? fallback : process.argv[i + 1];
};

async function recordDocument(dir, proxy) {
  const res = await fetch(new URL('/catalog/todoist.yaml', proxy));
  if (!res.ok)
    throw new Error(`${proxy}/catalog/todoist.yaml returned ${res.status}`);
  writeFileSync(new URL('document.yaml', dir), await res.text());
}

async function recordCollection({
  dir,
  token,
  redact,
  resource,
  path,
  limit,
  maxPages,
}) {
  let cursor;
  let page = 1;

  for (; page <= maxPages; page++) {
    const url = new URL(`${API}${path}`);
    url.searchParams.set('limit', String(limit));
    if (cursor) url.searchParams.set('cursor', cursor);
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (res.status !== 200)
      throw new Error(`GET ${url.pathname} returned ${res.status}`);
    const body = await res.json();
    if (!Array.isArray(body?.results))
      throw new Error(`GET ${url.pathname}: no results array`);
    cursor = body.next_cursor ?? null;
    const last = !cursor || page === maxPages;
    const file = `GET__api__v1__${path.slice(1)}__page-${page}.json`;
    writeFileSync(
      new URL(`api/${file}`, dir),
      `${JSON.stringify(
        {
          status: 200,
          headers: {},
          body: {
            results: body.results.map(row => redact.row(resource, row)),
            next_cursor: last ? null : `page-${page + 1}`,
          },
        },
        null,
        2,
      )}\n`,
    );
    if (last) break;
  }

  if (page === 1)
    console.warn(
      `record: ${path} fit on one page at limit=${limit}; its cursor paging is not exercised.`,
    );

  return page;
}

/**
 * Formats what was written with the repo's oxfmt, so CI's `oxfmt --check
 * integrations` passes. Only whitespace and YAML list indentation change;
 * the parsed content is what the source returned (after redaction).
 */
function format(dir) {
  const root = new URL('../../../../', dir);
  const bin = new URL('browser/node_modules/.bin/oxfmt', root);

  if (!existsSync(bin)) {
    console.warn(
      'record: browser/node_modules/.bin/oxfmt not found (see AGENTS.md for the atomic-server layout); format before committing.',
    );

    return;
  }

  const result = spawnSync(
    fileURLToPath(bin),
    [
      '-c',
      fileURLToPath(new URL('browser/.oxfmtrc.json', root)),
      fileURLToPath(dir),
    ],
    { stdio: 'inherit' },
  );
  if (result.status !== 0) throw new Error('oxfmt failed');
}

async function main() {
  const dir = new URL('./', import.meta.url);
  const proxy = arg('proxy', 'https://localthought.io');
  await recordDocument(dir, proxy);
  console.info(`record: wrote document.yaml from ${proxy}`);
  if (process.argv.includes('--document-only')) return format(dir);

  const token = process.env.TODOIST_TOKEN;
  if (!token)
    throw new Error('TODOIST_TOKEN must be set (or pass --document-only)');
  const limit = Number(arg('limit', '3'));
  const maxPages = Number(arg('max-pages', '3'));
  const api = new URL('api/', dir);
  rmSync(api, { recursive: true, force: true });
  mkdirSync(api);
  const redact = redactor();
  // Projects first, so project ids are numbered before tasks refer to them.
  const pages = {};
  for (const [resource, path] of [
    ['project', '/projects'],
    ['task', '/tasks'],
  ])
    pages[path] = await recordCollection({
      dir,
      token,
      redact,
      resource,
      path,
      limit,
      maxPages,
    });

  writeFileSync(
    new URL('meta.json', api),
    `${JSON.stringify(
      {
        recorded_at: new Date().toISOString().slice(0, 10),
        source: API,
        document_source: `${proxy}/catalog/todoist.yaml`,
        limit,
        pages,
        unrecognised_fields_redacted: redact.unknown(),
      },
      null,
      2,
    )}\n`,
  );
  const unknown = redact.unknown();
  if (unknown.length)
    console.warn(
      `record: redacted unrecognised fields ${unknown.join(', ')}; review, and add safe ones to KEEP.`,
    );
  console.info(`record: wrote ${readdirSync(api).length} files to api/`);
  format(dir);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch(error => {
    console.error(`record: ${error.message}`);
    process.exit(1);
  });
