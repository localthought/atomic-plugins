# Pets (demo)

This folder holds two independent things:

1. **`app/`: the Pets drive app** (atomic-plugins#52). It is a browser-only
   iframe plugin that reads Pets through the LocalThought integration proxy.
   It never holds a credential. See [Drive app](#drive-app-app) below.
2. **`plugin.ts`: the static sandbox demo**, described next. It has five
   built-in pets and no network access.

A trivial, read-only demo integration: five static demo pets, imported into a
Pets table with a small code-first ontology (species, breed, age, mood).
There is no provider, account, API key or network call — `manifest.operations`
and `manifest.secrets` are both empty. Its only purpose is to exercise the
touch points a real API plugin needs: an ontology, an import mapping into the
shared sandbox, an installable connection, and a table a document or an LLM
can query afterwards.

Historically, Integrations → Pets → Set up connection created a Pets table
beneath the installed connection and imported the five demo pets; re-running
skipped unchanged pets. atomic-server `4bab16ee6` removed that dialog
(`ConnectPets`), so at the current pin nothing installs or runs this bundle.
The catalog's `pets` card still describes this demo rather than the drive
app.

## Architecture

`plugin.ts` bundles the static data and mapping into `plugin.js`, and runs in
the same sandboxed server host as every other integration
(`server/src/plugins/js_runtime.rs`). It never calls `ctx.http`.
`schema.ts` defines the ontology with `ensureSchema`, the same code-first
mechanism `money` uses.

## Why this exists

This is the first step of rebuilding the API-plugins direction from
[PR #1383](https://github.com/ontola/atomic-server/pull/1383) on top of the
plugin model in `feat/plugin-model`. That PR discovered OpenAPI-described
providers under a `REFLECTOR_ROOT/spec` folder and ran live OAuth imports.
Here, the touch points are proven out first with data that needs none of
that: no discovery, no OAuth, no secrets. The next step is to replace the
static `data.ts` with a provider discovered through the localthought proxy,
once that discovery path exists.

## Drive app (`app/`)

`app/` builds one ES module (`node integrations/pets/app/build.mjs` →
`app/dist/ui.js`). It exports `view({ root, store })`, which atomic-server's
plugin frame calls inside a null-origin, `allow-scripts`-only iframe. It
follows `integrations/timesheets/app/`: plain DOM, no framework, and no
stylesheet.

- **Reading.** `syncables/browser`'s `readPlatform` walks the bundled Pets
  OpenAPI document (`app/openapi.json`, the same file the mock proxy serves)
  and follows the `Link: rel="next"` pagination. The document's
  `crudResources` drives it, so there is no Pets-specific paging code.
  `syncables/browser` is the published npm `syncables@0.18.0`, pinned in
  `package.json` and `pnpm-lock.yaml` and installed with
  `pnpm install --frozen-lockfile` in this folder; this repo's
  `syncables/src/` is not bundled.
- **Network.** Every request goes through the host's proxy relay,
  `store.proxy.request({ platform, connectionId, path, method, body })`
  (`app/transport.ts`). The top page holds the LocalThought connection (its
  rotating code, in its own `localStorage`, bound to this app) and returns
  only `{ status, headers, body }`. `transport.ts` refuses any URL outside
  the document's `servers[0].url`, including provider-sent links. The bundle
  contains no `fetch`, storage or `Authorization` handling
  (`app/build.test.ts` checks this).
- **Connecting.** "Connect Pets" calls `store.proxy.connect({ platform:
'pets' })`. The host, not the frame, draws a consent bar. Only a click
  there starts the PKCE handoff to the proxy. The proxy returns to
  `/app/integrations`, the host redeems the code and navigates back to the
  app, and the app finds its connection with `store.proxy.connections(...)`.
  There is no Pets-specific setup code in atomic-server.
- **Writing.** `app/sync.ts` writes only inside the app's own subtree. It
  adds one Property per API field under the app's ontology, typed from the
  schema (`age` integer, `vaccinated` boolean, `weight` float, `updated_at`
  timestamp). It adds those Properties to the row class's `recommends`, and
  upserts one row per pet under the app's table, matched by `id`. A re-sync
  with no remote change writes nothing.

**Host requirement.** This needs the relay ops `proxy`, `proxyConnections`
and `proxyConnect` in atomic-server (atomic-server#1657, for #1624, merged
into `feat/plugin-debug` and in the pin). On a host without them the app says
so and stops. The
relay is the interim shape. #1624's scoped capability (#40, #54) is meant to
replace the rotating code without changing this app.

**Install.** The `pets` catalog entry is a drive app entry (#94):
`app-module` is
`https://ontola.github.io/atomic-plugins/apps/pets/0.1.0/ui.js`, the
committed `apps/pets/0.1.0/ui.js` (`app/build.mjs`'s output) as GitHub Pages
serves it, and `app-module-integrity` pins its bytes. Open
Integrations, turn on "Show experimental plugins", and choose **Install** on
the Pets card under **Drive apps**. See
[Publishing a drive app](../README.md#publishing-a-drive-app) for the release
steps. The host side is atomic-server#1689, in the current pin. Until this
change is merged to `main` and Pages has deployed it, the Pages URL is a 404,
so installing from the public catalog fails with a download error and
creates nothing.

The e2e (`e2e/pets.spec.ts`) goes through the catalog, with the lane's
dev-server standing in for GitHub Pages: discover the card → install → connect through
the mock proxy → first import (five rows, typed columns) → reopen from the
card ("Installed 0.1.0", re-sync unchanged) → update from a rewound "0.0.1"
back to 0.1.0 with the rows kept. It no longer replaces the app's source
from the test.

**Shared code.** `app/store.ts` (the host store types) is a copy of
`integrations/timesheets/app/store.ts` plus the relay ops. The Notion app
will need the same copy. Moving them into one shared module is a
maintainer decision (strict per-plugin containment), so it is not done
here.
