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
   `integrations/localthought/`, `integrations/timesheets/`, and the
   GitHub issues lens at `devonian/platform-lenses/github-issues/` are this
   shape. See
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
`devonian/platform-lenses/github-issues/` depend on for the reflector/syncables
lens engine described above. See [`devonian/AGENTS.md`](devonian/AGENTS.md)
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
