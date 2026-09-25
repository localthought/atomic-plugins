# Bank statements (MT940 and camt.053)

## Setup

This needs an atomic-server with the generic file entry point
(atomic-server#1653: manifest `accepts` and `destination`, and the Import tab
on a plugin's page; merged as atomic-server#1691). The pinned
`.atomic-server-ref`, `bc39dac4b`, includes it; see [Verified](#verified).

1. **Publish** (once per server, by whoever maintains it): create a Plugin,
   replace its source with this folder's `plugin.js`, name it "Bank
   statements", and choose Code → Publish to integration store. There is no
   generic path from this repo's catalog to a server's store yet
   (atomic-plugins#94), so this step is manual.
2. **Find it**: Integrations → Show experimental plugins → Community
   plugins → Bank statements → Open → Create draft.
3. **Set up**: on the draft's Import tab, choose Set up. This creates the
   banking properties and the Bank transaction and Bank statement classes in
   the drive ontology, and two tables with default views beneath the
   importer: Bank transactions, and Imported statements (one row per
   statement with its reconciled opening and closing balances, through the
   manifest's `destination.tables`, atomic-server#1768). It stores
   `{ table, rowClass, properties, tables: { statements: { table, rowClass } } }`
   as the importer's config, under the key `money`. An importer set up before
   the statements table existed pauses on the missing `tables`; running Set
   up again adds only the missing table.
4. **Import**: choose an MT940 or camt.053 (ISO 20022 XML) file, then
   Preview import, then Apply. The format is detected from the file contents:
   XML is read as camt.053, and anything else as MT940. Nothing is written
   before Apply. Come back to the same Import tab for later files; "Open
   workspace" opens the table.

bunq exports: bank account → Settings → Export statement → MT940.
https://help.bunq.com/en-ie/articles/how-do-i-export-a-bank-statement

## Architecture

`plugin.ts` bundles both readers (`parser.ts` for MT940, `camt053.ts` for
camt.053, dispatched by `statement.ts`) and the mapping into `plugin.js`. The
sandbox has no DOMParser, so `camt053.ts` carries a small namespace-agnostic
XML reader of its own. File acquisition is host UI code: the manifest's
`accepts` entry makes atomic-server draw the file picker, check the size
(5,000,000 bytes, the camt.053 limit) and decode the file (UTF-8, else
Windows-1252). The host hands the result to `run()` as
`ctx.upload = { name, mediaType, size, text }`; `ctx.text` and
`ctx.trigger.payload.text`, which the removed host dialog used, are still
read for one release. Proposal generation runs in the server QuickJS/WASM
host, which supplies scoped query/read access. The manifest's `destination`
(`bankingSchema()` plus the table name, row class and default columns) is
what Set up creates; the plugin itself never creates schema.
No network operations or secrets are declared. File contents are runtime input,
not plugin source. Proposals and approved transactions contain financial data
and are handled by the user's AtomicServer; they are not sent to an LLM.

`app/` is a separate drive app (shape 1 in AGENTS.md), the Money view of the
same Bank transactions table ([design](design/DESIGN.md), #89). It never runs
in the QuickJS sandbox and never writes imported bank fields: the importer
above stays their only writer. `app/build.mjs` bundles it to one ES module
exporting `view({ root, store })`, with no stylesheet file and no network
code. It reads the table the host points it at (`store.getData()`), finds the
banking properties through the table's row class, and subscribes to the table
so rows from a new import appear without a reload.

Amounts are exact signed decimal **strings**, not floating point numbers.
Opening/closing balances are reconciled with integer arithmetic (up to five
fractional digits). Dates have no inferred time zone. Original :86: descriptions
are retained verbatim, including bank-specific structured codes. Bank account
identifiers are preserved, not assumed to be IBANs. Schema term descriptions
record these meanings; this is not a frozen or ISO 20022-certified schema.

Bank references identify transactions within an account, currency and export
format: importing the same period once as MT940 and once as camt.053 yields two
sets of rows, because the two formats carry different narratives and a shared
identity would surface that as a conflict instead. A changed reference payload
blocks the import. Without references, statement metadata and
line position identify records; content fingerprints block ambiguous overlap
with earlier exports. Identical legitimate rows within a statement are retained.
Import is append-only: local edits are not overwritten. Deleted imports may be
recreated on another import. Native `localId` identities are unique within the destination on one AtomicServer: a
concurrent duplicate create is rejected and must be previewed again. The shared
`importBaseline` records source values and protects local edits. Independent
offline peers still need collision resolution after synchronization.

## Supported scope and gaps

- Up to 500 entries; MT940 up to 512 KB (UTF-8 or Windows-1252 text), camt.053
  up to 5 MB (UTF-8 XML, which is what ISO 20022 mandates).
- MT940: :20:, :21:, :25:, :28:/28C:, :60F:/60M:, :61:, :86:, :62F:/62M:, :64:, :65:.
- camt.053 (.001.02 through .001.08 element names): one or more `Stmt` per
  `BkToCstmrStmt`; `Acct/Id` IBAN or `Othr/Id`; `OPBD` (or `PRCD`) and `CLBD`
  balances, reconciled against the booked `Ntry` amounts; `BookgDt`/`ValDt` as
  `Dt` or `DtTm`; `BkTxCd` domain/family/sub-family or proprietary code;
  `AcctSvcrRef` as bank reference, `EndToEndId` (when provided) or `NtryRef` as
  reference; counterparty name and account, `RmtInf` lines, `AddtlTxInf` and
  `AddtlNtryInf` as the narrative. Entries with a status other than `BOOK` are
  left out, since only booked entries move the booked balances. A batch entry
  with several `TxDtls` stays one row.
- Credit/debit reversals, optional booking dates (value date fallback), multiple
  statements/accounts, multiline transaction narratives.
- Unsupported fields, missing balances and reconciliation failures block import.
- JSON-shaped narratives are rejected because legacy storage reinterprets those
  strings. This needs a general text-preservation fix before enabling them.
- No live bank access, payments, CSV/PDF, counterparty extraction or categorization.
- Amount columns cannot yet use numeric table aggregation; an exact decimal
  datatype/table formatter is a follow-up.
- Historical: a supplied real bunq statement with 272 transactions passed
  preview, apply and zero-change reimport locally on 2026-09-11, through the
  since-removed `ImportMT940` upload dialog. Private bank data is not committed. Synthetic fixtures
  test format behavior; this does not establish compatibility with every bank's
  dialect.
- `money-category` and `money-note` (the person's own category and note,
  edited in the Money app) are declared on the Bank transaction class but
  never written by the importer, so a reimport leaves them alone
  (`plugin.test.ts`). The category is free text; a Category resource was
  the alternative (issues.md M-5) and is not built. Installations set up
  before these properties existed do not have them: running Set up again
  goes through `ensureSchema`, which creates missing terms by `localId`,
  but whether it also adds them to an existing class's `recommends` is not
  verified. Until the class declares both, the app shows Category and Note
  as unavailable instead of writing undeclared properties.
- Set up reuses the table and view (found by `localId` beneath the importer)
  when it runs again after a lost response. Schema creation goes through the
  host's `ensureSchema`, which finds existing terms by `localId`.
- The file entry point is generic (any plugin declaring `accepts`), but it
  takes one text file per preview; no bytes, no several files at once.
- Installation is Create draft from a published release. A reviewed
  Installation (Install instead of Create draft) has no Import tab at this
  host commit.

Reference: https://bankrec.westpac.com.au/docs/statements/mt940/

Tests: `./browser/node_modules/.bin/vitest run --config integrations/money/vitest.config.ts`
(`parser.test.ts` for MT940, `camt053.test.ts` for camt.053 and format
detection, `plugin.test.ts` for the manifest declaration and `ctx.upload`).
Bundle: `./browser/node_modules/.bin/esbuild integrations/money/plugin.ts --preserve-symlinks --bundle --format=esm --platform=neutral --target=es2022 > integrations/money/plugin.js`
Browser: `node integrations/tooling/run-lane.mjs money --tier e2e` runs
`e2e/money.spec.ts` against `ATOMIC_SERVER_CHECKOUT`'s `target/e2e` build.

## Money app (`app/`)

A drive app (DESIGN.md in [`design/`](design/DESIGN.md), #89) that shows the
Bank transactions table as a ledger. It is a view of the table it is opened
on (`store.getData()`), so it belongs on the importer's table as an app
view; the table's own Table tab stays next to it.

- **Transactions**: account switcher (account + currency), a strip per
  account + currency (never summed across currencies) with the latest stored
  closing balance in the period and its date, or the period's net where no
  statement ends in it (never a balance computed from rows), money in and
  out; search over description and reference, period, direction and
  Uncategorised filters, a day-grouped ledger (a table at 560 px and wider,
  a list of buttons below), 200 rows at a time. Amounts are formatted from
  their exact strings (`app/amounts.ts`); sums use `parser.ts`'s `units()`.
- **Detail**: the bank's fields read-only with the verbatim narrative;
  category and note (`money-category`, `money-note`) saved on change. The
  host lets an app edit the rows of the table it views only after the
  person allows it (`rowAccess`/`requestRowAccess`, atomic-server#1788):
  the detail says so up front, saving asks in the host's bar while the typed
  text stays, and a refusal is shown with a way to ask again.
- **Import statement**: checks a chosen or dropped file in the browser
  with the importer's own readers and identity rules (`app/check.ts`,
  `identity.ts`), shows the reconciliation per statement and what is new,
  already imported or blocked, or a designed error, and then imports it
  through the importer with the host's own review (`importer.run`,
  atomic-server#1774). Nothing is written before Apply there.
- **Imports**: the stored statements, with period, opening → closing,
  entries and import date; on a table without them, one row per statement
  the transactions came from.
- **Sources**: statement files; Moneybird and QuickBooks shown as not
  available yet.

Each host call is feature-detected (`getMany`, `getTheme`/`onThemeChange`,
`--t-color-success`, `openResource`, `rowAccess`, `importer.run`,
`getData().tables`), so on an older host the app falls back: rows one by
one, a pointer to the importer's Import tab instead of Import, the host's
refusal instead of a save, statements derived from the rows.

Evidence: unit tests with a fake store that models both a current and an
older host (`app/*.test.ts`), screenshots and axe from
`app/harness/screenshots.mjs`, and a host E2E test in `e2e/money.spec.ts`
against `bc39dac4b`: it sets up the importer, installs the built app
test-side as a new App that renders bank transactions, adds it as a
read-only view through Add view, imports the synthetic MT940 from inside
the app through the host's review, checks the strip's closing balance and
the Imports tab, saves a category after clicking the host's "Allow
editing", and checks the in-app check (nothing new; a changed transaction
blocks). Not yet: installing from the catalog (no catalog entry).

Build: `node integrations/money/app/build.mjs` (writes `app/dist/ui.js`,
minified, one module). Screenshots, axe and the render budget:
`node integrations/money/app/harness/screenshots.mjs --axe` (writes to
`app/dist/screenshots/`).

## Verified

`e2e/money.spec.ts` passed on 2026-09-25 against the pinned atomic-server
`bc39dac4b` (earlier against `007869464`, `11264e83e` and `2f403624e`, which includes #1691,
the change for atomic-server#1653), with this package at version 0.2.0
(`plugin.js` sha256 `a8f84cd07899984529b505d2719e83b1ec4bed805c9e2459e895c0956f784efe`,
the bundle with the annotations, structured errors and the statements
table). The
spec picks the release it just published by its id, so it also passes on a
lane store kept from earlier runs (checked twice in a row). It covers these
steps, all with the synthetic files in `fixtures/` and generated variants:

- publish, then discover under Community plugins, then create a draft;
- Set up, then an MT940 preview (2 new transactions and their statement,
  "Apply 3 changes", "1 statements reconciled"), then
  Apply, then a full page reload, then the rows in the table;
- a reimport of the same file: "2 previously imported transactions skipped",
  and nothing to apply;
- a local edit to an imported description, which survives the reimport. A
  statement whose already-imported transaction changed at the bank is shown
  as a conflict and blocked, and the edit is still there afterwards;
- camt.053 of the same period: 2 new rows (identities are per format), then
  a reimport skips both;
- these files are refused with an error message, no preview dialog, and no
  write (the first real import afterwards still proposes exactly 2):
  - an unbalanced statement ("does not reconcile");
  - a non-statement text file;
  - malformed XML;
  - an MT940 file over 512 KB;
  - 501 transactions ("at most 500");
  - a file over 5,000,000 bytes (refused by the host before it is read);
- an MT940 export in Windows-1252, whose "Café" narrative the host decodes
  correctly (checked in the preview).

Not verified: other banks' dialects beyond the fixtures (the 2026-09-11 bunq
check above was on the old host path), an Installation (as opposed to a
draft), and the host's server-side size refusal through the browser (it has
a Rust unit test in atomic-server, `uploads_need_a_declaration_and_respect_its_size`).
