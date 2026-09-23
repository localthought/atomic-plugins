// @wc-ignore-file
/**
 * Checks the recorded todoist mock-proxy fixture (fixtures/todoist/) against
 * the adapter that consumes it, ./todoist.ts. Per PARALLEL_LANES.md §4 a
 * recording that drops a field the adapter reads must fail here, not in e2e.
 *
 * The api/-dependent tests skip until fixtures/todoist/record.mjs has been
 * run against a live account (see its header for the command). Run with the
 * AGENTS.md atomic-server layout:
 *
 *   browser/node_modules/.bin/vitest run \
 *     --config integrations/issue-tracker/vitest.config.ts todoist-fixture
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Datatype } from '../../browser/lib/src/index';
import type { JSONValue } from '../../browser/lib/src/value';
import { fixtures } from '../localthought/fixtures/index.mjs';
import { redactor } from './fixtures/todoist/record.mjs';
import scenario, { recorded } from './fixtures/todoist/scenario.mjs';
import type { FetchedPlatform, FetchedRecord } from '../localthought/schema';
import { todoistFields as fields, todoistProjection } from './todoist';

type Row = Record<string, JSONValue>;
type Page = {
  status: number;
  body: { results: Row[]; next_cursor: string | null };
};
const isRecorded: boolean = recorded();
const DAY = /^\d{4}-\d{2}-\d{2}/;

describe('todoist fixture: always-on checks', () => {
  it('has the catalog document recorded from the real proxy', () => {
    const document = readFileSync(scenario.documentFile, 'utf8');
    expect(document).toMatch(/- url: https:\/\/api\.todoist\.com\/api\/v1\n/);
    expect(document).toMatch(/^ {2}\/tasks:$/m);
    expect(document).toMatch(/^ {2}\/projects:$/m);
    // Read-only, like the real catalog: no write operations are declared.
    expect(document).not.toMatch(/^ {4}(post|put|patch|delete):$/m);
  });

  it('redacts every string it does not know to be safe, consistently', () => {
    const redact = redactor();
    const project: Row = redact.row('project', {
      id: '2200',
      name: 'Taxes',
      description: 'private',
      creator_uid: '999',
      color: 'red',
      is_favorite: true,
    });
    const task: Row = redact.row('task', {
      id: '6X1',
      project_id: '2200',
      parent_id: null,
      user_id: '999',
      content: 'Call my doctor',
      description: '',
      labels: ['health'],
      checked: false,
      priority: 4,
      due: { date: '2026-09-20', string: 'every friday', is_recurring: true },
      url: 'https://app.todoist.com/app/task/6X1',
      new_field: 'leak',
    });
    const text = JSON.stringify([project, task]);

    for (const secret of [
      '2200',
      'Taxes',
      'private',
      '999',
      '6X1',
      'doctor',
      'health',
      'friday',
      'leak',
    ])
      expect(text).not.toContain(secret);
    expect(task.project_id).toBe(project.id);
    expect(task.user_id).toBe(project.creator_uid);
    expect(task).toMatchObject({
      checked: false,
      priority: 4,
      description: '',
      due: { date: '2026-09-20', is_recurring: true },
    });
    expect(project.color).toBe('red');
    expect(redact.unknown()).toEqual(['task.new_field']);
  });
});

describe.skipIf(!isRecorded)('todoist fixture: recorded api/', () => {
  const pages = isRecorded
    ? scenario.create().pages
    : { projects: [], tasks: [] };
  const rows = (c: 'projects' | 'tasks'): Row[] =>
    (pages[c] as Page[]).flatMap(p => p.body.results);

  it('is registered with the mock proxy', () => {
    expect(fixtures.todoist).toBe(scenario);
  });

  it('records every field todoist.ts reads, with the type it expects', () => {
    const tasks = rows('tasks');
    expect(tasks.length).toBeGreaterThan(0);

    for (const task of tasks) {
      expect(typeof task.content).toBe('string');
      expect(String(task.content).trim()).not.toBe('');
      expect(typeof task.checked).toBe('boolean');
      expect([1, 2, 3, 4]).toContain(task.priority);

      if (task.due !== null) {
        const due = task.due as Record<string, JSONValue>;
        expect(typeof due).toBe('object');
        expect(due.date ?? due.datetime).toMatch(DAY);
      }
    }

    expect(tasks.some(t => t.due !== null)).toBe(true);
  });

  it('keeps ids redacted and project references intact', () => {
    const projectIds = new Set(rows('projects').map(p => p.id));

    for (const p of rows('projects')) expect(p.id).toMatch(/^project-\d+$/);

    for (const t of rows('tasks')) {
      expect(t.id).toMatch(/^task-\d+$/);
      expect(projectIds).toContain(t.project_id);
    }
  });

  it('projects through todoistProjection', () => {
    const term = (
      shortname: string,
      kind: 'class' | 'property',
      datatype = Datatype.STRING,
    ) => ({
      path: shortname,
      kind,
      shortname,
      description: '',
      datatype,
      requires: [],
      recommends: [],
    });
    const record = (resource: string, row: Row): FetchedRecord => ({
      resource,
      namespace: 'todoist',
      id: String(row.id),
      name: String(row.id),
      values: row,
    });
    const fetched: FetchedPlatform = {
      platform: 'todoist',
      ontology: {
        description: '',
        terms: [term('task', 'class'), term('project', 'class')],
      },
      records: [
        ...rows('tasks').map(r => record('task', r)),
        ...rows('projects').map(r => record('project', r)),
      ],
    };
    const projected = todoistProjection(fetched).records.filter(
      r => r.resource === 'task',
    );

    for (const task of projected) {
      expect(task.name).toBe(task.values.content);
      expect(task.values[fields.done]).toBe(task.values.checked);
      expect(typeof task.values[fields.priorityLabel]).toBe('string');
      if (task.values.due !== null)
        expect(task.values[fields.dueDay]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it('replays pages by cursor, reads by id, and refuses writes', () => {
    const api = scenario.create();
    const get = (path: string, method = 'GET') =>
      api.request(method, new URL(`http://mock/proxy/todoist/api/v1${path}`));

    for (const collection of ['projects', 'tasks'] as const) {
      const seen: Row[] = [];
      let res = get(`/${collection}?limit=3`);

      for (;;) {
        expect(res.status).toBe(200);
        seen.push(...res.body.results);
        if (!res.body.next_cursor) break;
        res = get(`/${collection}?cursor=${res.body.next_cursor}`);
      }

      expect(seen).toEqual(rows(collection));
    }

    // At least one collection spans two pages, so cursor paging is exercised.
    expect(pages.projects.length + pages.tasks.length).toBeGreaterThan(2);

    const task = rows('tasks')[0];
    expect(get(`/tasks/${task.id}`).body).toEqual(task);
    expect(get('/tasks/task-0').status).toBe(404);
    expect(get('/tasks', 'POST').status).toBe(403);
    expect(get('/access_tokens').status).toBe(404);
  });
});
