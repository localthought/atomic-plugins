# Shared ontology: `ontology/` and `ontology-kit/`

The row classes several drive apps sync into, so that a plugin's view works on
any table of that class, including tables the plugin never synced and rows made
by hand. Design and decisions: [#177](https://github.com/ontola/atomic-plugins/issues/177)
("option 4"). Every class and property here is **declared, not verified**: no
plugin writes or reads them yet, and nothing has run against the published
GitHub Pages URLs.

Two top-level folders, split so that everything under the vocabulary's URL
space is an immutable term and nothing else:

| Folder          | Holds                                                                                                                                                                                                           | Published?                              | Changes?                      |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------- | ----------------------------- |
| `ontology/`     | Only the generated term files: `v<N>`, `classes/<name>-v<N>`, `properties/<shortname>`                                                                                                                          | Yes, by GitHub Pages at `<base>/<path>` | Never, once on `main` (below) |
| `ontology-kit/` | `base.json`, `source.json`, the build and check (`ontology.mjs`), the generated subject constants (`terms.mjs`, `terms.d.mts`), the field resolver (`resolver.mjs`, `resolver.d.mts`), their tests, this README | No                                      | Yes                           |

Both are shared code outside the plugin folders, approved by Michiel on #177
(question 12).

## What is in v1

Four shared classes, plus two companion classes, as the #177 draft (§2.2–2.5)
specifies:

| Class                               | Requires                                                          | Recommends                                                                                        | Reuses                                                                                                                 |
| ----------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `event-v1`                          | `name`, `atomic-calendar-day`                                     | `atomic-calendar-end-day`, `-all-day`, `-start`, `-end`, `-location`, `-notes`, `-recurrence`     | the `calendarFields` shortnames the host's built-in Calendar view matches                                              |
| `issue-v1`                          | `name`                                                            | task/v1 `status`, `body`, `assignee`, `due-date`                                                  | the task/v1 subjects every AtomicServer embeds (`https://atomicdata.dev/task/v1/…`), referenced, not copied            |
| `time-entry-v1`                     | `work-start`                                                      | `name`, `work-end`, `work-project`, `work-person`, `work-billable`                                | the `work-*` shortnames of the host's `timeTrackingSchema` (which mints them per drive, so they are new subjects here) |
| `work-project-v1`, `work-person-v1` | `name`                                                            | –                                                                                                 | –                                                                                                                      |
| `bank-transaction-v1`               | `bank-account`, `bank-currency`, `bank-amount`, `bank-value-date` | `name`, `bank-booking-date`, `bank-description`, `bank-reference`, `money-category`, `money-note` | money 0.2.0's shortnames, unchanged                                                                                    |

`name` is `https://atomicdata.dev/properties/name`. Provider data (ids, ETags,
baselines, import bookkeeping such as `work-source-id` or `bank-source-id`) is
never part of a shared class: each sync part defines it in its own ontology.

## Base URL: one place

`ontology-kit/base.json` holds the base, now
`https://ontola.github.io/atomic-plugins/ontology`. Subjects are:

- `<base>/v<N>`: a release index (an Atomic Ontology listing its classes and properties);
- `<base>/classes/<name>-v<N>`: a class;
- `<base>/properties/<shortname>`: a property.

They are extensionless. Pages serves them as `application/octet-stream`, which
both the data browser and atomic-server accept (#177 spike S1, at atomic-server
`2567fc30b`).

`check` refuses the base written literally anywhere except `base.json`,
`ontology/`, `terms.mjs`, built bundles (`plugin.js`, `apps/`) and Markdown.
Code reads it through `terms.mjs` (or `readBase()` in `ontology.mjs`).

## Build and check

```sh
node ontology-kit/ontology.mjs build                           # after editing source.json or base.json
node ontology-kit/ontology.mjs check --published origin/main   # what CI runs
node --test ontology-kit/                                      # unit tests
```

`build` writes `ontology/` and `terms.mjs`/`terms.d.mts`, and deletes term files
the source no longer produces. Commit its output: Pages is a legacy build and
serves only committed files. `check` fails on:

1. a source problem: an unknown datatype, a reference to a term that isn't
   defined here and isn't an absolute `https` URL, `classtype` on a
   non-link datatype, a term in no release, or a release listing a class
   whose properties it doesn't list;
2. a generated file that differs from a fresh build, or any other file under
   `ontology/`;
3. with `--published <ref>` (default `origin/main` when it exists): a file
   under `ontology/` at `<ref>` that was changed or deleted (see Versioning);
4. the base written literally outside the places above;
5. the gate (below).

CI runs it in `shared-checks` (`.github/workflows/ci.yml`, "Shared ontology is
fresh, immutable and gated"), plus the unit tests, oxlint and oxfmt on
`ontology-kit/`. After each Pages build,
[`ontology-published.yml`](../.github/workflows/ontology-published.yml) checks
that every file under `ontology/` is served at its subject with the committed
bytes, retrying for 15 minutes.

The `ontology` tooling lane (`node integrations/tooling/run-lane.mjs ontology --tier e2e`)
checks that the pinned host reads `event-v1` from the dev-server, which serves
`ontology/` at `/ontology/…` with its subjects moved to its own origin and
Pages' headers (including a CORS preflight answered 405).

## Versioning: published terms are immutable

atomic-server fetches an external term once, on first use, and keeps it for
ever: it ignores `max-age` and the ETag (#177 spike S1). A term changed after
publishing would therefore never reach a server that already stored it. So, as
for `apps/<id>/<version>/`:

- A file under `ontology/` that is on `main` is never changed or deleted.
- A change of a property's meaning or datatype is a new property, with a new
  shortname (`…-v2`). Unchanged properties keep their subject.
- Adding, removing or moving a property in a class's `requires`/`recommends` is
  a new class version, `<name>-v<N+1>`. A view lists every class version it
  renders.
- New terms go in a new release, `v<N+1>`, whose index lists the terms of that
  release. A term's `parent` stays the release that first listed it.
- The source keeps every published term, so `build` keeps writing it.

The one exception `check` allows is a **base move**: when `base.json` differs
from the published one, a published file may change by exactly the old base
replaced with the new one, and by nothing else.

## Moving to the stable domain

The github.io base is temporary; a custom domain for the Pages site is coming.
The move, as #177 §2.0 recommends (rewrite stored data, no alias layer):

1. Edit `ontology-kit/base.json`, run `build`, and commit: every term file
   changes by exactly the base substitution, which `check` allows.
2. Rebuild every plugin that bundles `terms.mjs`, and bump its version: its
   `apps/<id>/<version>/ui.js` and `plugin.js` change, and published app
   versions are immutable too (`apps.mjs check`).
3. Turn the gate off for those entries (`enabled: true` where wanted); `check`
   stops requiring `enabled: false` once the base's host isn't `*.github.io`.
4. Drives that stored github.io subjects (test, e2e and developer drives only,
   because of the gate) are rewritten or re-created.

Unverified: once this repository's Pages site has a custom domain, GitHub
redirects the github.io URLs to it, so the old subjects answer with files under
the new base. The gate keeps that away from production drives.

## Gate

While the base's host ends in `.github.io`, `check` requires `"enabled": false`
on every `integrations/catalog.json` entry that uses the ontology: its entry
contains the base, its committed drive app module (`apps/<id>/<version>/ui.js`)
does, or code in its plugin folder (`integrations/<shortname>/`, `.js`/`.ts`/
`.json` files) contains the base or imports `ontology-kit/`. The folder is the
entry's shortname, as for `certify.mjs` and `catalog-requires.mjs`, except
where `ENTRY_FOLDERS` in `ontology.mjs` maps it (`devonian-google-calendar` →
`calendar`). An entry whose code lives anywhere else is not seen: add it to
`ENTRY_FOLDERS`.

This is the gate #177 §2.0 recommends. The host's `requires` can't express it:
at the pin, `requiresGate` ignores tokens it doesn't know, so a made-up
`stable-ontology-domain` token would not gate anything, and
`catalog-requires.mjs check` would reject it anyway. A disabled entry isn't
listed in the Integrations page; e2e tests still install it test-side. Suggested
card copy for its `limitation`: "Waits for the stable ontology domain."

## Using the terms and the resolver from a plugin

Plugins **bundle** both at build time, by relative import from the repository;
they are not vendored or published to npm:

```ts
// integrations/<plugin>/app/view.ts
import { classes, properties } from '../../../ontology-kit/terms.mjs';
import { createResolver } from '../../../ontology-kit/resolver.mjs';

const fields = createResolver({ classes: [classes['time-entry-v1']] });
const { rowClass } = await store.getData();
if (!fields.accepts(rowClass)) return showNotForThisTable();
const { values, complete, missing } = fields.read(row.props, rowClass);
const start = values[properties['work-start'].subject];
```

- esbuild inlines both files into `plugin.js`/`ui.js`, so the bundle carries
  the subjects and the gate sees them. Types come from the `.d.mts` files next
  to them.
- Add `"ontology-kit/**"` to the plugin's lane `paths` in
  `integrations/lanes.json`, so a change here reruns that plugin's lane.
- A build needs `ontology-kit/` at `../ontology-kit` relative to
  `integrations/`, which it is in this repository and in CI (the whole repo is
  checked out and `browser/` is symlinked in by `link-atomic-server.mjs`). A
  copy of `integrations/` alone, for example into an atomic-server checkout,
  needs `ontology-kit/` copied next to it.

The resolver is strict (#177 decision 1):

- `accepts(rowClass)` is true only for exactly one of the given class subjects,
  or a class a registered lens maps from. No shortname, name or datatype
  matching, and no column guessing.
- `read(row, rowClass)` returns the class's fields present in the row, by exact
  property subject, and `missing`/`complete` for its required ones, so the view
  shows an incomplete row instead of skipping it.
- `write(patch, rowClass, row)` refuses a property that isn't a field of the
  shared class, and returns the patch to save.
- **Lens hooks:** `lenses: [{ from, to, read(row), write?(patch, row) }]` maps
  rows of another class (say a Time tracker template table) onto a shared
  class, in code, per source shape. This is where a Devonian lens plugs in.
  Whether the lensed side is materialized or computed, and with which grant a
  lens writes back, is #177 Q14 and not decided.

## Not verified

- Any of these terms at the real `https://ontola.github.io/atomic-plugins/ontology/…`
  URLs: they exist only once this is on `main`, and `ontology-published.yml`
  then checks Pages serves them.
- A cold browser, or a term the server first uses, while Pages is down: spike
  S1 found both fail (#177 H1).
- `createApp({ rowClass })` and money's `ensureSchema` with these subjects
  (#177 S4).
- Any lens against a live drive (#177 S5).
- How a plugin's e2e uses its bundled github.io subjects while the dev-server
  serves the terms on its own origin: the dev-server rewrites only the term
  files, not bundles.
