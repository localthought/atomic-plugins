# GitHub issues ↔ Atomic kanban

A two-way sync for one repository and one ordinary Atomic kanban table, running
entirely in-browser via Devonian. Provider code (`adapter.ts`,
`tracker-actions.ts`) stays here and is shared between Devonian's
`ports.mjs`/`bridge.mjs` browser transport and this package's mapping tests.

## Browser-only Devonian demo

Open `/app/devonian-demo` for a browser-side issue/comment sync demo using
Devonian and this integration's mappings. It uses a local-only Atomic drive and
direct integration-proxy requests, with an explicit sample mode. See
[setup, source and the current live proxy CORS limitation](devonian/README.md).

## Mapping

| GitHub | Atomic |
|---|---|
| Issue title | Card title |
| Markdown body (`null` becomes empty text) | Description |
| Open, without `atomic:doing` | Todo |
| Open, with `atomic:doing` | Doing |
| Closed | Done |

Dragging a card to Done closes its issue; moving it back reopens it. Other labels
are preserved: the adapter adds/removes only `atomic:doing`, never replaces the
whole label set. Create that label in the test repository before using Doing.
Pull requests are excluded. Comments, assignees, milestones, GitHub Projects and
issue deletion are outside this first scope. A missing issue/card is a conflict,
not permission to delete the other side.

## Verification

```sh
./browser/node_modules/.bin/vitest run --config integrations/github-issues/vitest.config.ts
./browser/node_modules/.bin/tsc -p integrations/github-issues/tsconfig.json
```

These check `adapter.ts`'s pagination, PR exclusion and mapping, and the generic
event-to-JavaScript starter (`automation.test.ts`). See
[the Devonian demo's own README](devonian/README.md) for its browser-side
verification, including the Playwright two-way sync regression.

API reference: https://docs.github.com/en/rest/issues/issues
Label operations: https://docs.github.com/en/rest/issues/labels
