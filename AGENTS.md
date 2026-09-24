# Working in this repo

This repo holds four independent things — read the section for whichever
one you're touching before making changes.

## integrations/

This is `ontola/atomic-server`'s `integrations/` folder, extracted for fast
iteration. It is **not buildable or testable on its own**: every package
imports from `../../browser/lib/src/...`, which only exists inside a full
`atomic-server` checkout. `.atomic-server-ref` pins the upstream commit this
folder is meant to sit on top of. CI checks that commit out next to this repo
and symlinks its `browser/` in as `./browser` (gitignored), which is all the
relative imports need. One script does the same locally, and CI runs that same
script, so the two setups cannot drift. Run it from the repo root (in any
worktree) before running any command below:

```sh
node integrations/tooling/link-atomic-server.mjs
```

This shallow-fetches atomic-server at `.atomic-server-ref` into
`$ATOMIC_SERVER_CHECKOUT` (default `/tmp/atomic-server`, the default
`run-lane.mjs`/`serve.mjs` also use; one checkout serves every worktree). It
then symlinks `browser` and `integrations/node_modules`, and runs `pnpm
install --frozen-lockfile` in its `browser/` (pnpm 10, per its
`packageManager`). It refuses to move a checkout that has uncommitted changes.
Re-run it after `.atomic-server-ref` changes. `--check` verifies the layout
without changing anything, and `run-lane.mjs` warns when `browser/` points at
a checkout on some other commit. After that:

```sh
node integrations/tooling/run-lane.mjs calendar --tier typecheck   # or --tier unit; one package
node integrations/tooling/certify.mjs --layer js                   # every package: typecheck, bundle, tests
```

The live/e2e tiers additionally need the atomic-server binary built once in
that checkout (`serve.mjs` prints the exact `cargo build` line).
`integrations/localthought`'s `wasm-smoke.mjs` needs a `wasm-pack` build
of atomic-server's `wasm/` crate, which neither the script nor CI provides.
Details: [Local setup](integrations/README.md#local-setup).

Everything else — the contributor checklist, certification command, config
declaration convention, permissions/recovery model, live-testing contract —
lives in [`integrations/README.md`](integrations/README.md) and its
companion docs ([`ACTIONS.md`](integrations/ACTIONS.md),
[`AUTHORIZATION.md`](integrations/AUTHORIZATION.md),
[`LIVE_TESTING.md`](integrations/LIVE_TESTING.md)). Read that before adding
or changing a package under `integrations/`; this file only orients you
towards it and towards the two plugin shapes below.

## Two plugin runtimes

`integrations/<name>/` packages are one of two fundamentally different
things. Pick the right one before writing code:

1. **Server-executed sandbox plugins** — a bundled `plugin.js` with a
   `manifest` and a `run(ctx)`, executed server-side in a QuickJS/WASM
   sandbox against scoped `ctx.query`/`ctx.read`/`ctx.http`/`ctx.config`.
   File-upload importers (**Bank statements**, `integrations/money/`) and
   most existing integrations (`pets`, `issue-tracker`, `notion`) are this
   shape. See [Building an uploader plugin](integrations/README.md#building-an-uploader-plugin).
2. **Browser-only LocalThought/Devonian connectors** — no server sandbox,
   no AtomicServer HTTP dependency; runs entirely client-side. This repo
   provides `BrowserIntegrations` (`integrations/localthought/browser.ts`) —
   OAuth/PKCE and the rotating-code authenticated proxy call, nothing more;
   `atomic-server` composes a syncables/reflector sync engine on top of it,
   optionally with a Devonian lens for local-first two-way sync.
   `integrations/localthought/`, `integrations/timesheets/`, the
   GitHub issues lens at `integrations/issue-tracker/devonian/github-issues/`
   and the Google Calendar lens at
   `integrations/calendar/devonian/google-calendar/` are this shape. See
   [Building a LocalThought (reflector/syncables/Devonian) connector](integrations/README.md#building-a-localthought-reflectorsyncablesdevonian-connector).

Do not mix the two: a sandbox plugin never reaches the network itself for a
LocalThought-flow provider, and a browser connector is never loaded into the
QuickJS sandbox.

## devonian/

Unlike `integrations/`, `devonian/` is a self-contained, independently
buildable and publishable TypeScript package (own `package.json`,
`pnpm-lock.yaml`, `tsconfig.json`) migrated in from the standalone
`localthought/devonian` repo, full commit history included via `git
subtree`. It publishes to npm as `devonian` and is what
`integrations/localthought/`, `integrations/timesheets/`, and
`integrations/issue-tracker/devonian/github-issues/` depend on for the
reflector/syncables lens engine described above. A plugin's own lens lives in
its plugin folder, at `integrations/<plugin>/devonian/<platform>/`, and
imports `devonian` as a package, never by relative path into `devonian/src`;
no lens is left inside the package. See [`devonian/AGENTS.md`](devonian/AGENTS.md)
and [`devonian/README.md`](devonian/README.md) for its own conventions —
they are unrelated to the style notes below, which apply to `integrations/`
only. Its CI and publish workflows are
[`.github/workflows/devonian-ci.yml`](.github/workflows/devonian-ci.yml) and
[`.github/workflows/devonian-publish.yml`](.github/workflows/devonian-publish.yml).

## reflector/

Unlike `integrations/`, `reflector/` is a self-contained, independently
buildable TypeScript package (own `package.json`, `pnpm-lock.yaml`,
`tsconfig.json`) migrated in from the standalone `localthought/reflector`
repo, full commit history included via `git subtree`. It is the
sync-engine/plugin-runtime layer described above as **Reflector** — one
level above the syncables engine (see `syncables/` below; `atomic-server`
depends directly on a separate Rust port of it for its browser/WASM build,
not on anything in this repo). See [`reflector/CLAUDE.md`](reflector/CLAUDE.md) and
[`reflector/README.md`](reflector/README.md) for its own conventions — they
are unrelated to the style notes below, which apply to `integrations/` only.
Its CI and publish workflows are
[`.github/workflows/reflector-ci.yml`](.github/workflows/reflector-ci.yml)
and
[`.github/workflows/reflector-publish.yml`](.github/workflows/reflector-publish.yml).
`reflector/package.json`'s `"name": "reflector"` is not yet publishable as
written — that name is already taken on npm by an unrelated package; see the
comment at the top of `reflector-publish.yml`.

## syncables/

Unlike `integrations/`, `syncables/` is a self-contained, independently
buildable and publishable TypeScript package (own `package.json`,
`package-lock.json`, `tsconfig.json`) migrated in from the standalone
`localthought/syncables` repo, full commit history included via `git
subtree`. It publishes to npm as `syncables` — already the same package
this same maintainer publishes today, just moving where the source lives.
See [`syncables/CLAUDE.md`](syncables/CLAUDE.md) and
[`syncables/README.md`](syncables/README.md) for its own conventions —
they are unrelated to the style notes below, which apply to `integrations/`
only. Its CI and publish workflows are
[`.github/workflows/syncables-ci.yml`](.github/workflows/syncables-ci.yml)
and
[`.github/workflows/syncables-publish.yml`](.github/workflows/syncables-publish.yml).

`integrations/localthought/` used to also vendor a Rust port of this same
upstream project ("syncables-rs") at `integrations/localthought/syncables/`,
for `atomic-server`'s `wasm/Cargo.toml` to depend on by path. That vendoring
has been removed from this repo entirely — `atomic-server`'s WASM build
depends on it, so it belongs there, not here. See the "Building a
LocalThought" section of
[`integrations/README.md`](integrations/README.md#building-a-localthought-reflectorsyncablesdevonian-connector)
for the fuller architecture note, and the `describeIntegration`/
`fetchIntegration` machinery that depended on it, likewise removed from
[`integrations/localthought/browser.ts`](integrations/localthought/browser.ts).

## overlays/

Unlike `integrations/`, `overlays/` is not a package: it is a folder of
OpenAPI Overlay documents plus `catalog.json`, migrated in from the
standalone `localthought/overlays` repo, full commit history included via
`git subtree`. GitHub Pages publishes this repository's `main` from its root
(the root `.nojekyll` keeps files byte-for-byte), so `overlays/<path>` is
served at `https://ontola.github.io/atomic-plugins/overlays/<path>` —
`catalog.json` references its overlays by those URLs, and
`integration-proxy`'s default `CATALOG_PATH` is that folder's
`catalog.json`. Those URLs are not pinned to a commit: a merge to `main`
changes what the proxy composes at its next start. See
[`overlays/README.md`](overlays/README.md) for the publication model and its
checks. Its CI is
[`.github/workflows/overlays-ci.yml`](.github/workflows/overlays-ci.yml);
[`.github/workflows/overlays-published.yml`](.github/workflows/overlays-published.yml)
checks Pages after each build. Keep the root `.nojekyll`: without it Pages
runs the whole repository through Jekyll, which skips `_`-prefixed paths,
renders files with front matter instead of serving them as-is, and fails the
whole publish if any file in the repository breaks the Jekyll build.

## Style notes for docs and code in `integrations/`

- Prose here is precise and hedged, not marketing copy: state exact limits
  (record counts, byte sizes, timeouts), name what is *not* yet verified,
  and give exact copy-pasteable commands rather than "run the tests."
- Every `.ts` source file starts with `// @wc-ignore-file`.
- Amounts, dates and other precision-sensitive values are exact strings,
  never floats.
- A capability is "declared", not "verified", until it has current live
  evidence (`integrations/README.md`'s certification command explains the
  distinction) — keep that language when writing catalog copy or docs.

## Agent collaboration

Several Claude Code sessions and their subagents work on this repo at the
same time. These are the working agreements between them.

### Roles

- **Repo oversight.** One long-lived session watches all open issues,
  picks up new ones, starts agents for them, and does every GitHub write:
  pushing, opening PRs, merging, filing and closing issues, and commenting.
  Subagents can't push or open PRs, because a relayed approval doesn't count
  as the user's approval. So a subagent commits in its own worktree and
  reports back, and the oversight session publishes the work.
- **Plugin oversight (optional).** When one plugin has several issues in
  flight, the repo oversight can hand that plugin to a separate session.
  That session is a peer session, not a subagent, so it can push. It owns
  `integrations/<plugin>/` and its issues. It asks the repo oversight about
  anything outside that folder.
- **Workers.** These are short-lived subagents, one per issue or task. Each
  runs in an isolated worktree and writes a plan first
  (`plans/<topic>.md` in the oversight session's scratchpad). It checks
  sibling plans for overlap before writing code.

### Issue comments

- **When work starts,** comment on the issue with who is working on it: the
  session name and short id (for example "atomic-plugins oversight
  `e6ce43`"), plus the workflow run id or branch if there is one.
- **When work pauses on a blocker,** comment again. Say what the blocker is
  and who can remove it: the user, an atomic-server review, a pin bump,
  credentials or a recording.
- **When a PR resolves an issue,** put `Closes #N` in the PR body. If an
  issue stays open after partial work, leave a hand-off comment that lists
  the remaining steps.

### Boundaries

- Keep each plugin inside its own folder (see "Two plugin runtimes" and
  `integrations/README.md`). Moving shared code out of plugin folders needs
  the user's decision.
- Never merge ontola/atomic-server PRs; they are reviewed by its
  maintainer. Pin `.atomic-server-ref` to a commit SHA instead, which may be
  on an unmerged branch.
- Merge an atomic-plugins PR only after the required `CI` check passes.
  Never bypass it with admin rights.
- Never pop the shared git stash. Use a WIP commit instead.

### Shared pinned atomic-server build

Building the atomic-server e2e binary takes about 10 minutes, and each
worktree that ran the e2e tier used to build its own. Share one build per
pinned SHA instead. It lives at a stable path outside any session
scratchpad, because scratchpads are per session:

```sh
SHA=$(cat .atomic-server-ref)
DIR=~/.cache/atomic-plugins/atomic-server/$SHA
if [ ! -x "$DIR/target/e2e/atomic-server" ]; then
  git -C ~/gh/ontola/atomic-server fetch origin
  [ -d "$DIR" ] || git -C ~/gh/ontola/atomic-server worktree add --detach "$DIR" "$SHA"
  (cd "$DIR/wasm" && rustup target add wasm32-unknown-unknown \
    && cargo bin wasm-pack build --target web --out-dir pkg --no-opt \
    && cp pkg/atomic_wasm.js pkg/atomic_wasm_bg.wasm ../browser/data-browser/public/wasm/)
  (cd "$DIR" && SKIP_WASM_BUILD=1 VITE_E2E=true cargo build --profile e2e \
    -p atomic-server --no-default-features --features wasm-plugins)
fi
export ATOMIC_SERVER_CHECKOUT=$DIR
node integrations/tooling/link-atomic-server.mjs
```

`link-atomic-server.mjs` only symlinks into the checkout; it doesn't write to
it, apart from `pnpm install` in `browser/`. `run-lane.mjs` and `serve.mjs`
read the same `ATOMIC_SERVER_CHECKOUT`, so keep it exported while you run
lanes.

- Treat `$DIR` as read-only once it's built. Never commit in it or change
  its checkout, because other sessions may be using it at the same moment.
- If you need atomic-server changes, make them in a separate worktree on a
  branch.
- Delete old SHAs with `git -C ~/gh/ontola/atomic-server worktree remove`
  once no pin refers to them.
