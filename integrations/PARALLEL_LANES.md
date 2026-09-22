# Parallel plugin lanes

**Status: proposal, not implemented.** Nothing in `.github/workflows/ci.yml`,
`integrations/tooling/` or `integrations/localthought/mock-proxy.mjs` has been
changed to match this document yet. It describes the target shape so the work
can be split across several agents/worktrees without them colliding.

The goal: every package under `integrations/` gets its own CI lane and its own
locally reproducible server, so N plugins can be worked on at once without
sharing a job, a port, or a fixture.

## What exists today

`ci.yml` is one `test` job, `timeout-minutes: 75`, that does everything in
sequence: build atomic-server from the pinned commit, start it on `:9883`,
start `mock-proxy.mjs` on `:19090`, start `dev-server.mjs` on `:9880`, then run
lint, certification, unit tests, the notion live tier and two Playwright specs.
A `changes` job path-filters the diff and each per-plugin step carries its own
`if: needs.changes.outputs.<pkg> == 'true' || ... shared == 'true'`.

Three consequences this proposal addresses:

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
Add a `lanes.test.mjs` case asserting every directory under `integrations/`
that is not `tooling/` has a lane entry — that is the check that would have
caught `calendar/`.

## 2. Job graph: build once, fan out

The expensive part is `cargo build --profile e2e` plus `build.rs`'s embedded
frontend. That must not run once per lane.

```
        ┌──────────┐
        │ changes  │  path filter → lane matrix
        └────┬─────┘
             │
        ┌────▼─────────────┐
        │ build-server     │  pinned atomic-server → upload target/e2e binary
        │ (cache key =     │     + browser/data-browser/dist
        │  .atomic-server- │
        │  ref + vite env) │
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
  the `atomic-server` binary and the built `data-browser/dist`. Keyed on
  `.atomic-server-ref` plus a hash of the `VITE_*` values, it is a cache hit
  on every PR that does not bump the pin — which is almost all of them.
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

### The build-time constraint on ports

This is the one place the scheme does not come for free. `VITE_PLUGIN_CATALOG_URL`
and `VITE_INTEGRATION_PROXY_URL` are **baked into the frontend by `build.rs`**,
and ci.yml has an explicit step that greps `data-browser/dist` to prove it. A
binary built for `:9880` cannot be pointed at `:19051` at runtime. So:

- **`certify` / `unit` / `live` tiers** read their URLs from env at runtime
  (`ATOMIC_PORT`, `DEV_SERVER_PORT`, `MOCK_PROXY_PORT`, `ATOMIC_*_TEST_SERVER`).
  These are fully port-parameterized — run all seven lanes at once locally.
- **`e2e` tier** needs the baked URLs to match. Two options:
  - _CI_: keep one shared build using the canonical lane-0 URLs; every matrix
    job is a separate machine, so every e2e lane can bind the same ports. One
    build, N parallel e2e lanes.
  - _Locally_: one shared build means only **one** e2e lane at a time. Guard it
    with a lockfile (`flock integrations/.e2e.lock`) rather than letting two
    worktrees race for the port. If you genuinely need concurrent local e2e,
    build per-lane with that lane's ports in the `VITE_*` vars — the Rust
    compile is cached, only the Vite embed and the final link re-run.

Document that asymmetry loudly; it is the most likely thing to confuse someone
running two worktrees.

### Local runner

One entry point, so nobody hand-assembles the env:

```sh
node integrations/tooling/run-lane.mjs pets --tier e2e
```

It reads `lanes.json`, computes the ports, starts atomic-server (from a local
`ATOMIC_SERVER_CHECKOUT`, defaulting to the AGENTS.md `/tmp/atomic-server`
layout), starts the mock proxy with only that lane's `platforms`, starts the
dev-server, waits on all three, runs the tier, and tears down on exit. It must
also fail loudly if a port in its block is already bound, naming which other
lane owns that block — that is the port-clash symptom you actually want.

## 4. Mock fixtures per platform

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
  platform: PKCE, `/connect`, `/connect/redeem`, single-use connection codes,
  `X-Connection-Code` rotation, `redirect_uri` origin validation. Those are
  already correct and should not be duplicated per platform.
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
  becomes `pets/api/`. Then add the three with no fixture today: `todoist`,
  `moneybird`, `notion`.

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

## Open questions

- `certify.mjs` has no `--only` flag; adding one changes the report shape the
  `integration-certification` artifact publishes. Does anything downstream
  consume that report's structure?
- `browser/e2e/tests/plugins.spec.ts` covers Pets, Notion and GitHub in **one
  file**, which is why ci.yml gates it on three packages at once. Splitting it
  per lane means either `--grep` on prose test titles (fragile, as the comment
  there already notes) or splitting the spec upstream in atomic-server.
- `notion` is `enabled: false` in `catalog.json` but is the only package with a
  live tier. Confirm whether its lane should run e2e at all.
