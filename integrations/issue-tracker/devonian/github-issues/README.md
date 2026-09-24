# Devonian GitHub issues lens

This package contains the GitHub issue and comment lens used by the browser
demo. It depends on Devonian's generic native Atomic resource API and receives
the host runtime, connector ports, credential transport, and persistence from
the caller.

The stable entry point is `createBridge(host, options)` from `index.mjs`.
Hosts select the package by the versioned `descriptor.json`; provider code is
kept beside the lens and is never imported by Devonian's generic runtime.

It lives in the issue-tracker plugin folder (it was
`devonian/platform-lenses/github-issues/` in the `devonian` package up to
0.6.1). It imports Devonian as the `devonian` package, and the host modules
(`@integration-host/*`) and `@tomic/lib` from the host; in this repo
`../../vitest.config.ts` aliases all of them, `devonian` to its source in
`devonian/src/` and the rest to the linked atomic-server checkout. All its
tests run in the issue-tracker lane:

```sh
./browser/node_modules/.bin/vitest run --config integrations/issue-tracker/vitest.config.ts devonian/github-issues
```

`devonian` must have its own dependencies installed first
(`cd devonian && pnpm install --frozen-lockfile`). The two `*.live.test.ts`
suites skip unless their environment variables are set.

Pure forward/reverse mappings live in `lens/` (entry point `lens/index.ts`). `project` reads GitHub issues;
`unproject` writes the projection back onto a supplied issue without dropping
unmanaged fields. `issueFields` and `issuePatch` are used by the existing runtime.
`lens/resources.mjs` holds the bridge's bidirectional Atomic property mapping.
The adapter re-exports its previous mapping API for compatibility. The bridge,
ports, proxy, and plugin continue to own effects and synchronization state.

## Background sync

`createBackgroundSync({ openBridge, store, intervalMs, locks?, name? })` from
`background.mjs` (also exported from `index.mjs`) keeps a connection
syncing on a persisted schedule, so a pass that fell due while the tab was
closed runs at the next opportunity instead of waiting for someone to click
"Sync". It wraps Devonian's generic `BackgroundSync` (see the package
README) with this lens's error classification.

- `openBridge()` must build a new `Bridge` from the persisted snapshot on
  every call. A cached Bridge would reconcile from a stale checkpoint once
  another context (tab, service worker) has synced.
- `store` holds the schedule (`nextDueAt`, `failures`, `lastError`,
  `paused`) as JSON, keyed by `name` (default `github-issues`; use one name
  per connection). Pass the IndexedDB database that already holds the bridge
  snapshot and transport journal, so every context sees the same schedule.
- Every pass holds a lease (`navigator.locks` by default, so it is shared by
  tabs and the service worker and released when a context dies). Run a
  manual "Sync now" or an interactive write through `sync.withLock(fn)` or
  `sync.syncNow()` too, so two contexts never write the same connection at
  once. `sessionStorage` is invisible to a service worker.
- Transient failures back off exponentially: `intervalMs`, then 2×, 4×, …,
  up to `maxBackoffMs` (default: one hour, or `intervalMs` if that is
  longer). Failures that need a person pause the schedule until `resume()`:
  the Bridge's `Conflict…`, `Concurrent edit after write`,
  `Missing … record`, `State belongs to another connection`, `Duplicate …`;
  the Atomic port's `Recovered Atomic create was edited` and
  `Atomic write rejected`; and the transport's `Uncertain GitHub write`,
  `Operation identity reused`, a connection that is no longer delegated to
  the app (`No … connection … is delegated to this app`), and GitHub
  `401`. The list is `permanentSyncErrors`. Nothing is retried in a
  loop, and neither side is modified while paused.

A browser host wires three triggers into the same `BackgroundSync`:

```js
// Page: check while any tab is open (only due passes run).
sync.start(60_000);
// Page, once: ask the browser to wake the service worker.
await registerBackgroundSync(
  await navigator.serviceWorker.ready,
  'github-issues',
  60 * 60_000,
);
// Service worker: build the same sync from IndexedDB, then
self.addEventListener('periodicsync', e =>
  handleBackgroundSyncEvent(e, sync, 'github-issues'),
);
self.addEventListener('sync', e =>
  handleBackgroundSyncEvent(e, sync, 'github-issues'),
);
```

**What this does not do (yet).** It does not bring back the removed Rust
pilot's "every minute with the browser closed":

- Periodic Background Sync is Chromium-only. It needs an installed PWA with
  the `periodic-background-sync` permission, and the browser chooses the
  cadence (`minInterval` is only a lower bound; expect hours). One-shot
  Background Sync is also Chromium-only and fires only when connectivity
  returns.
- Firefox and Safari have neither, so the schedule only advances while a tab
  is open. It still catches up at once when a tab reopens.
- Minute-level polling with no browser running needs a non-browser host
  running this same `BackgroundSync` (with `FileKvStore` or similar, and
  `processLocks()` or a cross-process lock). That host also needs an Atomic
  port that enumerates and writes the user's drive over the network instead
  of `queryLocalDb`. That port does not exist yet, so no such host is
  provided.
- No service worker ships here. The consuming application (atomic-server's
  data-browser) owns its worker, IndexedDB schema and UI for `status()` /
  `resume()`, and none of that is wired up yet. Coverage is unit tests with
  deterministic fakes (`background.test.mjs`,
  `__tests__/unit/background/`). It has not been run in a real browser or
  service worker.

## Example: a GitHub issue and its comments

Here is a representative GitHub issue response, together with two entries from
its separate comments endpoint. The outer `issue` / `comments` wrapper is only
for this example; GitHub returns them through separate requests.

```json
{
  "issue": {
    "number": 42,
    "title": "Keep the selected calendar after refresh",
    "body": "Refreshing the page resets the selection to **All calendars**.",
    "state": "open",
    "labels": [{ "name": "bug" }, { "name": "atomic:doing" }],
    "html_url": "https://github.com/example/calendar/issues/42"
  },
  "comments": [
    {
      "id": 101,
      "body": "I can reproduce this in Firefox.",
      "issue_url": "https://api.github.com/repos/example/calendar/issues/42",
      "user": { "login": "alice" },
      "html_url": "https://github.com/example/calendar/issues/42#issuecomment-101"
    },
    {
      "id": 102,
      "body": "The fix is ready for review.",
      "issue_url": "https://api.github.com/repos/example/calendar/issues/42",
      "user": { "login": "bob" },
      "html_url": "https://github.com/example/calendar/issues/42#issuecomment-102"
    }
  ]
}
```

The corresponding Atomic representation is a graph of three resources: one
tracker row and two native `Message` resources linked to it through `about`.
Comments are not embedded in the issue object. This JSON-AD example shows the
content and membership properties written through `AtomicPort`; runtime identity
and provenance bookkeeping are omitted.

The `https://example.com/atomic/...` subjects below are illustrative,
installation-specific identities. The tracker row class and GitHub-number
property are configured by the installation; there is no fixed global issue
class in this mapping. The `https://atomicdata.dev/...` properties and status tag
are the native Atomic vocabulary actually used by the implementation.

```json
[
  {
    "@id": "https://example.com/atomic/issues/issue-a",
    "https://atomicdata.dev/properties/isA": [
      "https://example.com/atomic/schema/github-issue"
    ],
    "https://atomicdata.dev/properties/parent": "https://example.com/atomic/issues",
    "https://atomicdata.dev/properties/name": "Keep the selected calendar after refresh",
    "https://atomicdata.dev/task/v1/body": "Refreshing the page resets the selection to **All calendars**.",
    "https://atomicdata.dev/task/v1/status": [
      "https://atomicdata.dev/task/v1/doing"
    ],
    "https://example.com/atomic/schema/github-issue-number": 42
  },
  {
    "@id": "https://example.com/atomic/comments/comment-a",
    "https://atomicdata.dev/properties/isA": [
      "https://atomicdata.dev/classes/Message"
    ],
    "https://atomicdata.dev/properties/parent": "https://example.com/atomic/comments",
    "https://atomicdata.dev/properties/about": "https://example.com/atomic/issues/issue-a",
    "https://atomicdata.dev/properties/description": "I can reproduce this in Firefox."
  },
  {
    "@id": "https://example.com/atomic/comments/comment-b",
    "https://atomicdata.dev/properties/isA": [
      "https://atomicdata.dev/classes/Message"
    ],
    "https://atomicdata.dev/properties/parent": "https://example.com/atomic/comments",
    "https://atomicdata.dev/properties/about": "https://example.com/atomic/issues/issue-a",
    "https://atomicdata.dev/properties/description": "The fix is ready for review."
  }
]
```

The field correspondence is:

| GitHub                               | Atomic tracker representation                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------- |
| Issue `title`                        | `https://atomicdata.dev/properties/name`                                                |
| Issue `body`                         | `https://atomicdata.dev/task/v1/body`                                                   |
| Open issue with `atomic:doing` label | Status `[https://atomicdata.dev/task/v1/doing]`                                         |
| Open issue without that label        | Status `[https://atomicdata.dev/task/v1/todo]`                                          |
| Closed issue, regardless of labels   | Status `[https://atomicdata.dev/task/v1/done]`                                          |
| Issue `number`                       | Installation's GitHub-number property, kept as a number                                 |
| Comment `body`                       | Message `https://atomicdata.dev/properties/description`                                 |
| Comment's issue association          | Message `https://atomicdata.dev/properties/about`, pointing to the Atomic issue subject |

The pure issue lens first produces
`{ title, body, status: 'Doing' }`; the resource mapping expresses those fields
using Atomic property URLs. The bridge temporarily represents comment bodies
with the task body property internally, while `AtomicPort` writes native Messages
using `description` and `about`, as shown above.

In the reverse direction, editing the Atomic title/body updates the corresponding
GitHub fields, changing the status to Done closes the issue, and editing a
Message's description updates its linked GitHub comment. Unrelated labels such
as `bug` remain outside the mapped fields. GitHub comment IDs and issue numbers
are bound to Atomic subjects within their repository/entity scopes, rather than
being inferred from text or array positions. Author names and source URLs are
retained as metadata through the configured provenance property; they are not
turned into Atomic authorship claims. Atomic's Blocked status is not mapped.

## Target drive

`AtomicPort` writes into whatever drive `config.connection.drive` names. That
drive can be a browser-only drive or the user's real drive on AtomicServer.
`target.mjs` decides how far the browser's copy of that drive can be trusted.
It asks the store again on every call, because `store.promoteLocalDrive` can
turn a local-only tracker into a synced one after it was set up.

| Drive kind   | How it is detected              | Enumeration (`queryLocalDb`)                       | A write counts as done when                                                   |
| ------------ | ------------------------------- | -------------------------------------------------- | ----------------------------------------------------------------------------- |
| `local-only` | `store.isLocalOnlyDrive(drive)` | Always authoritative                               | `save()` resolves without returning `'offline'`                               |
| `synced`     | Any other drive                 | Only after `store.hasCompletedDriveSyncFor(drive)` | `store.getSaveState(resource).kind === 'idle'` (AtomicServer acknowledged it) |

On a synced drive, `AtomicPort` throws instead of guessing in three cases:

- `Atomic drive has not finished syncing: <drive>`: the drive's local index
  may still be incomplete. This is transient; retry after the drive sync.
  Enumerating early could miss a row that `findByLocalId` would otherwise
  recover, and that would create a duplicate.
- `Atomic write not acknowledged: <subject>`: the write is queued or still in
  flight. This is transient. The Bridge's saved operation resumes on the next
  sync. A retried create finds the queued resource by `localId` and reuses it.
- `Atomic write rejected: <subject>: <message>`: AtomicServer refused the
  commit, for example because the agent lacks write rights. This is permanent;
  a person must fix the rights or the data first.

A store that lacks these predicates is treated as `synced`, not ready, and not
acknowledged, so it fails closed. `AtomicPort.scope` is still keyed by the table
subject (`devonian-local/<table>`). Bridge snapshots saved before this change
therefore still bind.

`provisionTracker(store, { drive, repository, buildTable })` sets up a tracker
in an existing drive of either kind. It creates the table through the
host-supplied `buildTable(trackerTableSpec)`, which in atomic-server is
`buildTableFromSpec`. It also creates the `GitHub source` provenance property,
and a Comments folder only when the drive has no `commentsFolder` yet. If the
drive already has one, it is reused, never replaced. On a real drive that folder
holds the user's other comments.

`trackerStateKey({ agent, drive, repository, mode })` builds the IndexedDB key
for a tracker. Because it includes the drive, trackers in different drives never
share a bridge snapshot or write journal.

### Host integration

The current host is the issue-tracker **drive app**
([`../../app/`](../../app/), see the plugin README's "Drive app"). It runs
this Bridge unchanged in the host's null-origin frame:

- `proxyTransport` with `dispatch` over the host's `store.proxy.request`.
  Since ontola/atomic-plugins#54 phase 2 the frame calls the integration
  proxy itself, with a short-lived capability from the host page and a key
  only the host's frame client holds; this lens never sees a credential.
  `proxyTransport` has no other transport any more.
- `AtomicPort` over an adapter (`app/frameStore.ts`) that gives the frame's
  `PluginStore` the store predicates `target.mjs` reads, and corrects for
  the host's reads lagging the app's own writes.
- Snapshot and journal as JSON text on a resource in the app's own subtree,
  not IndexedDB (a null-origin frame has none), so neither
  `provisionTracker`/`buildTable` nor `trackerStateKey` nor `background.mjs`
  is used there: the app creates its columns itself, one app is one
  repository, and it syncs only while open.
- `reviewGate` (`review.mjs`) in front of the GitHub port: provider writes
  wait for a person's approval, and `bridge.held` lists them.
  `Bridge.resolveConflict(subject, keep)` settles a same-field conflict.

atomic-server's earlier browser demo (`DevonianDemo/demo.mjs` and
`DevonianDemoRoute.tsx`) was removed in ontola/atomic-server#1612. A
data-browser host that targets the user's real drive directly, with
IndexedDB, would still:

- Call `provisionTracker` on an existing drive, such as `store.getDrive()`,
  instead of creating a new drive and calling `registerLocalOnlyDrive`.
- Pass its own table builder as `buildTable`.
- Key its saved state with `trackerStateKey`.

The earlier demo's design notes are in atomic-server's
`planning/devonian-reconnect.md`.

### Review and recovery (`review.mjs`, `Bridge`)

- `reviewGate(port, approved)` wraps a provider port. `create`/`update`
  throw `ReviewRequired` before any request unless
  `proposalKey(entity, id, value)` is in `approved`. The key covers the
  content, so an approval survives re-planning but not an edit.
- `Bridge.sync()` records a held write in `bridge.held` (subject, entity,
  remote id, before/after) and carries on with the rest of the pass. A held
  write never sent anything, so the next pass plans it again from both
  sides. A saved operation that is held when it resumes was let through
  before and may have reached the provider: it is flagged `unconfirmed`.
  Creates keep their provider key across re-planning, so the journal still
  refuses to resend one whose response was lost.
- Conflict errors carry `subject`, `entity` and `fields`.
  `resolveConflict(subject, 'local' | 'remote')` moves only those fields'
  baseline to the other side's current value, writes nothing, and lets the
  next pass carry the kept side over.
- `proxyTransport`'s `dispatch` errors keep the host's message. Only an
  error marked `notSent` drops the journal entry; anything else leaves the
  write uncertain.

### Not yet verified or supported

- The drive-kind handling is covered only by unit tests with fake stores. It has
  not been run in a browser against a real AtomicServer.
- Sync still runs only in a browser tab, because enumeration relies on that
  tab's local index. A host with no browser open, such as a Node process, would
  need an `AtomicPort` that enumerates through AtomicServer's `/query` instead.
  No such port exists yet. Issue #10 covers background scheduling.
