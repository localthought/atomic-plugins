# Money: frontend design

Status: design proposal for [#89](https://github.com/ontola/atomic-plugins/issues/89).
Nothing here is implemented yet. Mockups: [`mockups.html`](mockups.html)
(open locally in a browser; it is static and loads nothing external).
Implementation breakdown: [`issues.md`](issues.md).

## 1. Where we start from

Today `integrations/money/` is a **server-executed sandbox importer**, not an
app. It has no view of its own:

- The person opens Integrations → Bank statements → Set up connection. The
  host dialog (`atomic-server`
  `browser/data-browser/src/chunks/PluginRuns/ImportMT940.tsx`) shows an
  "Import into" select, a native file input and a "Preview import" button.
  The preview is the generic `RunPluginDialog`: a list of intents plus
  `problems` strings.
- `plugin.ts` turns MT940 or camt.053 text into `ImportRecord`s under a
  **Bank transactions** table. Rows are `bank-transaction` resources with the
  11 string/date properties in `schema.ts` (account, currency, amount, value
  date, booking date, description, reference, transaction code, statement,
  source identity, fingerprint).
- The data is then read in the host's generic table view with six columns
  (booking date, description, amount, currency, account, reference).
  Amounts are strings, so that table cannot total them.
- Statement opening/closing balances are reconciled during parsing and then
  **discarded**; only transaction rows are stored.
- Moneybird has a catalog entry (`catalog.json`, `platform: moneybird`,
  read-only, generic LocalThought path) but **no package or code in this
  repo**. QuickBooks has neither.

This design adds a `view()` iframe app to `integrations/money/`, in the same
shape as `integrations/pets/app/` and `integrations/notion/app/` (plain DOM,
bundled by `app/build.mjs`, one module, no stylesheet file), that reads and
annotates those same resources. The sandbox importer stays the only writer of
imported bank fields.

## 2. Users and core jobs

Primary user: a freelancer or small-business owner in the Netherlands/EU who
banks with bunq, ING, Rabobank or ABN AMRO, keeps their data in their own
Atomic Server, and today uses Moneybird or a spreadsheet.

| Job                                                                             | Frequency      | Competitor reference                                                                                              |
| ------------------------------------------------------------------------------- | -------------- | ----------------------------------------------------------------------------------------------------------------- |
| Get this period's transactions in, without duplicates                           | monthly/weekly | Moneybird "Bank → Toevoegen → transactiebestand uploaden"; YNAB file-based import; Lunch Money CSV import preview |
| See what came in and went out, per account, for a period                        | weekly         | YNAB account register; Lunch Money transactions page                                                              |
| Find one transaction ("did client X pay invoice 2026-031?")                     | ad hoc         | all four: search over payee/description                                                                           |
| Annotate a transaction (category, note) without losing the bank's original text | weekly         | QuickBooks "For review" categorise; Lunch Money categories/notes                                                  |
| Trust that the numbers match the bank                                           | every import   | YNAB "Reconcile"; our parser already checks opening + Σ entries = closing                                         |
| Keep Moneybird data alongside, read-only                                        | continuous     | Moneybird itself                                                                                                  |

What competitors converge on, and we adopt:

1. **Preview before commit, with duplicates explained.** Lunch Money shows
   what will be imported after de-duplication and lists skipped duplicates
   separately. We do the same with the existing `importRecords` summary
   (new / already imported / blocked).
2. **One ledger, amounts right-aligned, money-in visually distinct.** All
   four use one chronological list with a signed amount column; none colours
   ordinary spending red. We keep red for errors only.
3. **A clear place for "needs attention".** QuickBooks uses For review /
   Categorized / Excluded tabs. With no bank feed, our equivalent is a filter
   chip ("Uncategorised"), not a workflow inbox. A review inbox is **later**
   (section 9).
4. **Reconciliation as a visible check, not a hidden rule.** YNAB makes it a
   ritual; we get it per statement from the parser and show it as a
   "Balances match" line with the opening and closing figures.

Deliberately **not** copied: live bank feeds (no live bank access; README
"Supported scope and gaps"), invoice matching (needs invoice data we do not
import yet), budgets.

## 3. Information architecture

```
Money (iframe app for the Bank transactions table)
├── Header: name · account switcher · status pill · [Import statement]
├── Source bar (only when a proxy-backed source exists): Moneybird connection state
├── Tabs
│   ├── Transactions (default) – account summary strip, filters, ledger, detail panel
│   ├── Imports                – one row per imported statement / sync run
│   └── Sources                – File import (always), Moneybird (next), QuickBooks (later)
└── Import sheet (modal): choose file → checking → preview → done | error | blocked
```

"Account" is the statement account identifier (`bank-account`), not assumed
to be an IBAN. The switcher lists distinct values in the table plus "All
accounts". Different currencies are never summed together: every total is per
account + currency.

## 4. Shared plugin shell (common to the #89 designs)

This money design first proposed the shared pattern; the calendar,
issue-tracker, notion and timesheets designs adopted it, and the issue-tracker
and notion designs fixed the concrete token and class names below. All five
should use the same names so one implementation can later be shared (sharing
code across plugin folders is a maintainer decision; until then each plugin
carries its own copy, as `store.ts` already does).

- **`.pl-header`** (min 48px): plugin name (`--pl-font-header`, 1.125rem, 600) · context control (for Money: account switcher; "source chips" in the
  other designs) · flexible gap · status pill · one primary action. Below
  560px the primary action becomes a 40px icon button with an `aria-label`,
  and the context control moves to a second row at full width.
- **`.pl-pill[data-state]`**: 24px high, fully rounded, dot + short text,
  and the `role="status"` live region. States: `idle` ("Up to date · 22
  Sep"), `syncing` (accent, pulsing dot: "Checking balances…", "Syncing 120 of
  480"), `synced` (`--pl-pos`: "Imported 42 · just now"), `paused` (warn:
  "Blocked" for a blocked import), `reauth` (warn: "Reconnect Moneybird"),
  `error` (neg: "Import failed"). The text always names the state, so colour
  is never the only carrier.
- **`.pl-conn`** (connection bar): one 40px strip under the header,
  `--pl-subtle` fill (`data-tone="warn"` for reauth), one sentence plus one
  action. Only for proxy-backed sources, and only when something is
  actionable or in progress (connect, syncing, reauth, relay missing). Never
  shown for file import.
- **`.pl-empty`**: centred block, max 560px: heading, one sentence of what
  this is, one primary action, one secondary link or disclosure.
- **`.pl-banner[data-tone=neg|warn|info]`**: full-width block in the content
  area, 3px left border in the tone colour, a title naming what failed, one
  sentence of cause, one recovery action. The raw message goes in a
  `<details>` "Technical details" disclosure, never in the title.
- **Detail panel**: side panel at ≥900px (360px wide, non-modal), overlay
  drawer at 560–899px, full-screen sheet below 560px. Esc closes; focus
  returns to the row that opened it.

## 5. Visual language and theming

The host posts its theme into the iframe as CSS custom properties
(`atomic-server` `browser/data-browser/src/views/PluginView/useCreateThemeVars.ts`,
delivered by the `__atomic_style` frame message). Dark mode is the host
swapping these values (bg `#000`, text `#fff`, main lightened by 0.2); the
iframe gets no separate dark-mode flag and needs no `prefers-color-scheme`
rules. The app styles **only** through the shared `--pl-*` map, each entry
with a light fallback so the view is legible before the first
`__atomic_style` message arrives:

| Shared token                                   | Host source                                                  | Fallback                          |
| ---------------------------------------------- | ------------------------------------------------------------ | --------------------------------- |
| `--pl-bg`                                      | `--t-color-bg-body`                                          | `#fafafa`                         |
| `--pl-surface`                                 | `--t-color-bg`                                               | `#ffffff`                         |
| `--pl-subtle`                                  | `--t-color-bg-1`                                             | `#f2f2f2`                         |
| `--pl-border`                                  | `--t-color-bg-2`                                             | `#cccccc`                         |
| `--pl-text`                                    | `--t-color-text`                                             | `#000000`                         |
| `--pl-muted`                                   | `--t-color-text-light`                                       | `#666666`                         |
| `--pl-accent` / `-soft` / `-ink`               | `--t-color-main` / `-main-selected-bg` / `-main-selected-fg` | `#1b50d8` / `#f1f4fd` / `#0f2d7a` |
| `--pl-neg`                                     | `--t-color-alert`                                            | `#cf5b5b`                         |
| `--pl-warn`                                    | `--t-color-warning`                                          | `#f5a623`                         |
| `--pl-pos`                                     | none (host has no success token)                             | see below                         |
| `--pl-radius`, `--pl-font`, `--pl-font-header` | `--t-radius`, `--t-font-family`, `--t-font-family-header`    | `9px`, system-ui                  |

The sibling designs give `--pl-pos` a fixed `#2f8f5b`. Money shows green
figures on every row, in both themes, so it proposes deriving it instead:
`--pl-pos: color-mix(in oklab, #2f8f5b 75%, var(--pl-text))` darkens it on
a white ground and lightens it on black without knowing the mode. The other
designs can adopt this without changing their markup. Measured in Chromium
with the host's default tokens (M-13, `app/harness/screenshots.mjs`): it
resolves to `rgb(29, 96, 59)` at 7.53:1 on `#fff` and `rgb(106, 171, 130)`
at 7.76:1 on `#000`, above the 4.5:1 target; `--pl-muted` is 5.74:1 and
7.37:1.
Money-local derived tints (`--pl-tint`, `--pl-hair` for row hairlines lighter
than `--pl-border`, `--pl-neg-soft`, `--pl-warn-soft`, `--pl-pos-soft`) are
`color-mix` of the above.

Money-specific rules:

- money out is plain `--pl-text` with a true minus sign (U+2212); money in is
  `--pl-pos` with a leading `+`. The sign is always present, so colour is
  never the only carrier. Red is reserved for errors.
- figures use `font-variant-numeric: tabular-nums`, right-aligned; the
  currency code sits in the column header at wide widths and after the amount
  in `--pl-muted` at narrow widths.
- original bank narratives and references are shown in a monospace block,
  verbatim and wrapped (`white-space: pre-wrap; overflow-wrap: anywhere`).

### Exact-decimal display

Amounts stay strings end to end. Formatting uses
`new Intl.NumberFormat(locale, { style: 'currency', currency }).format(amountString)`,
which in engines implementing Intl.NumberFormat v3 (ES2023) formats a string
as an exact decimal. **Not verified** on every browser the host supports; the
formatting issue must add a string-splitting fallback and a test that
`"12345678901234.56789"` formats without float artefacts. Totals use the
existing BigInt `units()` helper in `parser.ts`, never `Number`.

## 6. Key screens and states

Each is a frame in `mockups.html`; the anchor is in brackets.

### 6.1 First run, no data [#first-run]

Shown when the Bank transactions table has no rows. `.pl-empty`, heading "Bring in your
bank transactions", sentence "Export a statement from your bank as MT940 or
camt.053 and drop it here. Nothing is sent to your bank or anyone else."
Primary: Choose statement file (the whole block is a drop target).
Secondary: "How do I export a statement?" disclosure, one line per bank.
Below, the Moneybird source is rendered disabled with its reason ("Not
available yet"), not hidden.

### 6.2 Checking a file [#checking]

Import sheet, step 1 of 2. File name, size, detected format ("camt.053
XML"). A checklist with three lines, each ticked as it completes: Read file
→ Check balances → Compare with 1,284 existing transactions. Cancel stays
available until the proposal returns. The host dialog's existing timeout
copy ("Statement validation timed out. Export a shorter period.") is reused.

### 6.3 Preview [#preview]

The key screen. Per statement, a compact reconciliation card: account ·
period · opening balance → closing balance · "Balances match". Then counts as
tabs: **New 42** · **Already imported 188** · **Blocked 0**. The New list
uses the ledger's row component. Warnings from `problems` (for example
"Some transactions lack unique bank references…") render as an info note,
not an error. Footer: "Import 42 transactions" (primary), Cancel. When New is
0: "Nothing new in this file. All 230 transactions were imported before."
with a single Close button.

### 6.4 Import error: balance mismatch [#error-balance]

Error banner "Balances in this statement don't add up". Body: opening
balance, sum of entries, expected closing, closing in the file, difference,
as a two-column figure table. Recovery: Choose another file. The parser
message sits in Technical details.

### 6.5 Import blocked [#conflict]

File import is append-only, so there is no two-way merge. Today's blocking
cases, all thrown as plain strings by `plugin.ts` or the parsers:

| Case (source)                                       | Title                                                              | What we show                                               | Recovery                                                |
| --------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------------------------- | ------------------------------------------------------- |
| Changed reference payload (`importRecords` problem) | "This file changes a transaction you already have"                 | In your table / In this file, differing fields highlighted | Cancel; help text "Export the original statement again" |
| Overlap without references (`plugin.ts`)            | "This statement overlaps an earlier import"                        | the earlier import's period vs this file's                 | "Export a non-overlapping period"                       |
| Repeated reference in file (`plugin.ts`)            | "The same transaction appears twice in this file"                  | the two rows                                               | Choose another file                                     |
| File too large (host dialog)                        | "This statement is larger than 512 KB" (MT940) / "5 MB" (camt.053) | file size                                                  | Export a shorter period                                 |
| JSON-shaped narrative (parser)                      | "This statement has descriptions we can't store safely yet"        | count of affected rows                                     | none; points to the README gap                          |

The side-by-side and period comparisons need **structured errors** (code +
data) instead of strings; see issues.md. Until then these frames degrade to
the title + the plain message.

### 6.6 Populated ledger, wide [#ledger-wide]

Account summary strip, one segment per account + currency: account label,
latest statement closing balance with its date, money in and money out for
the selected period (needs stored statement balances, gap 3). Filter row:
search (description, reference), period chips (This month · Last month ·
This year · Custom), direction (All · In · Out), "Uncategorised" chip.
Ledger grouped by booking date; each day header shows the date and the
day's net per currency. Row: narrative's first line at weight 600 (stands in
for a counterparty until extraction exists), the rest truncated in
text-light, a category chip when set, the amount. Selecting a row opens the
detail panel.

### 6.7 Transaction detail and edit [#detail]

Read-only "From your bank": amount, value date, booking date, account,
reference, transaction code, statement, original narrative (monospace,
verbatim). Editable "Your notes": category (combobox fed by categories
already used in this table) and note (textarea). Saves on blur via
`resource.set(...).save()`, with a quiet "Saved" in the panel footer; a failed
save keeps the value and shows an inline error with Retry. A line "Imported
from statement 00031/1 on 3 Sep 2026" links to the Imports tab. Bank fields
are never editable here: editing them would make reconciliation meaningless,
and `importBaseline` already treats them as imported source values.

### 6.8 Narrow (360px) and dark [#ledger-narrow]

Header row 1: name, status dot, icon import button; row 2: account switcher
full width. The summary strip becomes a horizontally scrolling row in its own
scroll container (never the page). Rows are two lines: description + amount,
then date · category. Detail opens as a full-screen sheet with Back.

### 6.9 Moneybird source states [#sources]

Moneybird is a proxy-backed, read-only source through `store.proxy` (the
relay ops typed in `pets/app/store.ts`). Connection bar states mirror
`pets/app/controller.ts`'s `ViewState`: `no-relay` ("This Atomic Server can't
reach connected services from apps yet"), `disconnected` (Connect
Moneybird), `connecting`, `syncing` ("Syncing financial mutations… 120 of
480"), `synced` ("Moneybird · synced 14:02"), `error` with reauth ("Moneybird
needs you to sign in again" → Reconnect). Moneybird financial mutations show
in the ledger with a small "Moneybird" source tag and are read-only in the
detail panel. This is **next**, not now: there is no Moneybird package or
recorded fixture in this repo (see the money note in `lanes.json`).

### 6.10 No results [#no-results]

Filters active, nothing matches: "No transactions match “Vattenfall” in Last
month." with Clear filters. Never the first-run empty state.

## 7. Interactions

- Dropping a file anywhere on the app starts an import (overlay "Drop to
  check this statement"). The file input stays the accessible path; drag and
  drop is an accelerator.
- Keyboard: `/` focuses search; ↑/↓ move row focus; Enter opens detail; Esc
  closes detail or the import sheet; `i` opens Import. Listed in a `?`
  popover; never fire while focus is in a text field.
- The ledger renders at most 200 rows per window and offers "Show earlier
  transactions" (a button, not infinite scroll). Not measured; the ledger
  issue sets a render budget.
- Totals, day headers and the summary strip recompute from the filtered
  rows, per currency.
- The app subscribes to the table (`store.subscribe`), so a completed import
  or sync appears without reload.

## 8. Accessibility

- At ≥560px the ledger is a `<table>` with a `<caption>` naming account and
  period, `scope` on headers and day headers as `<th scope="rowgroup">`.
  Below 560px it is a `role="list"` of buttons. Amount cells carry an
  `aria-label` in words ("minus 84 euro 30", "plus 1,250 euro").
- The status pill is `role="status"`; a blocking import error moves focus to
  the banner heading (`tabindex="-1"`).
- Import sheet and narrow-width detail are modal dialogs with focus trap and
  focus return; the ≥900px side panel is a labelled, non-modal region.
- Visible `:focus-visible` ring in `--pl-accent`, 2px, offset 2px. Hit
  targets ≥40×40px below 560px.
- `prefers-reduced-motion` disables the working-dot pulse and panel slide.

## 9. Scope

**Now:** iframe app with the Transactions tab (ledger, filters, search,
detail with local category + note), Imports tab (from stored statements),
import sheet with preview, reconciliation cards and designed error states,
the shared shell, responsive layout and dark mode via host tokens.

**Next:** Moneybird read-only source in the same ledger (needs a Moneybird
package + fixture); counterparty name/account from camt.053; category
suggestions from past categorisations.

**Later, not designed in detail:** QuickBooks source (no catalog entry, no
package); a review inbox (QuickBooks-style For review / Excluded); invoice
matching; two-way sync with a bookkeeping platform (would need a Devonian
lens and the conflict pattern shared with the other #89 designs); CSV and PDF
statements; splits; budgets; numeric aggregation in the host's generic table
(needs an exact-decimal datatype; README gap).

## 10. Gaps between this design and today's implementation

1. **No app.** `integrations/money/` has no `app/` folder, `view()` or
   `build.mjs`.
2. **The importer is not callable from an app iframe.** The host's app bridge
   ops are `app, data, get, query, create, save, destroy, patch, context,
navigate, pickResource, pickFile, search, subscribe, unsubscribe`. None runs
   a sandbox importer's proposal and applies it. Until `atomic-server` adds
   one, "Import statement" navigates to the existing host dialog, and the
   in-app import sheet (6.2–6.5) cannot ship. Needs a maintainer decision
   (issues.md, M-8).
3. **Statement balances are not stored.** Opening/closing balances and
   periods are reconciled then dropped. The summary strip and Imports tab need
   a `bank-statement` class (account, currency, number, start, end, opening,
   closing, format, imported-at) written by the importer.
4. **Errors are strings.** The designed error frames need error codes plus
   data from `parser.ts`, `camt053.ts` and `plugin.ts`.
5. **No annotation properties.** Category and note need new schema
   properties (`money-category`, `money-note`) that the importer never
   writes. Whether a category is a string or a link to a Category resource is
   a decision (issues.md, M-5).
6. **No counterparty field.** The ledger's bold first line is the narrative's
   first line, not a counterparty name.
7. **Moneybird is catalog-only.** No package, no fixture, no mapping of
   financial mutations onto ledger rows.
8. **Account labels.** Accounts are raw identifiers; a friendly name ("bunq
   business") would need an Account resource. The design shows the identifier
   grouped in fours and leaves room for a label later.
