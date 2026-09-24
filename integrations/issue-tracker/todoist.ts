// @wc-ignore-file
import { Datatype } from '../../browser/lib/src/index.js';
import type { JSONValue } from '../../browser/lib/src/value.js';
import type {
  FetchedPlatform,
  FetchedRecord,
  Term,
} from '../localthought/schema.js';

/**
 * Todoist's task shape, as the integration proxy's read-only catalog exposes
 * it, translated onto what an issue list needs. An additional projection,
 * never a replacement for the provider's fields: `content`, `checked`, `due`
 * and the rest stay on the row, these columns sit beside them.
 *
 * The proxy's Todoist catalog is `data:read` only, so this lens has no
 * write direction: nothing an issue list changes here is sent back.
 */
export const todoistFields = {
  /** Whether Todoist has this task checked off. The issue list's closed flag. */
  done: 'done',
  /** The due day, from `due.date` (or the day of `due.datetime`). */
  dueDay: 'due-day',
  /** Todoist's 1 (normal) to 4 (urgent) priority, as a label. */
  priorityLabel: 'priority-label',
  /**
   * Where the task stands, as far as Todoist has said; see
   * `reconcileTodoistTasks`. One of `TODOIST_PRESENCE`.
   */
  presence: 'presence',
  /**
   * When Todoist last returned the task (in the active list or by id), as
   * the exact ISO 8601 string the caller passed as `seenAt`.
   */
  lastSeen: 'last-seen',
} as const;

/**
 * - `active`: in the last complete read of the active-task list (or returned
 *   by id and not checked).
 * - `completed`: Todoist returned the task with `checked: true`.
 * - `deleted`: Todoist returned the task by id with `is_deleted: true`.
 * - `unavailable`: gone from a complete active list, and `GET /tasks/{id}`
 *   answered 404. Deleted, moved out of reach, or access lost: Todoist does
 *   not say which, so this is never shown as completed.
 * - `unconfirmed`: gone from a complete active list, and the by-id check
 *   failed or was not made. The row keeps its last known values; `last-seen`
 *   says how old they are.
 */
export const TODOIST_PRESENCE = [
  'active',
  'completed',
  'deleted',
  'unavailable',
  'unconfirmed',
] as const;
export type TodoistPresence = (typeof TODOIST_PRESENCE)[number];

export const TODOIST_PLATFORM = 'todoist';

const PRIORITY_LABELS: Record<number, string> = {
  1: 'Normal',
  2: 'Medium',
  3: 'High',
  4: 'Urgent',
};

const DAY = /^\d{4}-\d{2}-\d{2}/;

export function todoistProjection(fetched: FetchedPlatform): FetchedPlatform {
  if (fetched.platform !== TODOIST_PLATFORM) return fetched;
  const task = fetched.ontology.terms.find(
    t => t.kind === 'class' && t.shortname === 'task',
  );
  if (!task) return fetched;
  const definitions: [string, Datatype, string][] = [
    [
      todoistFields.done,
      Datatype.BOOLEAN,
      'Whether the task is completed in Todoist.',
    ],
    [
      todoistFields.dueDay,
      Datatype.DATE,
      "The day the task is due, from Todoist's due date or time.",
    ],
    [
      todoistFields.priorityLabel,
      Datatype.STRING,
      'Todoist priority: Normal, Medium, High or Urgent.',
    ],
    [
      todoistFields.presence,
      Datatype.STRING,
      'Where the task stands in Todoist: active, completed, deleted, unavailable (gone, reason unknown) or unconfirmed (last known values).',
    ],
    [
      todoistFields.lastSeen,
      Datatype.STRING,
      'When Todoist last returned this task, as an ISO 8601 date and time.',
    ],
  ];
  const terms: Term[] = definitions.map(
    ([shortname, datatype, description]) => ({
      path: `urn:atomic:todoist:${shortname}`,
      kind: 'property',
      shortname,
      datatype,
      description,
      requires: [],
      recommends: [],
    }),
  );
  if (
    fetched.ontology.terms.some(t =>
      terms.some(extra => extra.shortname === t.shortname),
    )
  )
    throw new Error(
      'Todoist projection property collides with provider ontology',
    );

  return {
    ...fetched,
    ontology: {
      ...fetched.ontology,
      terms: [
        ...fetched.ontology.terms.map(t =>
          t === task
            ? {
                ...t,
                recommends: [
                  ...t.recommends,
                  ...terms.map(extra => extra.path),
                ],
              }
            : t,
        ),
        ...terms,
      ],
    },
    records: fetched.records.map(projectRecord),
  };
}

function projectRecord(row: FetchedRecord): FetchedRecord {
  if (row.resource !== 'task') return row;
  const values: Record<string, JSONValue> = {
    ...row.values,
    [todoistFields.done]: row.values.checked === true,
    [todoistFields.presence]:
      row.values.checked === true ? 'completed' : 'active',
  };
  const due = object(row.values.due);
  const dueDate = typeof due.date === 'string' ? due.date : due.datetime;
  if (typeof dueDate === 'string' && DAY.test(dueDate))
    values[todoistFields.dueDay] = dueDate.slice(0, 10);
  const label =
    typeof row.values.priority === 'number'
      ? PRIORITY_LABELS[row.values.priority]
      : undefined;
  if (label) values[todoistFields.priorityLabel] = label;

  // Syncables names a record after `title`, `summary` or `name`; a Todoist
  // task has none of those, its text is `content`. Without this the issue list
  // would show every task as its id.
  const content =
    typeof row.values.content === 'string' ? row.values.content.trim() : '';

  return { ...row, name: content || row.name, values };
}

function object(value: JSONValue | undefined): Record<string, JSONValue> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value
    : {};
}

/** Todoist's answer to `GET /tasks/{id}` for one task, or why there is none. */
export type TodoistLookup =
  | { id: string; status: number; body?: JSONValue }
  | { id: string; error: string };

export interface TodoistReconcileResult {
  /** `fetched`, projected, plus a record for every previous task it lacks. */
  platform: FetchedPlatform;
  summary: Record<TodoistPresence, number> & {
    /** Tasks back in the active list after being absent or settled. */
    reappeared: number;
    /** Whether the active-task read was complete (no `errors`). */
    complete: boolean;
  };
}

/** Presences that stay until the task shows up in the active list again. */
const SETTLED: TodoistPresence[] = ['completed', 'deleted', 'unavailable'];

const presenceOf = (row: FetchedRecord): TodoistPresence => {
  const value = row.values[todoistFields.presence];

  return TODOIST_PRESENCE.includes(value as TodoistPresence)
    ? (value as TodoistPresence)
    : // Rows imported before `presence` existed came from the active list.
      'active';
};

const isComplete = (fetched: FetchedPlatform) => !fetched.errors?.length;

/**
 * The previous tasks to check by id (`GET /tasks/{id}`, which the proxy's
 * read-only catalog allows) before calling `reconcileTodoistTasks`: those
 * that were active or unconfirmed and are missing from this read. None when
 * the read was partial, because then absence says nothing.
 */
export function absentTodoistTasks(
  previous: FetchedRecord[],
  fetched: FetchedPlatform,
): string[] {
  if (fetched.platform !== TODOIST_PLATFORM || !isComplete(fetched)) return [];
  const present = new Set(
    fetched.records.filter(r => r.resource === 'task').map(r => r.id),
  );

  return previous
    .filter(
      r =>
        r.resource === 'task' &&
        !present.has(r.id) &&
        !SETTLED.includes(presenceOf(r)),
    )
    .map(r => r.id);
}

/**
 * What happens to a task that stops appearing (#99). Todoist's `/tasks`
 * lists active tasks only, so absence alone is never read as completion:
 *
 * - A partial or failed read (`fetched.errors`) changes no previous task:
 *   each keeps its values, presence and `last-seen`.
 * - After a complete read, a previous task missing from it takes the
 *   presence its by-id lookup supports (see `TODOIST_PRESENCE`). `done`
 *   becomes true only through `checked: true` from Todoist itself.
 * - A task back in the active list is `active` again, whatever it was.
 * - Nothing is removed, and nothing is written to Todoist.
 *
 * `previous` are the task rows of the last import, as this function
 * returned them. `seenAt` is the read's time as an ISO 8601 string, stored
 * exactly. `lookups` answer `absentTodoistTasks(previous, fetched)`.
 */
export function reconcileTodoistTasks({
  previous,
  fetched,
  lookups = [],
  seenAt,
}: {
  previous: FetchedRecord[];
  fetched: FetchedPlatform;
  lookups?: TodoistLookup[];
  seenAt: string;
}): TodoistReconcileResult {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(seenAt))
    throw new Error('seenAt must be an ISO 8601 date and time');
  const projected = todoistProjection(fetched);
  const before = new Map(
    previous.filter(r => r.resource === 'task').map(r => [r.id, r]),
  );
  const answers = new Map(lookups.map(l => [l.id, l]));
  let reappeared = 0;

  const seen = projected.records.map(row => {
    if (row.resource !== 'task') return row;
    const earlier = before.get(row.id);
    if (earlier && presenceOf(earlier) !== 'active') reappeared++;

    return {
      ...row,
      values: { ...row.values, [todoistFields.lastSeen]: seenAt },
    };
  });
  const present = new Set(
    seen.filter(r => r.resource === 'task').map(r => r.id),
  );
  const check = new Set(absentTodoistTasks(previous, fetched));

  const carried = [...before.values()]
    .filter(row => !present.has(row.id))
    .map((row): FetchedRecord => {
      if (!check.has(row.id)) return row;
      const mark = (presence: TodoistPresence): FetchedRecord => ({
        ...row,
        values: { ...row.values, [todoistFields.presence]: presence },
      });
      const answer = answers.get(row.id);
      if (!answer || 'error' in answer) return mark('unconfirmed');
      if (answer.status === 404) return mark('unavailable');
      const body = object(answer.body);
      if (answer.status !== 200 || body.id !== row.id)
        return mark('unconfirmed');
      if (body.is_deleted === true) return mark('deleted');
      // Todoist returned the task itself: take its current values.
      const fresh = projectRecord({ ...row, values: body });

      return {
        ...fresh,
        values: { ...fresh.values, [todoistFields.lastSeen]: seenAt },
      };
    });

  const records = [...seen, ...carried];
  const summary: TodoistReconcileResult['summary'] = {
    active: 0,
    completed: 0,
    deleted: 0,
    unavailable: 0,
    unconfirmed: 0,
    reappeared,
    complete: isComplete(fetched),
  };
  for (const row of records)
    if (row.resource === 'task') summary[presenceOf(row)]++;

  return { platform: { ...projected, records }, summary };
}
