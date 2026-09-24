# Issue tracker: frontend design

Status: proposal for [#89](https://github.com/ontola/atomic-plugins/issues/89).
None of this is implemented yet. Where the design describes behaviour that
today's code does not have, [Gaps against today's implementation](#gaps-against-todays-implementation)
says so. `mockups.html` in this folder shows every screen below.
`issues.md` splits the work into implementation issues.

## What exists today

This folder has no user interface. What it has:

- `adapter.ts`, `tracker-actions.ts`: the sandbox-shaped GitHub Issues ↔
  Atomic kanban pilot. It covers one repository, one table and three
  statuses (Todo / Doing / Done). Doing is the `atomic:doing` label and Done
  is a closed issue. Its UI was atomic-server's generic Integrations dialog.
- `devonian/github-issues/`: the two-way Devonian bridge. It handles issues
  **and** comments, create and update, checkpointed three-way
  reconciliation, a write journal and `background.mjs` scheduling. Its README
  says it currently has **no host**, because ontola/atomic-server#1612
  removed atomic-server's demo route.
- `todoist.ts`: a read-only projection of Todoist tasks onto an issue list
  (done flag, due day, priority label).
- Jira: nothing in this folder. The repo has only
  `overlays/atlassian.com/jira/1001.0.0-SNAPSHOT/pagination-overlay.yaml`.
  `overlays/catalog.json` has no Jira platform, so the integration proxy
  cannot relay Jira requests today.

The target shape is the same as `integrations/notion/app/` and
`integrations/pets/app/`. That means a plain-DOM `view({ root, store })`
module built by `app/build.mjs`, which runs in a null-origin iframe, reads
the provider through `store.proxy.request/connections/connect` and writes
rows into the user's Atomic table.

## Users and core jobs

The primary user is one person, or a small team sharing a drive, who
already keeps issues in GitHub or Jira. They want those issues next to
their other Atomic data, and they don't want to give up the provider as the
place where collaborators work.

Jobs, in priority order:

1. **See what is in flight.** Open the app and see at a glance what is
   Todo, Doing and Done for one repository or project.
2. **Move work.** Move an issue between statuses by dragging or with the
   keyboard, and trust that GitHub reflects it: the issue is closed or
   reopened, and `atomic:doing` is added or removed.
3. **Find one issue.** Search by title, number/key or label and open it.
4. **Read and edit one issue.** Edit the title, description and comments,
   and add a comment.
5. **Trust the sync.** Know when data was last fetched, whether local changes
   have reached the provider, and what to do when they have not.

Not a job for this version: planning (cycles, sprints, estimates,
roadmaps), triage across many repositories, and pull request review.

## Competitor reference

What we take from each, and what we leave out on purpose. Sources: Linear's
[board layout docs](https://linear.app/docs/board-layout), GitHub's
[board layout docs](https://docs.github.com/en/issues/planning-and-tracking-with-projects/customizing-views-in-your-project/customizing-the-board-layout),
and Atlassian's [Jira list view docs](https://support.atlassian.com/jira-software-cloud/docs/what-is-the-list-view/).

| Pattern                              | Linear                                | GitHub Projects                     | Jira                       | Here                                                                    |
| ------------------------------------ | ------------------------------------- | ----------------------------------- | -------------------------- | ----------------------------------------------------------------------- |
| Board ↔ list toggle, same filter     | Yes (Cmd/Ctrl+B)                      | Yes (per view)                      | Board, list, backlog       | Yes: `B` toggles, and both views share one filter state                 |
| Columns = status                     | Grouped by status by default          | Any single-select field             | Workflow statuses          | Fixed three: Todo / Doing / Done                                        |
| Card contents                        | Key, title, a few properties, no body | Title plus chosen fields            | Key, summary, type, avatar | Number/key, title, up to 3 labels, comment count, sync marker           |
| Peek at detail without leaving board | Space to peek                         | Side panel                          | Side panel / modal         | Side panel at ≥ 1000 px, full-screen sheet below 600 px                 |
| Keyboard select and move             | X to select, S to move to a column    | Limited                             | Limited                    | `J`/`K` move focus, `Enter` opens, `1`/`2`/`3` set status, `/` searches |
| Column count and limit               | Count only                            | Count, optional informational limit | WIP limits                 | Count only; Done collapses to the 20 most recent                        |
| Sync/source indicator                | None (native)                         | None (native)                       | None (native)              | Ours: a per-card pending marker, a header sync pill, conflict review    |

The last row is what sets this app apart. Those three tools are the source
of truth, so they never show sync state. This app is a two-way mirror, so it
has to show sync state without being noisy about it.

## Information architecture

```
Issues app
├─ Header            name · source chip (repo/project) · sync pill · primary action
├─ Connection bar    account · scope · last sync · Sync now · ⋯ (change scope, disconnect)
├─ Banner slot       at most one: paused / reconnect / uncertain write / missing record
├─ Toolbar           Board | List · search · Label ▾ · count
├─ Content           Board (3 columns)  or  List (grouped by status)
└─ Detail            docked panel (≥1000px) · overlay drawer (600–999px) · sheet (<600px)
   ├─ title (editable), status segmented control, labels (read-only)
   ├─ description (Markdown, Write/Preview)
   ├─ comments (thread + composer)
   └─ provenance footer: "example/calendar#42 · synced 3 min ago · Open on GitHub"
```

Each app installation binds **one** source (one GitHub repository, one Jira
project or one Todoist project) to **one** table. That is what the bridge's
`trackerStateKey({ agent, drive, repository, mode })` assumes. More sources
means more installations. A board that combines sources is later scope.

## Shared visual language

This app shares its visual language with the sibling designs for Money,
Timesheets, Calendar and Notion (#89), so the five apps look like one
family. The token names and patterns come from the Money design plan, so
this design does not define its own.

- **Tokens.** Every colour and radius comes from the host's `--t-*`
  variables. atomic-server builds them in `useCreateThemeVars.ts` and sends
  them with the `__atomic_style` message. The app aliases them once to
  `--pl-*`:
  `--pl-bg` ← `--t-color-bg-body`, `--pl-surface` ← `--t-color-bg`,
  `--pl-sunken` ← `--t-color-bg-1`, `--pl-border` ← `--t-color-bg-2`,
  `--pl-text` ← `--t-color-text`, `--pl-muted` ← `--t-color-text-light`,
  `--pl-accent` ← `--t-color-main`, `--pl-accent-soft` ← `--t-color-main-selected-bg`,
  `--pl-accent-ink` ← `--t-color-main-selected-fg`, `--pl-neg` ← `--t-color-alert`,
  `--pl-warn` ← `--t-color-warning`, `--pl-radius` ← `--t-radius`,
  `--pl-font` ← `--t-font-family`. `--pl-pos` has **no host source**,
  because the host theme has no success colour. The apps use a literal
  fallback (`#2f8f5b` light, `#5cc48a` dark) until the host adds one.
  Two tokens are derived rather than aliased:
  - `--pl-hairline` is `color-mix(in srgb, var(--t-color-bg-2) 55%, var(--t-color-bg))`.
    Card and divider borders use it, because `bg-2` (`#ccc` in light mode)
    is too heavy for every card edge.
  - `--pl-on-accent` is `var(--t-color-bg)`. That gives white text on the
    light-mode accent and black text on the lighter dark-mode accent, and
    both pass AA.
- **Light/dark** needs no work in the app, because the host already sends
  the dark values of the same variables. The app must not hard-code a colour
  other than the `--pl-pos` fallback. It must not read
  `prefers-color-scheme` either: the user's Atomic setting decides the
  theme, not the OS.
- **Header**: plugin mark and name, source chip, sync pill, one primary
  action.
- **Connection bar**: sits under the header and shows the account, scope,
  last sync time, Sync now and an overflow menu.
- **Sync pill** states: `Synced 3 min ago` (idle), `Syncing…`,
  `Sync paused`, `Reconnect needed` and `Sync failed`. Each state has its own
  icon shape as well as its own colour.
- **Empty**: a centred icon, one sentence and one primary button.
- **Error**: an inline banner under the connection bar with the cause in one
  sentence, one recovery action, and an optional "Details" disclosure with
  the raw message. Errors never use toasts. A toast may confirm a routine
  action ("Moved #42 to Done").

Issue-specific additions:

- The status glyph: an empty ring for Todo, a half-filled ring for Doing
  and a filled check for Done. The shapes keep status readable without
  colour.
- The issue card.
- The label chip.
- The field-level conflict diff.

## Key screens and states

Each numbered state below is a frame in `mockups.html`.

1. **Host cannot relay** (`store.proxy` is missing). One sentence: "This
   Atomic Server can't reach GitHub or Jira for apps. Ask its admin to
   update it." No button. The wording matches Notion's `no-proxy` state.
2. **First run: choose a source.** Three rows: GitHub Issues (two-way),
   Jira (read-only at first) and Todoist (read-only). Each row says in one
   line what will be written back. "Connect" calls
   `store.proxy.connect({ platform })`, and the host draws its consent bar.
   A source whose platform is not in the proxy catalog shows as disabled
   with "Not available on this server yet".
3. **Choose repository / project.** This comes after the connect
   round-trip. It is a searchable list: the repositories the token can see
   on GitHub, or the projects in the chosen site on Jira. Before the user
   commits, a plain statement spells out the effects: "Moving a card to Done
   closes the issue on GitHub. Moving it back reopens it. Doing adds the
   `atomic:doing` label." The primary button shows a count only when the
   provider gives one cheaply. GitHub's `open_issues_count` includes pull
   requests, so the label says "about 214 open issues".
4. **First import.** Skeleton columns fill in as pages arrive, and the
   connection bar reads "Importing… 150 issues so far". The board can be
   read while the import runs, but moving a card is disabled until the
   first pass completes, because the bridge has no checkpoint to reconcile
   against before then.
5. **Empty.** Two cases, each with its own message: the repository has no
   issues ("No issues in example/calendar yet. [New issue]"), or the filters
   hide all of them ("No issues match 'refresh' with label bug.
   [Clear filters]").
6. **Populated board** (the default at ≥ 720 px). Three columns with counts.
   Done shows the 20 most recently closed issues, then "Show 312 more". Each
   card shows:
   - `#42` (or `CAL-42`)
   - the title, up to 3 lines
   - up to three label chips, then "+2"
   - the comment count
   - a small sync marker while a change is pending: a hollow dot for
     "Waiting to send", a spinning arc for "Sending". An in-sync card has no
     marker.
7. **Populated list** (the default below 720 px, optional above). Rows are
   grouped by status under collapsible group headers. Each row has a status
   glyph, the number, the title, labels, comment count and a relative
   updated time. The glyph is a button: clicking it opens a three-item
   status menu.
8. **Detail / edit.**
   - The title is an in-place text field: Enter saves, Esc reverts.
   - Status is a three-segment control.
   - The description has Write / Preview tabs. The Markdown source is what
     GitHub stores.
   - Comments appear in time order. Authors show as provider logins ("alice
     on GitHub"), not as Atomic agents, following the bridge's provenance
     rule. A composer at the bottom has a "Comment" button that sends to
     GitHub.
   - The footer reads "example/calendar#42 · synced 3 min ago · Open on
     GitHub ↗".
   - For Jira and Todoist, read-only text replaces the edit controls, with a
     one-line note: "Read-only: changes to Jira issues are not sent back
     yet."
9. **Syncing (background).** The pill spins and nothing else moves. Cards
   that change when new data arrives get a 1.5 s highlight, which is
   suppressed under `prefers-reduced-motion`.
10. **Sync paused: conflict.** A banner reads "Sync paused. 2 issues were
    changed both here and on GitHub since the last sync. [Review 2
    conflicts]", and the affected cards carry a warning marker. Review opens
    a panel for each issue. Each field shows its name, the "Here" value and
    the "On GitHub" value, with a choice per field (Keep here / Keep
    GitHub's). "Apply and resume sync" stays disabled until every field has
    a choice.
11. **Reconnect needed.** This covers GitHub answering 401 and a missing
    connection code. The banner reads "GitHub no longer accepts this
    connection. Your issues are still here. Changes you make are kept and
    sent after you reconnect. [Reconnect GitHub]".
12. **Uncertain write.** This is the journal's "Uncertain GitHub write". The
    banner reads "'Close #42' was sent to GitHub, but no answer came back, so
    it's unclear whether it arrived. Check #42 on GitHub ↗, then choose: [It
    was closed] [Send again]". The app never retries automatically, because
    GitHub has no idempotent create.
13. **Missing record.** "#42 is on this board but no longer on GitHub. It may
    have been deleted or transferred. [Remove from board] [Keep here only]".
    Removal asks for inline confirmation and never touches GitHub.
14. **Write rejected by Atomic.** "Atomic Server refused to save #42 because
    you don't have write rights on this table. Ask the drive owner for
    access, then [Try again]".

Transient failures (network, 5xx, rate limit) do **not** get a banner. The
pill reads "Sync failed · retrying in 4 min", and its popover has a "Retry
now" action. This matches `background.mjs`'s exponential backoff.

## Interactions

- **Moving status**: drag a card between columns, focus a card and press
  `1`/`2`/`3`, or use the card's "Move to…" menu. Each produces one local
  write. The card shows "Waiting to send" until the bridge confirms.
- **Optimistic, but honest**: the card moves immediately. If the provider
  write later fails permanently, the card stays where the user put it and
  the banner explains what happened. It does not silently snap back.
- **New issue**: "New issue" in the header opens the detail panel in create
  mode, in Todo by default. Creates are journalled, so a lost response leads
  to state 12 and never to a duplicate.
- **Search**: runs client-side over the table rows (title, number, labels).
  `/` focuses the search field. Filters persist per installation in the App
  resource. They can't use frame storage, because a null-origin frame has
  none.
- **Keyboard map** (`?` shows it):
  - `J`/`K` or the arrow keys move focus
  - `Enter` opens, `Esc` closes
  - `1`/`2`/`3` set status
  - `C` comments, `N` creates a new issue
  - `B` toggles board/list, `/` searches
  - `G` then `S` runs Sync now

## Accessibility

- Board columns are `role="list"` with a heading. Cards are
  `role="listitem"` and contain one button that opens the detail. Every drag
  has the keyboard and menu equivalents above. A polite live region
  announces moves ("Moved #42 to Done").
- Status is never shown by colour alone. List rows show the glyph shape plus
  text, and cards have a visually hidden label.
- The sync pill is `role="status"`. A banner is `role="alert"` only when a
  sync raises it, not when it is already there on page load.
- When the detail panel closes, focus returns to the card that opened it.
  The mobile sheet traps focus.
- Hit targets are at least 32×32 px on desktop and 44×44 px below 600 px.
- Contrast is bounded by the host tokens. `--t-color-text-light` on
  `--t-color-bg` is `#666` on `#fff` (5.7:1) in light mode and `#999` on
  `#000` (7.4:1) in dark mode. Both pass AA for body text. Label colours
  come from GitHub as arbitrary hex values, so a chip never uses the label
  colour as its fill or text colour. The chip is `--pl-sunken` with
  `--pl-text` text, and the label colour appears only as an 8 px dot. That
  keeps chip text contrast equal to body text in both themes, with no
  per-label calculation.

## Responsive

The iframe width is the only breakpoint input. Plugin frames are roughly
360–1200 px wide.

| Width      | Default view | Detail                        | Header                                                       |
| ---------- | ------------ | ----------------------------- | ------------------------------------------------------------ |
| < 600 px   | List         | Full-screen sheet with Back   | Name and pill; the source chip moves into the connection bar |
| 600–719 px | List         | Overlay drawer, 100% − 48 px  | Full                                                         |
| 720–999 px | Board        | Overlay drawer, 440 px        | Full; columns scroll horizontally with snap below 3 × 240 px |
| ≥ 1000 px  | Board        | Docked side panel, 400–440 px | Full                                                         |

An explicit Board/List choice by the user overrides the default at every
width.

## Scope

**Now (first implementation):**

- GitHub Issues as the source, two-way for title, body, status and comments
  (what the bridge already maps).
- Board, list and detail views; creating an issue; adding and editing
  comments.
- All of states 1–14.
- Labels, shown read-only.

**Next:**

- Jira Cloud as a read-only source: summary, description as plain text,
  status category mapped to Todo/Doing/Done, key, labels and assignee.
- Todoist, through the existing projection.
- Showing assignees for GitHub.

**Later:**

- Writing back to Jira. This needs workflow transitions, not a status field.
- Editing labels and assignees.
- Multiple sources on one board.
- Custom columns beyond three. Atomic's Blocked status is not mapped today.
- Milestones and sprints.
- Notifications.

## Gaps against today's implementation

Each of these blocks part of the design and has an issue in `issues.md`.

1. **No iframe app exists** for this plugin (`app/` is missing).
2. **Transport mismatch.** The transport in
   `devonian/github-issues/proxy.mjs` spends the rotating connection code
   itself (`getCode`/`setCode`). In the iframe model the host holds the
   code, and the frame may only call `store.proxy.request`. The app needs a
   transport backed by the relay.
3. **Atomic port mismatch.** `AtomicPort` and `target.mjs` rely on
   data-browser store internals: `queryLocalDb`, `isLocalOnlyDrive`,
   `hasCompletedDriveSyncFor` and `getSaveState`. The frame's `PluginStore`
   exposes only `getResource`, `query`, `newResource` and `save`. Whether
   `save()` resolving through the relay means AtomicServer acknowledged the
   write is not verified.
4. **Persistence.** The bridge snapshot, the write journal and the
   `background.mjs` schedule are designed for IndexedDB. A null-origin frame
   can't use IndexedDB or `localStorage`, and whether `navigator.locks`
   works there is unverified. So they have to live in the app's own Atomic
   subtree or in a host API. This needs a decision (see below).
5. **Conflict resolution API.** On a conflict the bridge throws and
   `background.mjs` pauses. There is no call to resolve a field in favour of
   one side and resume, and state 10 needs one.
6. **Uncertain write and missing record decisions** (states 12 and 13) also
   need bridge calls: mark an operation as landed, re-send it, or unbind a
   record.
7. **Labels, assignees, updated time and comment counts** are not written to
   Atomic today. Only the `atomic:doing` label is inspected. The card and
   list designs need them as read-only projected properties.
8. **The repository picker** needs a GitHub `GET /user/repos` read through
   the proxy, so the proxy's GitHub Issues OpenAPI document must include
   that path. Not verified.
9. **Jira** has no proxy catalog entry, no auth overlay and no CRUD
   Causality overlay. Its enhanced search (`/rest/api/3/search/jql`) pages
   with `nextPageToken`, which the existing `startAt` pagination overlay
   does not describe. Verify this before relying on the overlay. Jira
   descriptions are Atlassian Document Format JSON, not Markdown.
10. **The host has no success colour token** (see the `--pl-pos` fallback
    above).

## Decisions needed

1. **Where the bridge snapshot and write journal live for an iframe app.**
   The options are the app's Atomic subtree, or a new host-side storage op
   that is per browser, like the connection code. The Atomic subtree syncs
   across devices, but then the journal is shared state, and two devices
   could both resume the same uncertain write. This design assumes the host
   op, which is the safer default for a single-use journal.
2. Whether Jira ships read-only first (as this design proposes) or waits
   for write-back.
3. Whether to keep the `atomic:doing` label convention, or let the user
   pick an existing label (such as `in progress`) during setup.
4. Whether Todoist belongs in this app at all, or in a "Tasks" app of its
   own.
