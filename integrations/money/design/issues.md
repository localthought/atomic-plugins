# Money: implementation issues

From [`DESIGN.md`](DESIGN.md) (#89). Each issue below is sized to be done
independently in its own branch; dependencies are listed at the top of each.
All work stays inside `integrations/money/` unless an issue says it belongs in
`ontola/atomic-server`. Section and frame references (`6.3`, `#preview`) point
into `DESIGN.md` and `mockups.html`.

Filing: title is the `##` heading after the ID; body is everything up to the
next `---`. Suggested labels: `money`, `design-#89`, plus `needs-decision`
where marked.

Dependency graph (→ means "needed by"):

```
M-1 scaffold ─┐
M-2 shell ────┼→ M-4 ledger ─→ M-6 detail ─→ M-13 a11y/responsive
M-3 amounts ──┘      │   ↑           ↑
                     │   M-5 annotation schema
M-7 statements ──────┴→ M-12 summary strip
      └────────────────→ M-11 imports tab
M-8 host import op ─┐
M-9 structured errors ┴→ M-10 in-app import sheet
M-4 → M-14 Moneybird (next) ;  M-15 counterparty (next, independent)
```

Parallel from day one: M-1, M-2, M-3, M-5, M-7, M-8, M-9, M-15.

---

## M-1 · Money: scaffold the iframe app (view(), controller, build)

**Depends on:** nothing.

Add `integrations/money/app/` in the shape of `integrations/pets/app/`:
`main.ts` exporting `view({ root, store })`, `store.ts` (per-plugin copy of
the host `PluginStore` types), `controller.ts` with a DOM-free `ViewState`,
`fakeStore.ts`, `build.mjs` + `build.test.ts`.

ViewState for this issue: `loading` · `empty` (table has no rows) ·
`populated { count }` · `error { message }`. Data comes from `store.getData()`
(the Bank transactions table) and `store.query` on the table's children.

Render: `.pl-header` with "Money" and an "Import statement" button, tabs
Transactions / Imports / Sources (only Transactions active), and the
first-run `.pl-empty` (frame `#first-run`). Until M-10, "Import statement"
uses the host's `navigate` op to open the existing Bank statements dialog.
Unstyled is acceptable here; M-2 supplies styles.

Acceptance:
- `vitest run --config integrations/money/vitest.config.ts` covers the
  controller's state transitions with `fakeStore`.
- `app/build.mjs` output is reproducible (`build.test.ts`), one module, no
  stylesheet file, every `.ts` starts with `// @wc-ignore-file`.
- README gains an `app/` paragraph under Architecture.

---

## M-2 · Money: shared plugin shell styles and components

**Depends on:** nothing (can be developed against a static harness page).

Implement DESIGN.md §4–5 inside `integrations/money/app/shell.ts`: the
`--pl-*` token map with fallbacks, the derived `--pl-pos` and tints, and
DOM builders for `.pl-header`, `.pl-pill[data-state]`, `.pl-conn`,
`.pl-empty`, `.pl-banner[data-tone]`, buttons, chips and the detail panel
container. Styles are injected as one `<style>` element from the module
(no separate stylesheet). Class and token names must match the other #89
designs exactly (see DESIGN.md §4); do not import from another plugin folder.

Acceptance:
- Unit test: each builder returns the documented roles/ARIA (`role="status"`
  on the pill, `role="alert"` on neg banners).
- With the host's light and dark `--t-*` values (copy from `mockups.html`),
  a screenshot of a harness page matches frames `#first-run` and
  `#no-results` in structure.
- `prefers-reduced-motion` disables the pill pulse.

---

## M-3 · Money: exact-decimal formatting, totals and grouping utilities

**Depends on:** nothing.

Pure module `integrations/money/app/amounts.ts`:
- `formatAmount(amount: string, currency: string, locale: string)` using
  `Intl.NumberFormat(...).format(amountString)` (exact decimal in engines
  with Intl.NumberFormat v3) with a string-splitting fallback when the engine
  would coerce to `Number`. Leading `+` for positive, U+2212 for negative.
- `amountLabel(...)` → words for `aria-label` ("minus 84 euro 30").
- `totals(rows)` → per account + currency `{ in, out, net }` as strings, via
  the BigInt `units()` helper in `parser.ts` (reuse, do not reimplement).
- `groupByDay(rows)` keyed by booking date (value date fallback), with a
  per-currency net per day.

Acceptance:
- Tests include `"12345678901234.56789"`, `"-0.00001"`, JPY (0 decimals) and
  BHD (3 decimals), and assert no float round-trip (`Number(...)` never
  called on an amount; grep test).
- Mixed currencies never sum together.

---

## M-4 · Money: Transactions tab ledger with filters and search

**Depends on:** M-1, M-2, M-3.

Implement frames `#ledger-wide`, `#ledger-narrow`, `#no-results`
(DESIGN.md 6.6, 6.8, 6.10):
- Account switcher from distinct `bank-account` + currency values.
- Filter row: search (description, reference; case-insensitive substring),
  period chips (This month · Last month · This year · Custom), direction
  (All · In · Out), "Uncategorised" (hidden until M-5 lands).
- Ledger: `<table>` with caption at ≥560px, `role="list"` of buttons below;
  day headers with per-currency net; at most 200 rows then "Show earlier
  transactions".
- Summary strip with money in/out for the filtered period (closing balance
  segment is M-12).
- `store.subscribe` on the table so new rows appear without reload.

Acceptance:
- Controller tests for filter combinations with a 500-row fake table.
- Render budget: first render of 500 rows under 100 ms on a mid-range laptop
  (measure and record the number in the PR; this is the first measurement).
- No horizontal page scroll at 360px; the strip scrolls in its own container.

---

## M-5 · Money: annotation properties (category, note) in the schema

**Depends on:** nothing. **needs-decision**

Add `money-category` and `money-note` to `schema.ts` (in `recommends`, not
`requires`, for `bank-transaction`). The importer must never write them.

Decision needed: category as a free-text string (simplest; the combobox
suggests values already used in the table) or as a link to a `Category`
resource (renamable, shareable across tables, more setup). The design
assumes a string for now.

Acceptance:
- Test: import, set category/note on a row, re-import the same statement →
  category/note unchanged and zero changes proposed.
- Shared ontology upgrade path noted in README (existing installations get
  the new properties; see README "Shared ontology/schema creation still
  needs resumable installation").

---

## M-6 · Money: transaction detail panel with local edits

**Depends on:** M-4, M-5.

Frames `#ledger-wide` (panel) and `#detail` (narrow sheet), DESIGN.md 6.7:
read-only "From your bank" fields and verbatim narrative; editable category
(combobox) and note; save on blur via `resource.set(...).save()`; "Saved"
footer; inline neg banner with Retry on failure, keeping the typed value.
Side panel ≥900px (non-modal region), drawer 560–899px, full-screen sheet
<560px; Esc closes and focus returns to the row.

Acceptance:
- Tests with `fakeStore` for save success, save failure + retry, and that
  bank fields have no editable control.
- Keyboard: ↑/↓ row focus, Enter opens, Esc closes.

---

## M-7 · Money: store imported statements (balances and periods)

**Depends on:** nothing.

Add a `bank-statement` class to `schema.ts` (account, currency, number,
start, end, opening, closing, format, imported-at; amounts as exact
strings) and have `plugin.ts` emit one `ImportRecord` per parsed `Statement`
beside its transactions, with an identity of
`[format, account, currency, number, start, end]` and `mode: 'append'`.
Transactions keep their existing identity rules unchanged.

Acceptance:
- Parser/plugin tests: re-importing the same file proposes zero changes for
  both statements and transactions.
- `plugin.js` rebuilt with the README's esbuild command; bundle
  reproducibility passes.
- The sandbox test names in `package.json` `atomicCertification` still pass
  in `atomic-server` (or are updated there in a separate PR, per the
  pin/PR rules).

---

## M-8 · atomic-server: let a plugin app run and apply an importer proposal

**File in `ontola/atomic-server`, not this repo.** **needs-decision**
**Depends on:** nothing.

The app bridge ops today are `app, data, get, query, create, save, destroy,
patch, context, navigate, pickResource, pickFile, search, subscribe,
unsubscribe`. None runs a sandbox importer with file text and returns its
proposal (`intents`, `problems`, `summary`), or applies an approved proposal.
The in-app import sheet (M-10) needs both, scoped to the app's own importer.

Decision needed: add bridge ops (`proposeImport`, `applyImport`) versus
keeping import in the host dialog permanently and only restyling that
dialog. The design prefers the ops; the host-dialog route keeps the
current `navigate` fallback from M-1.

Acceptance (if ops): an app can only run importers it is installed with;
the proposal is identical to what `RunPluginDialog` shows today; apply is
a separate, explicit call.

---

## M-9 · Money: structured import errors (codes + data)

**Depends on:** nothing.

Today blocking cases are thrown as plain strings. Give each a stable code
and data while keeping the existing message text (the host dialog shows it):
`BALANCE_MISMATCH { statement, account, opening, entriesSum, expectedClosing, closing }`,
`OVERLAP_WITHOUT_REFERENCES { earlierPeriod, thisPeriod }`,
`REPEATED_REFERENCE { reference }`, `CONFLICTING_REFERENCE { reference }`,
`JSON_NARRATIVE { count }`, `INVALID_FIELD { tag, line }`.
The "changed reference payload" case comes from `importRecords` in
`atomic-server`'s `browser/lib`; exposing its before/after values there is a
separate atomic-server issue, linked from this one.

Acceptance:
- Tests assert code + data for each case in `parser.test.ts` /
  `camt053.test.ts`; existing message assertions unchanged.

---

## M-10 · Money: in-app import sheet (check, preview, errors)

**Depends on:** M-2, M-3, M-9; M-8 to ship (the UI can be built against a
fake op first).

Frames `#checking`, `#preview`, `#error-balance`, `#conflict`
(DESIGN.md 6.2–6.5): choose or drop a file; size check (512 KB MT940,
5 MB camt.053) before reading; parse locally with `statement.ts` in a
Worker for the checklist and reconciliation cards; request the proposal via
the M-8 op for New / Already imported / Blocked counts; "Import N
transactions" applies; designed banners per error code with the plain
message in Technical details.

Acceptance:
- Controller tests for every sheet state, including cancel during checking
  and "Nothing new in this file".
- A blocking error moves focus to the banner heading.
- The bundled app still contains no network code (`fetch`/`XMLHttpRequest`
  grep on the build output).

---

## M-11 · Money: Imports tab

**Depends on:** M-1, M-2, M-7.

One row per stored `bank-statement`: account, period, statement number,
format, entries, opening → closing, imported-at. Selecting a row filters
Transactions to that statement. Empty state points to Import statement.

Acceptance: controller tests with fake statements; responsive at 360px.

---

## M-12 · Money: account summary strip with closing balances

**Depends on:** M-4, M-7.

Add each account + currency segment's latest statement closing balance and
its date (DESIGN.md 6.6). When a period has no statement, show the in/out
figures only and no balance, never a computed one.

Acceptance: tests for multiple currencies on one account and for accounts
with no stored statement.

---

## M-13 · Money: accessibility and responsive verification

**Depends on:** M-4, M-6.

- axe (or equivalent) run on the app in light and dark host tokens: zero
  serious/critical findings.
- Measure `--pl-pos` contrast on `#fff` and `#000` grounds (target ≥4.5:1)
  and adjust the mix if needed; record the numbers in DESIGN.md.
- Keyboard walkthrough: `/`, ↑/↓, Enter, Esc, `i`, `?`.
- Screenshots at 360, 720 and 1200px, light and dark, attached to the PR.

---

## M-14 · Money: Moneybird read-only source (next)

**Depends on:** M-4. Needs a Moneybird account to record a fixture
(maintainer).

Add a proxy-backed source using `store.proxy` (`connections`, `connect`,
`request`), following `pets/app/controller.ts`'s states: `no-relay`,
`disconnected`, `connecting`, `syncing`, `synced`, `error`/`reauth`
(frame `#sources`). Map Moneybird financial mutations to ledger rows with a
"Moneybird" source tag, read-only in detail. Fixture and recorder go in
`integrations/money/fixtures/moneybird/`, registered as the `lanes.json`
money note describes.

Acceptance: sync tests against the recorded fixture through the mock proxy;
no credential or connection code stored in any resource
(`no-credentials-in-graph.test.mjs` passes).

---

## M-15 · Money: counterparty name and account from camt.053 (next)

**Depends on:** nothing.

camt.053 carries counterparty name and account (`RltdPties`); store them as
`bank-counterparty-name` / `bank-counterparty-account` so the ledger's bold
line shows a real counterparty instead of the narrative's first line. MT940
`:86:` structured `/NAME/` subfields can fill the same properties when
present; unstructured narratives leave them empty (no guessing).

Acceptance: parser tests on the synthetic fixtures. The new properties are
not part of the identity or fingerprint, so existing rows keep their
identity; append mode does not backfill them on reimport (backfilling is out
of scope and would need its own issue).

---

## Not filed now (later, see DESIGN.md §9)

QuickBooks source; review inbox (For review / Excluded); invoice matching;
two-way bookkeeping sync via a Devonian lens; CSV/PDF statements; splits;
budgets; exact-decimal numeric aggregation in the host's generic table.
