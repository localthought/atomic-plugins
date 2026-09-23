/**
 * Todoist fixture: replays the recorded, redacted API v1 pages in api/ and
 * the recorded catalog document in document.yaml. Both are written by
 * record.mjs; nothing here is hand-written data.
 *
 * Served, read-only like the real proxy's `data:read` catalog:
 *   GET /proxy/todoist/api/v1/projects[?cursor=page-<n>]
 *   GET /proxy/todoist/api/v1/tasks[?cursor=page-<n>]
 *   GET /proxy/todoist/api/v1/projects/<id>, /tasks/<id>
 *       — the matching row from the recorded pages, else 404.
 * Any other method is 403 (the real catalog allows GET only); any other path
 * 404. `limit` is ignored: pages are replayed at the recorded size. The
 * `project_id` filter on /tasks is applied to the recorded rows and returned
 * as one page — derived, not separately recorded.
 *
 * Lives in the issue-tracker plugin folder, whose lane names todoist. Not
 * registered in integrations/localthought/fixtures/index.mjs until api/ has
 * been recorded; see record.mjs for the command and the registration step.
 */
import { existsSync, readFileSync } from 'node:fs';

const api = new URL('./api/', import.meta.url);
const COLLECTIONS = ['projects', 'tasks'];

export const recorded = () => existsSync(new URL('meta.json', api));

function load(collection) {
  const pages = [];

  for (let n = 1; ; n++) {
    const file = new URL(`GET__api__v1__${collection}__page-${n}.json`, api);
    if (!existsSync(file)) break;
    pages.push(JSON.parse(readFileSync(file, 'utf8')));
  }

  return pages;
}

export function todoistFixture() {
  if (!recorded())
    throw new Error(
      'todoist fixture has no recording; run fixtures/todoist/record.mjs',
    );
  const pages = Object.fromEntries(COLLECTIONS.map(c => [c, load(c)]));
  const rows = c => pages[c].flatMap(page => page.body.results);

  return {
    pages,
    request(method, url) {
      const match = url.pathname.match(
        /^\/proxy\/todoist\/api\/v1\/(projects|tasks)(?:\/([^/]+))?$/,
      );
      if (!match) return { status: 404, body: {} };
      if (method !== 'GET') return { status: 403, body: {} };
      const [, collection, id] = match;

      if (id) {
        const row = rows(collection).find(r => r.id === id);

        return row
          ? { status: 200, body: structuredClone(row) }
          : { status: 404, body: {} };
      }

      const projectId = url.searchParams.get('project_id');
      if (collection === 'tasks' && projectId)
        return {
          status: 200,
          body: {
            results: rows('tasks').filter(t => t.project_id === projectId),
            next_cursor: null,
          },
        };

      const cursor = url.searchParams.get('cursor');
      const n = cursor ? Number(/^page-(\d+)$/.exec(cursor)?.[1]) : 1;
      const page = pages[collection][n - 1];
      if (!page) return { status: 400, body: { error: 'Invalid cursor' } };

      return {
        status: page.status,
        body: structuredClone(page.body),
        headers: page.headers,
      };
    },
  };
}

export default {
  title: 'Todoist',
  // Served verbatim with a YAML content type, as the real proxy does.
  documentFile: new URL('./document.yaml', import.meta.url),
  create: todoistFixture,
};
