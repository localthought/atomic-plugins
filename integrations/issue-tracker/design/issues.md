# Issue tracker frontend: implementation issues

These issues implement `integrations/issue-tracker/design/DESIGN.md`
(mockups: `mockups.html`, same folder), for #89.

Format: each `## ` heading is an issue title. Everything under it, up to the
next `## `, is the issue body. Every body ends with the same "Refs" line.
`IT-n` numbers exist only in this file, so that dependencies can be written
down before the issues get real numbers. Replace them after filing.

Each issue writes only inside `integrations/issue-tracker/`, unless it says
otherwise. Issues that need another folder or repository say so, because
that needs the maintainer's OK first.

Parallelism: IT-1, IT-2, IT-3, IT-4, IT-13 and IT-18 have no dependencies
and can start at once. IT-7, IT-8 and IT-9 need only IT-2 to build their
UI against fixture rows. They get wired to real data after IT-4.

---

## IT-1 · issue-tracker app: scaffold the iframe app, connect flow and first-run states

Create `integrations/issue-tracker/app/`, shaped like
`integrations/notion/app/`:

- `build.mjs` → `app/dist/ui.js` exporting `view({ root, store })`
- `store.ts` (hand-kept `PluginStore` types)
- `controller.ts` with a `ViewState` union that can be tested without a DOM
- `main.ts`
- `build.test.ts`, which asserts the bundle has no `fetch`, no storage and
  no `Authorization`

Scope:

- DESIGN.md state 1 (`store.proxy` missing) and state 2 (choose a source).
  The Jira row is disabled when the platform is not in the proxy catalog.
- "Connect" calls `store.proxy.connect({ platform: 'github-issues' })`.
  After the page returns, `store.proxy.connections(...)` finds the
  connection.
- No sync yet. After connecting, the app shows a placeholder "Connected"
  state.

Acceptance:

- `./browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts app`
  passes.
- The `ViewState` tests cover `no-proxy`, `not-connected`, `connecting` and
  `connected`.
- The bundle builds reproducibly.

Depends on: nothing.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-2 · issue-tracker app: `--pl-*` tokens and the shared chrome components

In `integrations/issue-tracker/app/ui/`, implement the token aliases and
plain-DOM builders for the shared #89 visual language:

- `--pl-*` aliases from the host's `--t-*` variables, including the derived
  `--pl-hairline` and `--pl-on-accent`, and the `--pl-pos` fallback.
- Header (`pl-header`).
- Connection bar with progress line (`pl-conn`).
- Sync pill (`pl-pill`), with states `synced`, `syncing`, `paused`, `reauth`
  and `error`, each with its own icon.
- Banner (`pl-banner`), with tones `neg`, `warn` and `info`, one action slot
  and a Details disclosure.
- Empty state (`pl-empty`).
- Buttons, segmented control, search field, label chip (dot plus text), and
  the status glyph (ring / half / check).

The CSS is injected as one `<style>` element by `view()`. The drive frame
serves no stylesheet. `mockups.html` frames 1, 2 and 10 are the visual
reference.

Acceptance:

- Unit tests (jsdom) render each component and each pill/banner state.
- No literal colours except the `--pl-pos` fallback.
- It renders correctly with both the light and the dark `--t-*` values from
  `mockups.css`.

Maintainer decision needed first: whether these components stay per plugin
(this issue) or get extracted to a shared package for all five #89 apps.
Extraction needs the maintainer's OK under the folder-containment rule.

Depends on: nothing.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-3 · devonian/github-issues: a transport over the host proxy relay

`proxy.mjs`'s `proxyTransport` spends the rotating connection code itself
(`getCode`/`setCode`). An iframe app must not hold that code. Add a
transport that has the same interface as the one the `Bridge` and ports
use, and sends every request through `store.proxy.request({ platform,
connectionId, path, method, body })`.

Requirements:

- It refuses any URL outside the OpenAPI document's `servers[0].url`, the
  same as `pets/app/transport.ts`.
- It maps the relay's `{ status, headers, body }` onto the errors
  `background.mjs` classifies. That includes GitHub `401` as permanent, and
  a missing response as "Uncertain GitHub write".
- It keeps the journal-before-send rule, so the write journal is still
  written before a request goes out.

Acceptance:

- Unit tests with a fake relay cover:
  - a success
  - 401 → permanent
  - 5xx → transient
  - a lost response on create → uncertain, with no retry
  - an off-origin `Link` header → refused
- `proxyTransport` and its tests are unchanged.

Depends on: nothing.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 2).

## IT-4 · devonian/github-issues: an AtomicPort for the drive-plugin `PluginStore`

`AtomicPort` and `target.mjs` use data-browser store internals
(`queryLocalDb`, `isLocalOnlyDrive`, `hasCompletedDriveSyncFor`,
`getSaveState`). A drive frame only has `getResource`, `query`,
`newResource` and resource `save()`. Add a port that works over that
surface:

- It enumerates the table's rows through `store.query`.
- It creates rows with `newResource({ parent, isA, propVals })`.
- It keeps `localId` recovery, so a retried create finds and reuses its row.

Verify, and document in the README, what a resolved `save()` means through
the relay: acknowledged by AtomicServer, or only queued. If it means
queued, the port must fail closed, the way the existing `synced` drive case
does.

Acceptance:

- Unit tests with `fakeStore` (as in `notion/app/fakeStore.ts`) cover
  enumeration, create, a recovered create and a rejected write → `Atomic
  write rejected`.
- A note in `devonian/github-issues/README.md` states the verified `save()`
  semantics, or states that they are unverified.

Depends on: nothing. Needs someone who can read atomic-server's
`view-client.js` / relay code at the pinned `.atomic-server-ref`.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 3).

## IT-5 · issue-tracker app: persist bridge snapshot, write journal and schedule outside the frame

A null-origin frame can't use IndexedDB or `localStorage`, so the bridge
snapshot, the transport journal and the `BackgroundSync` schedule need
another home. Implement whichever option the maintainer picks
(DESIGN.md → Decisions needed, item 1):

- **(a)** The app's own Atomic subtree. It syncs across devices, but it
  needs a lease so that two devices can't resume the same uncertain write.
- **(b)** A new host storage op, per browser. That needs an atomic-server PR
  against `feat/plugin-debug`, with the pin bump in its own PR.

Also check whether `navigator.locks` works in the sandboxed frame. If it
doesn't, pass `locks` explicitly to `createBackgroundSync`.

Acceptance:

- The snapshot and journal survive a frame reload (unit test with a fake
  backend).
- Two concurrent `syncNow()` calls never spend the same code twice.

Depends on: the maintainer's decision. IT-3 and IT-4 for the integration
test.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 4).

## IT-6 · issue-tracker app: repository picker and write-back consent (state 3)

After connecting:

- List the repositories the connection can see (`GET /user/repos`, paged,
  through the relay). Show "about N open issues" from `open_issues_count`,
  labelled as approximate because it includes pull requests.
- Filter the list by name. Disable repositories that have
  `has_issues: false`.
- Show the effects list from `mockups.html` frame 6 before "Import".
- Store the chosen repository on the App resource (non-secret: platform,
  connectionId reference, `owner/name`).

First check whether the proxy's `github-issues` OpenAPI document includes
`/user/repos`. If it doesn't, the overlay change belongs in `overlays/`,
which is outside this folder and needs the maintainer's OK. File that as a
separate issue.

Acceptance:

- Controller tests cover paging, the disabled repositories and the stored
  selection.
- The e2e test (IT-15) selects a repository from the mock proxy fixture.

Depends on: IT-1, IT-3.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-7 · issue-tracker app: board view (states 4, 6)

Build three status columns (Todo / Doing / Done) from table rows, following
`mockups.html` frames 1, 2 and 7:

- Column counts.
- Done collapsed to the 20 most recently closed issues, with "Show N more".
- Cards show the number, a 3-line title, up to 3 label chips then "+n",
  the comment count, and a pending sync marker (waiting / sending /
  conflict).
- Moving a card: pointer drag, the `1`/`2`/`3` keys on a focused card, or a
  "Move to…" menu. A polite live region announces each move.
- Optimistic: the card moves immediately and shows "Waiting to send" until
  the bridge confirms it.
- First-import state: skeleton cards, and moving is disabled until the
  first checkpoint exists.
- At 720–999 px, columns scroll horizontally with snap.

Acceptance:

- jsdom tests cover the keyboard move, the menu move and the live-region
  text.
- The Done collapse is correct at 0, 20 and 21+ issues.
- The UI is built against fixture rows. Real data is wired once IT-4 lands.

Depends on: IT-2. Integration with IT-4 and IT-10.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-8 · issue-tracker app: list view and responsive defaults (state 7)

Build the list view from `mockups.html` frame 3:

- Rows grouped by status under collapsible headers. Done is collapsed by
  default.
- Each row: a status glyph button (opens a three-item status menu), number,
  title, 2 chips, comment count and a relative updated time.

Also:

- The Board/List toggle (`B`).
- Width-based defaults: List below 720 px, Board at 720 px and above. An
  explicit choice by the user wins at every width.
- The compact header below 600 px: the source chip moves into the
  connection bar and "New issue" becomes an icon button.
- 44 px hit targets below 600 px.

Acceptance:

- Tests cover the default at 380, 700 and 1000 px (`ResizeObserver` on
  `root`), and that an explicit choice survives a resize.

Depends on: IT-2.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-9 · issue-tracker app: issue detail, edit, comments and New issue (state 8)

Build the detail view from `mockups.html` frames 1 and 4:

- A docked panel at ≥ 1000 px, an overlay drawer at 600–999 px, and a
  full-screen sheet below 600 px. Focus returns to the originating card or
  row on close, and the sheet traps focus.
- Title: an auto-growing textarea. Enter saves, Esc reverts.
- Status: a segmented control.
- Labels: read-only.
- Description: Write / Preview tabs. Preview renders safe Markdown with no
  raw HTML.
- Comments in time order, with provider logins ("alice on GitHub").
- A composer that shows "Waiting to send" on pending comments.
- A provenance footer with an "Open on GitHub" link.
- "New issue" (`N`, and the header button) opens the same panel in create
  mode.

Acceptance:

- Tests cover the title save/revert, the status change, adding a comment
  (a pending comment rendered), create mode, and focus return.

Depends on: IT-2. Integration with IT-4.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-10 · issue-tracker app: wire BackgroundSync to the pill, connection bar and banners

Drive `createBackgroundSync` from the app, then map its state onto the UI:

- `status()` → the pill's `synced` / `syncing` / `paused` / `reauth` /
  `error` state.
- The connection bar shows the last sync time and a pending-writes count.
- A transient failure gives the pill "Sync failed · retrying in N min" and
  a popover with "Retry now". It does not raise a banner.
- Permanent errors (`permanentSyncErrors`) map to banners:
  - GitHub 401 or a missing code → state 11 ("Reconnect GitHub" calls
    `store.proxy.connect`)
  - `Atomic write rejected` → state 14
- Every manual "Sync now" and interactive write goes through
  `sync.withLock` / `sync.syncNow`.

Acceptance:

- Tests with a fake `BackgroundSync` cover every permanent error string in
  `background.mjs` and map each to exactly one banner or pill state.
- `role="alert"` is used only for a banner that a sync raised.

Depends on: IT-2, IT-3, IT-4, IT-5.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-11 · Conflict review and resume (state 10)

The bridge throws `Conflict on <subject>: <fields>` and `background.mjs`
pauses. Nothing can currently resolve a conflict.

- Add a bridge call that resolves each field of each conflicting record to
  "local" or "remote", then resumes.
- Build the review panel from `mockups.html` frame 9: per-field Here / On
  GitHub choices, with the diff highlighted. "Apply and resume sync" stays
  disabled until every field has a choice.

If the resolution needs a change in the generic Devonian runtime
(`devonian/src/`) and not only in `devonian/github-issues/bridge.mjs`, that
part is outside this folder: split it out and ask first.

Acceptance:

- Bridge tests cover keeping local, keeping remote, and a mix across two
  fields. Nothing is sent before Apply.
- UI tests cover the disabled/enabled Apply button.

Depends on: IT-10.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 5).

## IT-12 · Uncertain write and missing record decisions (states 12, 13)

Add bridge and journal calls for:

- An uncertain write: "It landed" (mark the journal entry done, after a
  fresh read confirms it) and "Send again" (re-send once, and only by the
  user's explicit choice).
- A missing record: "Remove from board" (delete the local row after an
  inline confirmation, never touching GitHub) and "Keep here only" (unbind
  the external identity).

Build the banners from `mockups.html` frame 10.

Acceptance:

- Tests show that none of these actions runs automatically, that "Send
  again" can't run twice from one click, and that "Remove from board"
  issues no provider request.

Depends on: IT-10.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 6).

## IT-13 · devonian/github-issues lens: project labels, assignees, updated time and comment count

Today only `atomic:doing` is read from labels. Add read-only projected
properties:

- label names and colours (hiding `atomic:doing`)
- assignee logins
- `updated_at` as an exact timestamp string
- the comment count

Map them in `lens/resources.mjs`. They are never written back:
`unproject` must leave them out of the patch.

Acceptance:

- Lens tests cover the projection and show that `issuePatch` never contains
  these fields.
- Existing bridge snapshots still bind: a migration test, or a documented
  reason that no migration is needed.

Depends on: nothing.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 7).

## IT-14 · issue-tracker app: search, label filter, keyboard map and filter persistence

- Client-side search over title, number and labels (`/` focuses it).
- A Label filter menu.
- A count in the toolbar.
- The two empty states from `mockups.html` frame 8.
- A `?` overlay listing the shortcuts from DESIGN.md → Interactions.
- Filters persist on the App resource per installation, not in frame
  storage.

Acceptance:

- Tests cover the search match rules, the difference between the two empty
  states, persistence across `view()` calls with `fakeStore`, and that the
  shortcuts don't fire while a text field has focus.

Depends on: IT-7 or IT-8.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-15 · issue-tracker lane: e2e test of the app against the mock proxy

Add `integrations/issue-tracker/e2e/issue-tracker.spec.ts`, which covers:

- connect through the host consent bar
- pick a repository
- first import from `fixtures/github-issues/scenario.mjs`
- move a card to Done, and assert the mock recorded a close
- add a comment

Add the `e2e` tier and spec to the issue-tracker entry in
`integrations/lanes.json`. `lanes.json` is shared, so that one-line change
needs the maintainer's OK.

Depends on: IT-1, IT-6, IT-7. IT-9 for the comment step.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-16 · Jira Cloud as a read-only source (next scope)

Blocked on DESIGN.md → Decisions needed, item 2.

Outside this folder, and needing the maintainer's OK: a `jira` platform in
`overlays/catalog.json`, an auth overlay (Atlassian OAuth 2.0 3LO; requests
go to `api.atlassian.com/ex/jira/{cloudid}/…`, and the cloud id comes from
`accessible-resources`), and a CRUD Causality overlay.

First check whether `/rest/api/3/search/jql` pages with `nextPageToken`.
The existing `startAt` pagination overlay does not describe that.

Inside this folder:

- A Jira projection: summary, description (Atlassian Document Format →
  plain text), status category (`new`/`indeterminate`/`done` →
  Todo/Doing/Done, with the provider's status name kept for display), key,
  labels and assignee.
- The read-only detail from `mockups.html` frame 11.
- Enabling the Jira row in the source picker.

Acceptance:

- Projection tests with a scrubbed fixture.
- The ADF → text conversion covers paragraphs, lists, code and mentions.

Depends on: IT-1, IT-7, IT-9, and the maintainer's decision.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 9).

## IT-17 · Todoist as a read-only source in the app

Blocked on DESIGN.md → Decisions needed, item 4.

Use the existing `todoist.ts` projection:

- done → Done, otherwise Todo
- the priority label as a chip
- the due day on the card

Show it with the read-only detail variant.

Acceptance:

- Projection-to-card tests.
- The Todoist row in the source picker connects to the `todoist` platform.

Depends on: IT-1, IT-7, and the maintainer's decision.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md`.

## IT-18 · atomic-server: add a success colour to the plugin theme variables

`useCreateThemeVars.ts` has `alert` and `warning` but no success colour, so
every #89 app uses a literal fallback for `--pl-pos`. Propose
`--t-color-success` (light `#2f8f5b`, dark `#5cc48a`, or theme-derived) in
atomic-server, as a PR against `feat/plugin-debug`. Bump the pin in its own
PR afterwards.

This is an atomic-server change, not a change in this repo. It is filed
here only so it gets tracked.

Acceptance:

- The variable is present in the iframe's `__atomic_style` payload in both
  themes.

Depends on: nothing.

Refs #89. Design: `integrations/issue-tracker/design/DESIGN.md` (Gaps, item 10).
