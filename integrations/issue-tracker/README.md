# GitHub issues ↔ Atomic kanban

A two-way sync for one repository and one ordinary Atomic kanban table. Provider
code (`adapter.ts`, `tracker-actions.ts`) stays here.

This folder also holds the plugin's other issue sources:

- `app/`: the **GitHub issues drive app**, the current host for the Devonian
  bridge (#100). See [Drive app](#drive-app-app) below.
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

## Drive app (`app/`)

An iframe drive app, the same shape as `pets/app/` and `notion/app/`: one
ES module (`app/build.mjs` -> `dist/ui.js`, minified, about 123 KB) whose
`view({ root, store })` runs in the host's null-origin frame. It hosts the
Devonian bridge from `devonian/github-issues/` for **one repository per app
install**, two-way for issue title, body (Markdown), Todo/Doing/Done status
and comments.

**Flow.** The first screen offers GitHub Issues (Jira and Todoist are shown
as not available). "Connect" asks the host for a connection
(`store.proxy.connect`, the host's consent bar, platform `github-issues`).
The app then lists the repositories the connection can see
(`GET /user/repos`, up to 5 pages of 100, through `store.proxy.request`),
with repositories that have issues turned off disabled; if the proxy will
not list them, it asks for `owner/name` instead. Before import it spells out
what the board will do on GitHub. Choosing one creates the columns and binds
the repository to the app for good. Sync runs when the view opens, on "Sync
now" (or `G` `S`), after each edit made in the app, and after a transient
failure (4, 8, … up to 60 minutes, while the view is open).

**The view** follows `design/DESIGN.md` and `design/mockups.html` (#89):
a board (Todo / Doing / Done, Done collapsed to the 20 most recently
updated) at 720 px and wider, a list below that, and an explicit
Board/List choice (`B`) that wins at every width; search and a label filter
shared by both; an issue panel (docked at 1000 px and wider, a drawer from
600 px, a full-screen sheet below) with the title, status, read-only labels,
the description (Write / Preview, a safe Markdown preview) and comments;
"New issue" (`N`); the sync pill and connection bar; one banner per problem;
and `?` for the keyboard shortcuts. Cards move by drag, by `1`/`2`/`3` on a
focused card or by their "Move to…" menu. The shared chrome (the `--pl-*`
aliases of the host's `--t-*` theme variables, pill, banner, empty state,
buttons) is in `app/ui/`, separate from the issue views, so it can move to a
shared package later. Layout and filters persist on the app's sync resource.

**What it writes, and where.** Everything goes into the app's own subtree
(the only place a drive app may write): the Status select (Todo / Doing /
Done tags), GitHub issue number and GitHub source columns under the app's
ontology; one row per issue in the app's table, the body in Atomic's own
`description`; one Message per comment (`about` its row) in a "GitHub
comments" folder under the app; and one sync resource holding the bound
repository and the sync state as JSON text.

**Review before provider writes.** A pass never sends a create or update to
GitHub on its own. An edit in the app (a moved card, a title, a
description, a comment, a new issue) is written into the table at once and
its card shows "Waiting to send"; "Review and send" in the connection bar
lists what would go out. Every change the Bridge would send is held
(`devonian/github-issues/review.mjs`) and listed ("Update #1: status Todo →
Done (close it)"); "Send N changes to GitHub" approves exactly that content
for one pass. A change edited after review is held again. Imports into the
table are not gated, as for pets and notion. This is the app-level boundary
only: named actions, MCP exposure and the host-side approval journal of
[ACTIONS.md](../ACTIONS.md) remain #11's design, and this app does not
replace them.

**Recovery.**

- Same field changed on both sides since the last sync: sync pauses, the
  card is marked, and "Review conflict" shows each field's two values
  (`Bridge.describeConflict`). A side is chosen per field; "Apply and resume
  sync" settles only those fields (`Bridge.resolveConflict` with a
  `{ field: side }` choice) and syncs again. Keeping this table's side
  becomes a held write, reviewed like any other. The Bridge stops at the
  first conflicting record, so several conflicts are reviewed one at a time.
- GitHub answers 401, or the host no longer has the connection: "Reconnect
  GitHub". The refused connection is not offered again after the reload.
- A write whose response was lost: the next pass reads GitHub back first. If
  the write landed, the operation just completes. If not, an update is offered
  for review again, marked as unconfirmed; a create is never resent (the
  transport's journal refuses: "Uncertain GitHub write"), and sync stays
  paused. The banner says so and links to GitHub; "Send again" is offered
  only for an update GitHub does not show. There is no in-app way out for an
  uncertain create yet (design state 12), nor for a record missing on one
  side (state 13, "Remove from board" / "Keep here only"): both need Bridge
  calls, and unbinding needs an `AtomicIdentityMap` unbind in `devonian/`.
- Atomic Server refusing a write: a banner with "Try again".
- Anything else (network, 5xx, rate limit) shows on the pill only, with
  "Retry now", and is retried on a timer while the view is open. While sync
  is paused or failed the board still shows the table's rows.

**Host behaviour it relies on or works around** (atomic-server `bae5cdbe3`,
read in `hostStore.ts`, `proxyConnections.ts`, `collection.ts`;
`app/frameStore.ts` has the detail):

- No credential reaches the app's code: the bridge's `proxyTransport` runs
  with a `dispatch` over `store.proxy.request` (since #54 phase 2 the host's
  frame client calls the proxy with a capability and its own key), and its
  write journal still guards uncertain writes. Host refusals that happen
  before anything is sent (no capability, no Ed25519 in this browser) are
  recognised by message, and the proxy's own refusals by their `error`
  code; neither is uncertain.
- A resolved `save`/`newResource` is an acknowledged `/app-write` commit.
- The frame's reads come from the host page's cache, which did **not** show
  the app's own save within 5 s in the e2e. The adapter corrects its reads
  for its own saves (per view) instead of waiting.
- `query` is answered from the page's local index first and can miss fresh
  resources; subjects the app has seen are remembered in its sync state.
- No IndexedDB, localStorage or Web Locks in the frame, so
  `background.mjs` is not used and nothing runs while the app is closed.

**Not verified, or not supported:**

- Only against the mock proxy's seeded repository (`atomic-fixture/tracker`:
  two issues, one comment). Nothing has run against live GitHub, the real
  integration proxy, or a repository beyond a handful of issues. The
  Collection pages at 500; larger repositories are not tested.
- Two tabs or devices syncing the same app at once are not guarded: the sync
  state syncs with the drive and `/app-write` has no compare-and-swap. One
  syncing view per app is assumed. (The design's alternative, a per-browser
  host storage op, needs atomic-server work.)
- The sync state grows with the write journal; it is not pruned.
- Comments made in the data-browser's own comment panel on a row are not
  synced: they live outside the app's subtree, which the app cannot write.
- The repository picker's `GET /user/repos` is not in the proxy's GitHub
  Issues document (localthought/openapi-directory `github-issues/1.1.4`
  lists `/repos/{owner}/{repo}/issues…` only), so against the real proxy
  the app most likely falls back to typing `owner/name`. The mock fixture
  answers it. Changing the bound repository means a new app.
- Labels (names and colours, without `atomic:doing`), assignees and
  GitHub's comment count are read into the row's GitHub source metadata
  and shown read-only; they are never sent back. Milestones and pull
  requests are not synced; deletion on either side is never propagated.
- Editing an existing comment has no control in the view yet (the Bridge
  syncs such edits made in the table).
- Host calls from atomic-server pin 007869464 are used when present and
  feature-detected otherwise: links ("Open on GitHub", "Check on GitHub",
  links in descriptions) go through `store.openExternal`, which shows the
  destination first (older hosts: `window.open`, which the sandbox may
  refuse); light/dark comes from `store.getTheme()`/`onThemeChange()`;
  `--pl-pos` is the host's `--t-color-success`; "Disconnect GitHub" in the
  connection menu calls `store.proxy.disconnect` (only this app's
  delegation goes; the table stays); and rows a query lists are read with
  `store.getMany` in batches of 100.
- Search, keyboard and drag were checked in jsdom and the e2e; drag and drop
  was not exercised in an automated test.
- **Install.** No catalog install flow for drive apps exists yet (#94), so
  there is no catalog entry: one would advertise a runtime a user cannot
  reach. The e2e installs the app test-side, as pets' and notion's do.

`app/package.json` pins `devonian@0.8.0` from npm (install it with
`pnpm install --frozen-lockfile` in `app/`), bundled as `devonian/atomic` plus
`reconcileRecord`; `@tomic/lib` is shimmed as in notion. It lives in `app/`
rather than here because `certify.mjs` treats a `package.json` in a plugin
folder as a sandbox package. `syncables` is not used: the Bridge's GitHub
port already pages GitHub, and bundling the GitHub OpenAPI document for
syncables would only add size.

## Verification

```sh
./browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/issue-tracker/tsconfig.json
./browser/node_modules/.bin/tsc -p integrations/issue-tracker/app/tsconfig.json
node integrations/tooling/run-lane.mjs issue-tracker --tier e2e
```

The drive app's unit tests run against an in-memory host
(`app/fakeStore.ts`) and the same GitHub fixture the mock proxy serves,
including a host whose reads never show the app's own saves:
`app/sync.test.ts` and `app/controller.test.ts` the sync and the
controller (edits, comments, creates, conflict review, repository list,
view preferences), `app/model.test.ts` the derived view data (columns,
filters, pill, banners, markers, breakpoints), and, in jsdom,
`app/ui/kit.test.ts` the shared chrome and theme tokens and
`app/views.test.ts` the rendered view (keyboard and menu moves, the live
region, the detail panel, comments, New issue, focus return, empty states,
persistence, alerts, the conflict review). `app/build.test.ts` checks the
bundle and typechecks `app/`. The e2e (`e2e/issue-tracker.spec.ts`) covers
connect, picking the repository, import, reload with an unchanged refresh,
a reviewed update (closing #1), a title conflict settled for GitHub's side
in the review panel, a card moved with the `3` key and a comment, each
sent after review.

These check `adapter.ts`'s pagination, PR exclusion and mapping, the generic
event-to-JavaScript starter (`automation.test.ts`), the Todoist projection, and
every test under `devonian/github-issues/`. The latter import the `devonian`
package from source, so install its dependencies first
(`cd devonian && pnpm install --frozen-lockfile`).

API reference: https://docs.github.com/en/rest/issues/issues
Label operations: https://docs.github.com/en/rest/issues/labels
