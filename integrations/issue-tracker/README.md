# GitHub issues ↔ Atomic kanban

A two-way sync for one repository and one ordinary Atomic kanban table. Provider
code (`adapter.ts`, `tracker-actions.ts`) stays here.

This folder also holds the plugin's other issue sources:

- `devonian/github-issues/`: the in-browser Devonian GitHub issues lens and
  bridge (moved from the `devonian` package; see its README).
- `todoist.ts`: the read-only LocalThought projection of Todoist tasks onto
  an issue list (moved from `integrations/localthought/`), with
  `todoist.test.ts` and the recorded-fixture check `todoist-fixture.test.ts`.

## Mapping

| GitHub                                    | Atomic      |
| ----------------------------------------- | ----------- |
| Issue title                               | Card title  |
| Markdown body (`null` becomes empty text) | Description |
| Open, without `atomic:doing`              | Todo        |
| Open, with `atomic:doing`                 | Doing       |
| Closed                                    | Done        |

Dragging a card to Done closes its issue; moving it back reopens it. Other labels
are preserved: the adapter adds/removes only `atomic:doing`, never replaces the
whole label set. Create that label in the test repository before using Doing.
Pull requests are excluded. Comments, assignees, milestones, GitHub Projects and
issue deletion are outside this first scope. A missing issue/card is a conflict,
not permission to delete the other side.

## Todoist: tasks that stop appearing

`todoist.ts` is read-only: the proxy's Todoist catalog grants `data:read`
and allows `GET` only (`/tasks`, `/tasks/{task_id}`, `/projects`,
`/projects/{project_id}`). Closing, editing or creating a task in an issue
list is never sent to Todoist, and the next import does not undo a local
edit on its own either; whatever imports the rows decides that.

`/tasks` lists **active** tasks only. A task that was imported and is
missing from a later read may have been completed, deleted, moved to a
project the connection cannot see, or the connection may have lost access.
Absence alone proves none of these, so the supported behaviour
(`reconcileTodoistTasks`, with `absentTodoistTasks` saying which ids to
check) is:

| Situation                                                        | `presence`    | `done`    | `last-seen` |
| ---------------------------------------------------------------- | ------------- | --------- | ----------- |
| In the active list                                               | `active`      | `false`   | this read   |
| Missing; `GET /tasks/{id}` returns it with `checked: true`       | `completed`   | `true`    | this read   |
| Missing; `GET /tasks/{id}` returns it with `is_deleted: true`    | `deleted`     | unchanged | unchanged   |
| Missing; `GET /tasks/{id}` answers 404                           | `unavailable` | unchanged | unchanged   |
| Missing; the check failed (network, 401/403, 5xx) or was not run | `unconfirmed` | unchanged | unchanged   |
| The read itself was partial or failed (`fetched.errors`)         | unchanged     | unchanged | unchanged   |
| Back in the active list after any of the above                   | `active`      | `false`   | this read   |

- "Unchanged" means the row keeps its last imported values, so
  `last-seen` says how old they are. No row is ever removed.
- `unavailable` is never shown as closed: Todoist does not say whether a
  404 means deleted or no longer reachable.
- `completed`, `deleted` and `unavailable` are not checked again until the
  task reappears; `active` and `unconfirmed` are checked on every complete
  read that misses them.
- `last-seen` is the caller's `seenAt`, an exact ISO 8601 string.

**Not verified.** Whether live Todoist API v1 returns a completed task from
`GET /tasks/{id}` with `checked: true`, rather than a 404, is not verified:
there is no recorded fixture yet (#46) and no credentials here. If it
answers 404, completed tasks will show as `unavailable`, which is still
not a false "completed". The cases above are covered by synthetic fixture
tests in `todoist.test.ts`. **No host calls `reconcileTodoistTasks` yet.**
Nothing in atomic-server at the pin (`bae5cdbe3`) imports `todoist.ts` at
all, neither the projection nor this check (searched `browser/` and
`server/src`), so the `devonian-todoist` catalog entry describes a flow no
host runs today. The host journey that runs the check, and exercises these
states end to end, is still to be built.

## Verification

```sh
./browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/issue-tracker/tsconfig.json
```

These check `adapter.ts`'s pagination, PR exclusion and mapping, the generic
event-to-JavaScript starter (`automation.test.ts`), the Todoist projection, and
every test under `devonian/github-issues/`. The latter import the `devonian`
package from source, so install its dependencies first
(`cd devonian && pnpm install --frozen-lockfile`).

API reference: https://docs.github.com/en/rest/issues/issues
Label operations: https://docs.github.com/en/rest/issues/labels
