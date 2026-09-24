// @wc-ignore-file
import { describe, expect, it } from 'vitest';
import { Datatype } from '../../browser/lib/src/index';
import { platformSchema, type FetchedPlatform } from '../localthought/schema';
import {
  absentTodoistTasks,
  reconcileTodoistTasks,
  todoistFields as fields,
  todoistProjection,
  type TodoistLookup,
} from './todoist';

const term = (
  shortname: string,
  kind: 'class' | 'property',
  datatype = Datatype.STRING,
  recommends: string[] = [],
) => ({
  path: shortname,
  kind,
  shortname,
  description: '',
  datatype,
  requires: [],
  recommends,
});

const fixture = (): FetchedPlatform => ({
  platform: 'todoist',
  ontology: {
    description: '',
    terms: [
      term('task', 'class', Datatype.STRING, [
        'content',
        'checked',
        'due',
        'priority',
      ]),
      term('project', 'class', Datatype.STRING, ['name']),
      term('content', 'property'),
      term('checked', 'property', Datatype.BOOLEAN),
      term('due', 'property', Datatype.JSON),
      term('priority', 'property', Datatype.INTEGER),
      term('name', 'property'),
    ],
  },
  records: [
    {
      resource: 'task',
      namespace: 'todoist',
      id: '100',
      name: '100',
      values: {
        content: 'Buy milk',
        checked: false,
        due: { date: '2026-09-20', is_recurring: false, string: 'Sep 20' },
        priority: 4,
      },
    },
    {
      resource: 'task',
      namespace: 'todoist',
      id: '101',
      name: '101',
      values: {
        content: 'Call the dentist',
        checked: true,
        due: { datetime: '2026-09-18T09:00:00Z' },
        priority: 1,
      },
    },
    {
      resource: 'task',
      namespace: 'todoist',
      id: '102',
      name: '102',
      values: { content: '   ' },
    },
    {
      resource: 'project',
      namespace: 'todoist',
      id: '7',
      name: 'Inbox',
      values: { name: 'Inbox' },
    },
  ],
});

it('names tasks after their content and adds done, due day and priority', () => {
  const projected = todoistProjection(fixture());
  const [milk, dentist, blank, project] = projected.records;

  expect(milk.name).toBe('Buy milk');
  expect(milk.values[fields.done]).toBe(false);
  expect(milk.values[fields.dueDay]).toBe('2026-09-20');
  expect(milk.values[fields.priorityLabel]).toBe('Urgent');
  // Provider fields stay on the row.
  expect(milk.values.content).toBe('Buy milk');

  expect(dentist.name).toBe('Call the dentist');
  expect(dentist.values[fields.done]).toBe(true);
  expect(dentist.values[fields.dueDay]).toBe('2026-09-18');
  expect(dentist.values[fields.priorityLabel]).toBe('Normal');

  // Blank content keeps the id as a name rather than an empty title.
  expect(blank.name).toBe('102');
  expect(blank.values[fields.done]).toBe(false);
  expect(blank.values).not.toHaveProperty(fields.dueDay);

  expect(project).toEqual(fixture().records[3]);
});

it('adds the projected properties to the task class and the shared schema', () => {
  const projected = todoistProjection(fixture());
  const task = projected.ontology.terms.find(t => t.shortname === 'task')!;

  for (const shortname of Object.values(fields)) {
    const extra = projected.ontology.terms.find(t => t.shortname === shortname);
    expect(extra?.kind).toBe('property');
    expect(task.recommends).toContain(extra!.path);
  }

  const schema = platformSchema('todoist', projected.ontology.terms);
  const done = schema.properties.find(p =>
    p.shortname.endsWith(`-${fields.done}`),
  );
  expect(done?.datatype).toBe(Datatype.BOOLEAN);
  const dueDay = schema.properties.find(p =>
    p.shortname.endsWith(`-${fields.dueDay}`),
  );
  expect(dueDay?.datatype).toBe(Datatype.DATE);
});

it('leaves other platforms and platforms without a task class alone', () => {
  const other = { ...fixture(), platform: 'clockify' };
  expect(todoistProjection(other)).toBe(other);

  const noTask = fixture();
  noTask.ontology.terms = noTask.ontology.terms.filter(
    t => t.shortname !== 'task',
  );
  expect(todoistProjection(noTask)).toBe(noTask);
});

it('refuses a provider ontology that already claims a projected shortname', () => {
  const clash = fixture();
  clash.ontology.terms.push(term(fields.done, 'property', Datatype.BOOLEAN));
  expect(() => todoistProjection(clash)).toThrow(/collides/);
});

describe('tasks that stop appearing (#99)', () => {
  // Synthetic reads, shaped as the proxy's read-only catalog returns them:
  // `/tasks` lists active tasks only; `GET /tasks/{id}` is the one check.
  // #46 owns the recorded fixture; these cases do not need a recording.
  const task = (id: string, content: string, extra: object = {}) => ({
    resource: 'task',
    namespace: 'todoist',
    id,
    name: id,
    values: { id, content, checked: false, priority: 1, ...extra },
  });
  const read = (
    tasks: ReturnType<typeof task>[],
    errors?: string[],
  ): FetchedPlatform => ({
    ...fixture(),
    records: [...tasks, fixture().records[3]],
    ...(errors ? { errors } : {}),
  });
  const MONDAY = '2026-09-21T08:00:00.000Z';
  const TUESDAY = '2026-09-22T08:00:00.000Z';

  /** First import, then a second read with `tasks`, optional lookups. */
  const second = (
    tasks: ReturnType<typeof task>[],
    {
      errors,
      lookups = () => [],
    }: {
      errors?: string[];
      lookups?: (ids: string[]) => TodoistLookup[];
    } = {},
  ) => {
    const first = reconcileTodoistTasks({
      previous: [],
      fetched: read([task('1', 'Buy milk'), task('2', 'Call the dentist')]),
      seenAt: MONDAY,
    });
    const previous = first.platform.records;
    const fetched = read(tasks, errors);
    const ids = absentTodoistTasks(previous, fetched);

    return {
      ids,
      ...reconcileTodoistTasks({
        previous,
        fetched,
        lookups: lookups(ids),
        seenAt: TUESDAY,
      }),
    };
  };

  const byId = (records: FetchedPlatform['records'], id: string) =>
    records.find(r => r.resource === 'task' && r.id === id)!;

  it('marks every task of a first import active and seen', () => {
    const { platform, summary } = reconcileTodoistTasks({
      previous: [],
      fetched: read([task('1', 'Buy milk')]),
      seenAt: MONDAY,
    });
    expect(byId(platform.records, '1').values).toMatchObject({
      [fields.presence]: 'active',
      [fields.lastSeen]: MONDAY,
      [fields.done]: false,
    });
    expect(summary).toMatchObject({ active: 1, complete: true, reappeared: 0 });
  });

  it('active -> completed only when Todoist says checked', () => {
    const { ids, platform, summary } = second([task('1', 'Buy milk')], {
      lookups: absent =>
        absent.map(id => ({
          id,
          status: 200,
          body: { id, content: 'Call the dentist (done)', checked: true },
        })),
    });
    expect(ids).toEqual(['2']);
    expect(byId(platform.records, '2').values).toMatchObject({
      [fields.presence]: 'completed',
      [fields.done]: true,
      [fields.lastSeen]: TUESDAY,
      content: 'Call the dentist (done)',
    });
    expect(byId(platform.records, '2').name).toBe('Call the dentist (done)');
    expect(summary).toMatchObject({ active: 1, completed: 1 });
  });

  it('active -> absent with a 404 is unavailable, never completed', () => {
    const { platform, summary } = second([task('1', 'Buy milk')], {
      lookups: absent => absent.map(id => ({ id, status: 404, body: {} })),
    });
    expect(byId(platform.records, '2').values).toMatchObject({
      [fields.presence]: 'unavailable',
      [fields.done]: false,
      // Last seen on Monday: that is how old these values are.
      [fields.lastSeen]: MONDAY,
      content: 'Call the dentist',
    });
    expect(summary).toMatchObject({ unavailable: 1, completed: 0 });
  });

  it('a task Todoist reports deleted is deleted, not completed', () => {
    const { platform } = second([task('1', 'Buy milk')], {
      lookups: absent =>
        absent.map(id => ({
          id,
          status: 200,
          body: { id, content: 'x', checked: true, is_deleted: true },
        })),
    });
    expect(byId(platform.records, '2').values).toMatchObject({
      [fields.presence]: 'deleted',
      [fields.done]: false,
      [fields.lastSeen]: MONDAY,
    });
  });

  it('a failed or missing check leaves the last known values, unconfirmed', () => {
    for (const lookups of [
      () => [],
      (ids: string[]) => ids.map(id => ({ id, error: 'Proxy request failed' })),
      (ids: string[]) => ids.map(id => ({ id, status: 403, body: {} })),
      (ids: string[]) => ids.map(id => ({ id, status: 502, body: {} })),
      (ids: string[]) =>
        ids.map(id => ({ id, status: 200, body: { id: 'other' } })),
    ]) {
      const { platform, summary } = second([task('1', 'Buy milk')], {
        lookups,
      });
      expect(byId(platform.records, '2').values).toMatchObject({
        [fields.presence]: 'unconfirmed',
        [fields.done]: false,
        [fields.lastSeen]: MONDAY,
        content: 'Call the dentist',
      });
      expect(summary.unconfirmed).toBe(1);
    }
  });

  it('infers nothing from a partial read, e.g. a pagination cap', () => {
    const { ids, platform, summary } = second([task('1', 'Buy milk')], {
      errors: ['tasks: Read exceeds 5000 records; narrow its scope'],
      // Even a 404 someone did look up is not used after a partial read.
      lookups: () => [{ id: '2', status: 404, body: {} }],
    });
    expect(ids).toEqual([]);
    expect(byId(platform.records, '2').values).toMatchObject({
      [fields.presence]: 'active',
      [fields.lastSeen]: MONDAY,
      [fields.done]: false,
    });
    expect(summary).toMatchObject({ complete: false, active: 2 });
  });

  it('a task that comes back is active again, whatever it was', () => {
    for (const status of [404, 200]) {
      const gone = second([task('1', 'Buy milk')], {
        lookups: absent =>
          absent.map(id => ({
            id,
            status,
            body: { id, content: 'Call the dentist', checked: true },
          })),
      });
      const back = reconcileTodoistTasks({
        previous: gone.platform.records,
        fetched: read([task('1', 'Buy milk'), task('2', 'Call the dentist')]),
        seenAt: '2026-09-23T08:00:00.000Z',
      });
      expect(byId(back.platform.records, '2').values).toMatchObject({
        [fields.presence]: 'active',
        [fields.done]: false,
        [fields.lastSeen]: '2026-09-23T08:00:00.000Z',
      });
      expect(back.summary.reappeared).toBe(1);
    }
  });

  it('does not look up settled tasks again, and never drops a row', () => {
    const gone = second([task('1', 'Buy milk')], {
      lookups: absent => absent.map(id => ({ id, status: 404, body: {} })),
    });
    const later = read([task('1', 'Buy milk')]);
    expect(absentTodoistTasks(gone.platform.records, later)).toEqual([]);
    const again = reconcileTodoistTasks({
      previous: gone.platform.records,
      fetched: later,
      seenAt: '2026-09-23T08:00:00.000Z',
    });
    expect(
      again.platform.records.filter(r => r.resource === 'task'),
    ).toHaveLength(2);
    expect(byId(again.platform.records, '2').values[fields.presence]).toBe(
      'unavailable',
    );
  });

  it('takes the read time as an exact ISO string', () => {
    expect(() =>
      reconcileTodoistTasks({ previous: [], fetched: read([]), seenAt: 'now' }),
    ).toThrow(/ISO 8601/);
  });
});
