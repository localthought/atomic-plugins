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
Details: [Local setup](integrations/README.md#local-setup).

Everything else — the contributor checklist, certification command, config
declaration convention, permissions/recovery model, live-testing contract —
lives in [`integrations/README.md`](integrations/README.md) and its
companion docs ([`ACTIONS.md`](integrations/ACTIONS.md),
[`AUTHORIZATION.md`](integrations/AUTHORIZATION.md),
[`LIVE_TESTING.md`](integrations/LIVE_TESTING.md)). Read that before adding
or changing a package under `integrations/`; this file only orients you
towards it and towards the plugin shapes below.

## Plugin runtimes

`integrations/<name>/` packages hold code for one of the shapes below, and
some hold more than one. Pick the right one before writing code. Which
plugin uses which shape today, and how far each gets on the pinned host, is
in [`integrations/READINESS.md`](integrations/READINESS.md).

1. **Drive apps** (`integrations/<name>/app/`) — the current direction for
   provider integrations. One ES module built by `app/build.mjs` that
   exports `view({ root, store })`. atomic-server runs it as an App's entry
   point in a null-origin iframe (`sandbox="allow-scripts allow-modals"`).
   It never holds a credential: every provider call goes through
   `store.proxy.request`/`.connections`/`.connect`. Since #54 phase 2
   (ontola/atomic-server#1697) the connection lives at the integration
   proxy, owned by the user's agent and delegated to the app's; the frame
   calls the proxy itself with a short-lived capability from the page and a
   key only it holds (`integrations/README.md`, "The host's proxy
   access"). Reading uses
   the npm `syncables/browser` package where an OpenAPI document drives the
   paging, and optionally a lens from the npm `devonian` package for the
   mapping. `pets/app/` (syncables), `notion/app/` (syncables plus a
   Devonian `AtomicLens`) and `timesheets/app/` (its own Clockify client)
   are this shape. No host UI installs a drive app from the catalog yet
   ([#94](https://github.com/ontola/atomic-plugins/issues/94)); their E2Es
   install test-side.
2. **Server-executed sandbox plugins** — a bundled `plugin.js` with a
   `manifest` and a `run(ctx)`, executed server-side in a QuickJS/WASM
   sandbox against scoped `ctx.query`/`ctx.read`/`ctx.http`/`ctx.config`.
   **Bank statements** (`money/`), the static Pets demo (`pets/plugin.ts`),
   the two-way Notion pilot (`notion/plugin.ts`), the GitHub sandbox plugin
   (`issue-tracker/devonian/github-issues/plugin.ts`) and the generic
   mapper `localthought/plugin.ts` are this shape. The runtime is still in
   atomic-server, but atomic-server removed the UI that installed and ran
   these (`4bab16ee6` the per-plugin setup dialogs, `c707ca4ed` the
   LocalThought flow), so none of them has a host entry point at the pin. See [Building an uploader plugin](integrations/README.md#building-an-uploader-plugin).
3. **Unhosted libraries** — mapping code, Devonian lenses and bridges with
   no runtime of their own: `calendar/adapter.ts` and
   `calendar/devonian/google-calendar/`, `issue-tracker/todoist.ts`, the
   and the GitHub issues lens and bridge in
   `issue-tracker/devonian/github-issues/`. Their former
   hosts in atomic-server's data-browser (the LocalThought connect dialog
   and sync panel, the Devonian demo) were removed; the data-browser no
   longer imports anything from `integrations/`. A library reaches users
   only once a drive app (shape 1) wraps it.

Do not mix the shapes: a drive app never runs in the QuickJS sandbox, and a
sandbox plugin never reaches a LocalThought-flow provider itself.

These shapes are placements A (iframe view) and B (sandbox job) of the
accepted #88 design. Before starting a package, apply its decision rules in
[Choosing a placement](integrations/README.md#choosing-a-placement): they
say when a part must instead be a sandbox route (C), a server extension (D)
or a sidecar (E). C, D listeners and E are **planned, not built**
(ontola/atomic-server#1711–#1723). Any public endpoint will need all three
gates: an AtomicServer built with the Cargo feature `plugin-routes`, the
operator's `--plugin-routes`/`ATOMIC_PLUGIN_ROUTES` switch, and per-plugin
install consent. atomic.place builds without the feature, so a package
meant to be useful there must not depend on one; see
[Public endpoints need a gated server](integrations/README.md#public-endpoints-need-a-gated-server).

## devonian/

Unlike `integrations/`, `devonian/` is a self-contained, independently
buildable and publishable TypeScript package (own `package.json`,
`pnpm-lock.yaml`, `tsconfig.json`) migrated in from the standalone
`localthought/devonian` repo, full commit history included via `git
subtree`. It publishes to npm as `devonian`. Two plugins use it:
`integrations/notion/` depends on the published npm version (exact version
in its `package.json`), and `integrations/issue-tracker/devonian/github-issues/`
imports this folder's source through a Vitest alias. A plugin's own lens lives in
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
for the fuller architecture note. The `describeIntegration`/
`fetchIntegration` machinery that depended on it was removed from
`integrations/localthought/browser.ts`, and that file itself was deleted in
#54 phase 2 with the proxy's rotating connection codes.

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

## apps/

`apps/<id>/<version>/ui.js` holds the built drive app modules that
`integrations/catalog.json` entries install from (`app-module`). The same
Pages publish serves them at
`https://ontola.github.io/atomic-plugins/apps/<id>/<version>/ui.js`. Never
edit these files by hand. `node integrations/tooling/apps.mjs write <id>`
writes them. A file that is already on `main` is never changed or deleted;
CI's `apps.mjs check --published origin/main` enforces that. See
[Publishing a drive app](integrations/README.md#publishing-a-drive-app).

Drive app bundles are minified with esbuild, JS and CSS: `minify: true` in
`app/build.mjs`, and embedded CSS goes through
`esbuild.transform(css, { loader: 'css', minify: true })`. Each app's
build-test size limit (`app/build.test.ts`) is the measured minified size
plus about 10%, with a comment stating the measured size and the date. No
silent headroom: when a change needs a higher limit, re-measure and raise the
limit and its comment in the same commit. See
[Bundle size](integrations/README.md#bundle-size).

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

- Keep each plugin inside its own folder (see "Plugin runtimes" and
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

#### Or run the published image instead of building

CI publishes the same build once per pinned SHA as
`ghcr.io/ontola/atomic-server-e2e:<full sha>`
(`.github/workflows/atomic-server-e2e-image.yml`; the recipe is
`integrations/tooling/atomic-server-e2e/Dockerfile`). With
`ATOMIC_SERVER_IMAGE` set, `serve.mjs` (and so `run-lane.mjs`) starts
atomic-server with `docker run` on the lane's usual port instead of running
`$DIR/target/e2e/atomic-server`. There's no cargo build and no `target/`, so
the checkout is about 1 GB of sources plus `browser/node_modules` instead of
about 11 GB. The lanes still need that checkout for `browser/` (the JS
workspace, `@tomic/lib`, Playwright), just not built:

```sh
SHA=$(cat .atomic-server-ref)
DIR=~/.cache/atomic-plugins/atomic-server/$SHA
if [ ! -d "$DIR" ]; then
  git -C ~/gh/ontola/atomic-server fetch origin
  git -C ~/gh/ontola/atomic-server worktree add --detach "$DIR" "$SHA"
fi
export ATOMIC_SERVER_CHECKOUT=$DIR
export ATOMIC_SERVER_IMAGE=ghcr.io/ontola/atomic-server-e2e:$SHA
node integrations/tooling/link-atomic-server.mjs
node integrations/tooling/run-lane.mjs pets --tier e2e
```

- `serve.mjs` pulls the image the first time (about 100 MB compressed) and
  warns if its tag isn't the pinned SHA. `docker image rm` old tags yourself.
- The image exists only once main has built it, or once a same-repo PR that
  bumps the pin has published it. For any other SHA, `serve.mjs` fails with
  "could not pull". Use the source build above then.
- It runs on macOS through Docker Desktop, which can't run the linux binary
  natively any other way. Images built on main are multi-platform
  (`linux/amd64` and `linux/arm64`), so Apple Silicon runs them natively.
  An image a pin-bump PR published is `linux/amd64` only until main rebuilds
  it, and Docker Desktop runs that under emulation, noticeably slower.
- The port is published on `127.0.0.1` only, at the same number inside and
  out, because atomic-server derives its own origin from it. The mock proxy
  and the dev-server still run on the host. The server never needs to reach
  them: plugin `ctx.http` refuses loopback addresses anyway.
- Each lane's store is a named volume, `atomic-plugins-lane-store-<lane>`,
  instead of `$DIR/.lane-store/<lane>`. Like that directory it persists
  across tiers and runs. Reset one with
  `docker volume rm atomic-plugins-lane-store-<lane>`.
- On Linux you can also copy the binary out and skip Docker at run time:
  `docker create --name tmp "$ATOMIC_SERVER_IMAGE" && docker cp
  tmp:/usr/local/bin/atomic-server "$DIR/target/e2e/atomic-server" &&
  docker rm tmp`. Then leave `ATOMIC_SERVER_IMAGE` unset. The binary is
  linked against glibc 2.36 (Debian bookworm).
- Until an org owner makes the package public (a one-time switch in its
  GitHub package settings), pulls need `docker login ghcr.io` with a token
  that has `read:packages`.

To check the Dockerfile itself, build it from the checkout. The Dockerfile's
own ignore file keeps a built `target/` out of the context. About 20 minutes
on 10 cores; `CARGO_BUILD_JOBS=6` keeps Docker Desktop's default 8 GB VM from
running out of memory:

```sh
docker build -f integrations/tooling/atomic-server-e2e/Dockerfile \
  --build-arg ATOMIC_SERVER_SHA="$SHA" --build-arg CARGO_BUILD_JOBS=6 \
  -t "ghcr.io/ontola/atomic-server-e2e:$SHA" "$DIR"
```
