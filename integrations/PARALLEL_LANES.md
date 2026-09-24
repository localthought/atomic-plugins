# Parallel plugin lanes

**Status: §§1–3 and §5 are implemented; §4 (fixtures) is half done.**
`integrations/lanes.json`, `integrations/tooling/lanes.mjs`,
`serve.mjs`, `run-lane.mjs` and the rewritten `.github/workflows/ci.yml`
are live. `integrations/localthought/mock-proxy.mjs` now loads a per-platform
fixture registry and honours `MOCK_PROXY_PLATFORMS`; recorded fixtures,
`record.mjs`, `fixture.test.mjs`, the three missing platforms and the drift
guard are not started. See §4.

The goal: every package under `integrations/` gets its own CI lane and its own
locally reproducible server, so N plugins can be worked on at once without
sharing a job, a port, or a fixture.

## What this replaced

`ci.yml` was one `test` job, `timeout-minutes: 75`, that does everything in
sequence: build atomic-server from the pinned commit, start it on `:9883`,
start `mock-proxy.mjs` on `:19090`, start `dev-server.mjs` on `:9880`, then run
lint, certification, unit tests, the notion live tier and two Playwright specs.
A `changes` job path-filtered the diff and each per-plugin step carried its own
`if: needs.changes.outputs.<pkg> == 'true' || ... shared == 'true'`.

Three consequences this addressed:

1. **No parallelism.** A one-line change to `integrations/pets/` still waits
   behind the Rust build _and_ behind every other plugin's steps in the same
   job. Wall-clock is the sum of all lanes, not the max.
2. **A red lane hides the rest.** `set -e` semantics mean the first failing
   step ends the job; you learn about one plugin's failure per run.
3. **Fixtures are hand-wired per platform.** `mock-proxy.mjs` dispatches on
   `platform` through an `if` chain (`github-issues` → `mock-github.mjs`,
   `google-calendar` → `mock-calendar.mjs`, `clockify` → `mock-clockify.mjs`,
   everything else → an inline `pets` array). `catalog.json` already ships
   `devonian-todoist`, `moneybird` and `notion` entries with no fixture at all,
   and `integrations/calendar/` (added in 42d0a7c) has no `changes` filter
   entry, so it is currently ungated.

## 1. One source of truth: `integrations/lanes.json`

Today the lane list is written out three times — the `changes` job's
`outputs:`, its `filters:`, and each step's `if:`. Adding `calendar/` meant
editing all three, and it was missed. Replace all three with one file that both
CI and the local runner read:

```json
{
  "portBase": 19000,
  "lanes": [
    {
      "id": "calendar",
      "index": 0,
      "platforms": ["google-calendar"],
      "tiers": ["unit"]
    },
    {
      "id": "issue-tracker",
      "index": 1,
      "platforms": ["github-issues", "todoist"],
      "tiers": ["unit", "e2e"]
    },
    {
      "id": "localthought",
      "index": 2,
      "platforms": ["pets", "github-issues", "google-calendar", "clockify"],
      "tiers": ["unit", "e2e"]
    },
    {
      "id": "money",
      "index": 3,
      "platforms": ["moneybird"],
      "tiers": ["certify"]
    },
    {
      "id": "notion",
      "index": 4,
      "platforms": ["notion"],
      "tiers": ["certify", "live", "e2e"]
    },
    {
      "id": "pets",
      "index": 5,
      "platforms": ["pets"],
      "tiers": ["certify", "e2e"]
    },
    {
      "id": "timesheets",
      "index": 6,
      "platforms": ["clockify"],
      "tiers": ["unit"]
    }
  ]
}
```

- `index` is **permanent** once assigned — it is what the port block is derived
  from (§3). Removing a lane leaves a hole; it does not renumber the others.
- `platforms` names which mock fixtures (§4) that lane's proxy must serve.
  Listing only what a lane needs keeps a fixture change from invalidating
  every lane's cache.
- `tiers` selects which of the four test tiers (§2) run.

The path filter for lane `<id>` is `integrations/<id>/**` by convention, so
`changes` can generate its `filters:` from this file rather than restating it.
A lane whose code imports a shared package from source adds an optional
`paths` array of globs inside `devonian/`, `syncables/` or `reflector/`
(`lanes.mjs` rejects anything else, in particular another plugin's folder),
so a change there still runs it: issue-tracker lists `devonian/src/**`
because `devonian/github-issues/` imports the `devonian` package. Those
globs also join the `any` filter, since `build-server` is gated on it.
Add a `lanes.test.mjs` case asserting every directory under `integrations/`
that is not `tooling/` has a lane entry — that is the check that would have
caught `calendar/`.

Two optional fields came later ([#134](https://github.com/ontola/atomic-plugins/issues/134)):

- `pluginRoutes`: a `--plugin-routes` level (`off`, `read-only`,
  `read-write`) or a list of distinct ones, for a lane that needs
  atomic-server built with the `plugin-routes` Cargo feature
  (`docs/design/server-plugin-routes.md`, section 0). Its live and e2e tiers
  run once per level, each on a fresh server started with
  `--plugin-routes <level> --routes-origin http://routes.localhost:<port>`,
  and the tests read `PLUGIN_ROUTES_LEVEL` and `PLUGIN_ROUTES_ORIGIN`. The
  binary comes from `tooling/server-build.mjs`: `ATOMIC_SERVER_ROUTES_BINARY`
  in CI, locally `~/.cache/atomic-plugins/atomic-server/<sha>-plugin-routes`,
  built on first use under a `<dir>.lock` lock. In CI only a run whose matrix
  holds such a lane starts `build-server-plugin-routes`, which pulls
  `ghcr.io/ontola/atomic-server-e2e:<sha>-plugin-routes` (the e2e image
  workflow's second variant) and builds from source only without it.
  `build-server` and the `:<sha>` image stay the default build. Lanes
  without the field are unchanged.
- `dir`: a tooling lane (not a plugin) lives in `integrations/tooling` or a
  directory under it instead of `integrations/<id>`. Its filter is only its
  `paths`, which must be listed and may name files under
  `integrations/tooling/`, `.atomic-server-ref` and shared packages. The
  `shared` filter does not select it, so a tooling change that it doesn't
  depend on doesn't run it; a merge-queue or manual run (`all`) does. The
  `plugin-routes` lane is one: it names its spec, its fixtures,
  `manifest-http.mjs`, `catalog-requires.mjs`, `server-build.mjs`,
  `serve.mjs`, `run-lane.mjs` and the pin, because each run costs a
  feature build or image pull. The node tests of those files run in
  shared-checks with every other tooling test.

## 2. Job graph: build once, fan out

The expensive part is `cargo build --profile e2e` plus `build.rs`'s embedded
frontend. That must not run once per lane.

```
        ┌──────────┐
        │ changes  │  path filter → lane matrix
        └────┬─────┘
             │
        ┌────▼─────────────┐
        │ build-server     │  pull ghcr.io/ontola/atomic-server-e2e:<pin>
        │                  │  (else build from source) → upload the
        │                  │  target/e2e binary
        └────┬─────────────┘
             │
   ┌─────────┼──────────┬──────────┬─────────┐
   ▼         ▼          ▼          ▼         ▼
 lane:     lane:      lane:      lane:     shared-checks
 pets      notion     money      ...       (lint, oxfmt,
                                            tooling tests,
                                            certify --layer js)
```

- **`build-server`** is gated on `changes.outputs.any` only. Its artifact is
  the `atomic-server` binary, with the data-browser frontend and its WASM
  embedded. It copies that binary out of
  `ghcr.io/ontola/atomic-server-e2e:<pin>`, which
  `atomic-server-e2e-image.yml` publishes once per pinned SHA (on push to
  main, on demand, and from a same-repo PR that bumps the pin). That takes
  about a minute. It builds from source (about 15 minutes, since the cargo
  cache doesn't carry over between PRs) only when no image exists for the
  pin. That is almost only a PR that bumps it, and only until the PR's own
  `publish-image` job has pushed one. The `CI` gate does not wait for
  `publish-image`: if it fails, later runs fall back to that source build.
- **`lane`** is `strategy: matrix: lane: ${{ fromJSON(needs.changes.outputs.lanes) }}`
  with **`fail-fast: false`**. That is the change that makes a run report every
  broken plugin instead of the first one.
- **`shared-checks`** keeps lint/format/`certify --layer js` unsharded. Per
  ci.yml's own reasoning these are not the cost, and `certify.mjs` reports
  per-package pass/fail in one pass anyway. Splitting them would multiply
  `pnpm install` without shortening anything.

Each `lane` job downloads the binary artifact, starts its own three processes,
and runs only its own tiers. Wall-clock becomes `build-server + slowest lane`
rather than the current sum.

### Test tiers

Ordered cheapest-first so a lane fails fast within itself:

| Tier      | Needs                                   | Command                                                                    |
| --------- | --------------------------------------- | -------------------------------------------------------------------------- |
| `certify` | nothing running                         | `node integrations/tooling/certify.mjs --layer js --only <id>`             |
| `unit`    | nothing running                         | `vitest run --config integrations/<id>/vitest.config.ts`                   |
| `live`    | atomic-server + dev-server + mock-proxy | `ATOMIC_<ID>_TEST_SERVER=http://localhost:$DEV_PORT vitest run --config …` |
| `e2e`     | all three + Playwright                  | `playwright test --config=browser/e2e/playwright.config.ts …`              |

`certify.mjs` needs a `--only <id>` flag it does not have today; without it
every lane re-certifies every package.

## 3. Port allocation

Every lane runs three listeners. In CI each matrix job is its own runner, so
fixed ports would not clash — but using the _same_ derived block in CI and
locally means the commands in a failed CI log paste straight into a terminal.

```
port(lane, role) = portBase + lane.index * 10 + roleOffset
roleOffset: atomic-server 0, dev-server 1, mock-proxy 2, 3–9 reserved
```

| Lane          | idx | atomic-server | dev-server | mock-proxy |
| ------------- | --- | ------------- | ---------- | ---------- |
| calendar      | 0   | 19000         | 19001      | 19002      |
| issue-tracker | 1   | 19010         | 19011      | 19012      |
| localthought  | 2   | 19020         | 19021      | 19022      |
| money         | 3   | 19030         | 19031      | 19032      |
| notion        | 4   | 19040         | 19041      | 19042      |
| pets          | 5   | 19050         | 19051      | 19052      |
| timesheets    | 6   | 19060         | 19061      | 19062      |

A block of 10 leaves room for a second server instance per lane (multi-tenant
tests) without renumbering.

### One binary, any ports

This used to be the one place the scheme did not come for free.
`VITE_PLUGIN_CATALOG_URL` and `VITE_INTEGRATION_PROXY_URL` were baked into the
frontend by `build.rs`, so a binary built for one port set could not be pointed
at another: every e2e run had to reuse one fixed port block, and locally only
one could exist at a time.

`atomic-server#1621` removed that. Both URLs were already runtime-overridable
through the `plugin-catalog-url` and `integration-proxy-url` localStorage keys
— the `VITE_*` vars only ever supplied the _default_ — and its
`playwright.config.ts` now seeds those keys through `storageState` from
`PLUGIN_CATALOG_URL` and `INTEGRATION_PROXY_URL`. `storageState` is applied
when the browser context is created, so the first script on the page already
sees them.

So every tier, e2e included, uses its lane's own derived block. One
`build-server` job's binary serves all of them, the lockfile is gone, and the
CI step that used to grep `data-browser/dist` for the baked literals is gone
with the bake.

Index 9 (`sharedIndex`) is reserved for the two CI jobs that are not a lane —
the hosting-surface check and the generic plugin-system suite — so they get a
block from the same formula rather than a second fixed one.

### Local runner

One entry point, and the same one CI uses:

```sh
node integrations/tooling/run-lane.mjs pets --tier e2e
node integrations/tooling/run-lane.mjs timesheets            # all its tiers
```

It reads `lanes.json`, computes the ports, and for a server-dependent tier
calls `serve.mjs` to start atomic-server (from `ATOMIC_SERVER_CHECKOUT`,
defaulting to the AGENTS.md `/tmp/atomic-server` layout), the mock proxy and
the dev-server, waits on all three, runs the tier, and tears down on exit.
Tiers run cheapest-first, so a lane fails before paying for a server it will
not reach.

Two failure modes are reported by cause rather than by symptom:

- a bound port names the lane that owns it, instead of an `EADDRINUSE` from
  whichever process lost the race;
- a missing `target/e2e/atomic-server` prints the `cargo build` line, instead
  of an async spawn `ENOENT` followed by the full readiness timeout.

With `ATOMIC_SERVER_IMAGE` set, `serve.mjs` runs that image with `docker run`
on the same port instead of the local binary, and pulls it first if it is
missing. See AGENTS.md, "Shared pinned atomic-server build".

## 4. Mock fixtures per platform

**Done:** the registry, the migration of the four existing platforms, and
`MOCK_PROXY_PLATFORMS`. Deviations from the design below:

- Fixtures live in their plugin's folder, not `integrations/tooling/fixtures/`:
  `integrations/<plugin>/fixtures/<platform>/` (`pets/fixtures/pets/`,
  `timesheets/fixtures/clockify/`, `issue-tracker/fixtures/github-issues/`,
  `calendar/fixtures/google-calendar/`). Everything specific to one plugin
  stays inside that plugin's folder, so plugins can be developed in parallel
  and a fixture change triggers only its own lane. Only the registry,
  `integrations/localthought/fixtures/index.mjs`, is shared; it imports each
  fixture by relative path. Caveat: atomic-server's dagger e2e pipeline
  copies only `integrations/localthought/` into its container, so it has to
  copy all of `integrations/` once it takes this layout.
- Each platform is one `scenario.mjs` whose default export declares `title`,
  `document` or `documentFile`, `jsonBody` and `create()`; see the registry.
  `pets` keeps its hand-written records in `pets/fixtures/pets/scenario.mjs`
  and its document next to it in `document.json`; no `api/` recordings exist
  for any platform yet.
- An unset or empty `MOCK_PROXY_PLATFORMS` serves every fixture, so callers
  that never set it (atomic-server's `e2e-server.sh` and dagger) are
  unchanged. A requested platform without a fixture is logged and skipped,
  not fatal: `issue-tracker`, `money` and `notion` lanes name `todoist`,
  `moneybird` and `notion`. `serve.mjs` does not start the mock at all for a
  lane whose `platforms` is `[]`; only the shared, non-lane stack (which
  passes no list) gets every fixture.
- `server.github`, `server.calendar` and `server.clockify` remain as aliases
  of `server.fixtures[<platform>]`, for atomic-server specs that use them.

**Not started:** `api/` recordings, `record.mjs`, `fixture.test.mjs`,
fixtures for `todoist` and `moneybird` (both need live credentials to
record, per the "enforced, not asserted" rule below), and the drift guard.
`notion` has an authored (not recorded) fixture,
`integrations/notion/fixtures/notion/`, whose catalog document is composed
from `integrations/notion/catalog/`; no lane requests it yet (#47, #68).

The original design:

Replace the `if (platform === …)` chain in `mock-proxy.mjs` with a fixture
registry. `mock-proxy.mjs` becomes a generic host; each platform becomes data
plus an optional behaviour module.

```
integrations/tooling/fixtures/
  <platform>/
    document.yaml        # the overlay doc the real proxy serves at /catalog/<platform>.yaml
    selection.json       # /catalog/<platform>.selection.json
    api/
      GET__issues.json         # recorded response bodies, one per method+path
      GET__issues__page-2.json
      POST__issues.json
    scenario.mjs         # optional: pagination, write-through, 429s, cursors
    record.mjs           # regenerates api/ against live credentials, redacted
    fixture.test.mjs     # asserts api/ still parses through that lane's adapter
```

- `mock-proxy.mjs` keeps ownership of the parts that are _protocol_, not
  platform: the integration proxy's 0.2 flow (#54 phase 2) — PKCE,
  `/connect`, `/connect/redeem` signed by the owner, connections,
  delegations and runtimes, v2 request signatures, frame capabilities —
  and `redirect_uri` origin validation (`localthought/README.md`). Those
  should not be duplicated per platform.
- `MOCK_PROXY_PLATFORMS=github-issues,todoist` restricts which fixtures load,
  so `/catalog` returns exactly that lane's platforms.
- **"Realistic" has to be enforced, not asserted.** `record.mjs` writes `api/`
  from a real call with a documented redaction list; `fixture.test.mjs` runs the
  recorded body through the lane's own adapter and fails if a field the adapter
  reads is missing. A hand-written fixture that the adapter happens to accept is
  how mocks drift into fiction.
- Migrate the three existing modules in place: `mock-github.mjs`,
  `mock-calendar.mjs`, `mock-clockify.mjs` become `scenario.mjs` under
  `github-issues/`, `google-calendar/`, `clockify/`; the inline `pets` array
  becomes `pets/api/`. Then add the two with no fixture today: `todoist` and
  `moneybird`. `notion` is excluded on purpose; see "Resolved while
  implementing this".

### Drift guard

The mock and the real `integration-proxy/` will diverge silently otherwise.
Add a **nightly** (not per-PR) lane that boots the real Rust
`integration-proxy` against the same `document.yaml` files and replays each
platform's `api/` recordings through it, asserting the same responses the mock
gives. Nightly rather than per-PR because it needs a Rust build this repo's PR
lanes otherwise avoid.

## 5. Working on N plugins at once

Worktrees are already in use here (five active). Per plugin:

```sh
git worktree add .claude/worktrees/<lane> -b feat/<lane>-<topic>
```

Rules that keep parallel worktrees from fighting:

- **One lane per worktree, one PR per lane.** A PR that touches two lanes gets
  both lanes' filters and loses the isolation this is for.
- **Never bump `.atomic-server-ref` from a plugin worktree.** It is a `shared`
  path: it forces every lane to run and invalidates `build-server` for all of
  them. Bump it in its own PR, merge it, rebase the rest.
- **Share one atomic-server checkout** across worktrees (`ATOMIC_SERVER_CHECKOUT`
  pointing at a single `/tmp/atomic-server`) so the cargo cache is shared. Only
  the e2e tier needs exclusive access to it (§3).
- Per AGENTS.md's worktree note: never bare `git stash`/`git stash pop` — the
  stack is shared across all of these.

## Resolved while implementing this

- **`certify.mjs` already takes `--integration <id>`** (mapped to its `only`
  option), so no `--only` flag was needed. It is not used per lane anyway:
  certification stays unsharded in `shared-checks` so the
  `integration-certification` report is published whole rather than in pieces.
- **`plugins.spec.ts` split cleanly after all**, and upstream did half of it.
  `atomic-server#1621` deleted its Pets and Notion tests; they live here now as
  `integrations/pets/e2e/` and `integrations/notion/e2e/`. Its two Clockify
  tests were deleted outright in `4bab16ee6` (#44). What remains upstream,
  the generic editor/sandbox tests, runs whole in the `e2e-plugin-system`
  job. Nothing is duplicated, and no `--grep` on prose test titles was
  needed.
- **`notion` is `enabled: false` in `catalog.json`** but keeps both a live and
  an e2e tier: the catalog flag gates whether the card is _offered_ to
  visitors, not whether the package works. Revisit if it is ever removed.
- **The `notion` lane has no mock-proxy platform** (`"platforms": []`, #47).
  Neither of its tiers talks to the lane's mock proxy.
  `integrations/notion/e2e/notion.spec.ts` points `integration-proxy-url` at
  its own `https://notion-proxy.test` origin and answers `/catalog` and
  `/proxy/notion/**` with `page.route`. `atomic.live.test.ts` stubs `fetch`
  in-process. Moving the spec onto the shared mock would take three things.
  First, a `fixtures/notion/`: an authored, read-only one now exists
  (`integrations/notion/fixtures/notion/`); a recording against a live Notion
  workspace (§4) does not. Second, a test-control channel into the mock, which `serve.mjs` runs as a
  separate process: mid-test the spec returns 401 from `/v1/search`, asserts
  the PATCH body, and edits the remote page, and `server.fixtures[...]`
  drivers only work in-process. Third, driving a real `/connect` +
  `/connect/redeem` handoff, because the mock rejects the seeded
  `fixture-code`. Until someone does all three, an empty list keeps the lane
  from requesting a fixture that does not exist. Note that under the fixture
  registry an empty `MOCK_PROXY_PLATFORMS` serves every fixture. That is
  harmless here, since nothing in the lane calls the mock.

## Still open

- **Quarantined e2e.** None of the lane e2e tiers are held back any more.
  `pets` (#52) and `notion` (#68) are back: both drive their drive app in its
  plugin iframe through `store.proxy`, which since #54 phase 2 needs an
  `.atomic-server-ref` with frame capabilities (ontola/atomic-server#1697)
  and the v2 request signatures (#1696): the mock proxy refuses the older
  relay's rotating connection codes. The pin, `11264e83e` on
  `claude/atomic-plugins-pin-phase2`, has both. The `e2e-plugin-system` job
  is required again since #71.
- **`timesheets`' e2e is new, not moved.** The upstream Clockify tests were
  deleted in atomic-server `4bab16ee6` (in the pin), together with the UI
  they drove (#44). `integrations/timesheets/e2e/clockify.spec.ts` (#96)
  drives the timesheets drive app through `store.proxy` instead, with a
  test-side install until #94. See
  [`HANDOFF-e2e-split.md`](HANDOFF-e2e-split.md).
- `integrations/money/` has one tier, `e2e` (#95): `money.spec.ts` drives
  the Bank statements importer through atomic-server's generic file entry
  point (manifest `accepts`/`destination`, the PluginPage Import tab;
  atomic-server#1653, merged as #1691 and in the pin). There is still no `typecheck`/`unit` tier on purpose (#45):
  `certify.mjs --layer js` in `shared-checks` already runs exactly
  `tsc -p integrations/money/tsconfig.json` and
  `vitest run --config integrations/money/vitest.config.ts`, plus bundle
  reproducibility, on every `integrations/**` change. The lane names
  `moneybird`, but nothing in `integrations/money/` runs Moneybird code; the
  `moneybird` entry in `catalog.json` (`requires-api-plugins`) is read by
  atomic-server's generic API-plugin path. A Moneybird fixture and its
  recorder go in `integrations/money/fixtures/moneybird/`, not
  `integrations/localthought/fixtures/`: anything specific to one plugin
  stays in that plugin's folder. The shared registry,
  `integrations/localthought/fixtures/index.mjs`, then registers it as
  `moneybird` by importing `../../money/fixtures/moneybird/scenario.mjs`.
  Recording one needs a Moneybird account.
- `todoist` and `moneybird` have no mock fixture, so a lane that names them
  gets a mock proxy serving only its other platforms (possibly none).
  Recording them needs live credentials; see §4. `notion` needs none: both
  its tiers stub their own proxy (#47).
