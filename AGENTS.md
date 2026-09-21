# Working in this repo

This is `ontola/atomic-server`'s `integrations/` folder, extracted for fast
iteration. It is **not buildable or testable on its own**: every package
imports from `../../browser/lib/src/...`, which only exists inside a full
`atomic-server` checkout. `.atomic-server-ref` pins the upstream commit this
folder is meant to sit on top of; `.github/workflows/ci.yml` checks that
commit out, replaces its `integrations/` with this repo's, and builds/tests
from there. Reproduce that locally before running any command below:

```sh
ATOMIC_SERVER_REF=$(cat .atomic-server-ref)
git clone https://github.com/ontola/atomic-server.git /tmp/atomic-server
cd /tmp/atomic-server && git checkout "$ATOMIC_SERVER_REF"
rm -rf integrations
cp -r /path/to/this-repo/integrations .
```

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
   File-upload importers (**Bank statements**, `integrations/mt940/`) and
   most existing integrations (`pets`, `github-issues`, `notion`) are this
   shape. See [Building an uploader plugin](integrations/README.md#building-an-uploader-plugin).
2. **Browser-only LocalThought/Devonian connectors** — no server sandbox,
   no AtomicServer HTTP dependency; runs entirely client-side, driven by
   `BrowserIntegrations` (`integrations/localthought/browser.ts`) and the
   syncables/reflector engine, optionally with a Devonian lens for local-first
   two-way sync. `integrations/localthought/`, `integrations/clockify/`, and
   `integrations/github-issues/devonian/` are this shape. See
   [Building a LocalThought (reflector/syncables/Devonian) connector](integrations/README.md#building-a-localthought-reflectorsyncablesdevonian-connector).

Do not mix the two: a sandbox plugin never reaches the network itself for a
LocalThought-flow provider, and a browser connector is never loaded into the
QuickJS sandbox.

## Style notes for docs and code in this repo

- Prose here is precise and hedged, not marketing copy: state exact limits
  (record counts, byte sizes, timeouts), name what is *not* yet verified,
  and give exact copy-pasteable commands rather than "run the tests."
- Every `.ts` source file starts with `// @wc-ignore-file`.
- Amounts, dates and other precision-sensitive values are exact strings,
  never floats.
- A capability is "declared", not "verified", until it has current live
  evidence (`integrations/README.md`'s certification command explains the
  distinction) — keep that language when writing catalog copy or docs.
