# Notion drive plugin: frontend design

Issue #89. This is the design for the **drive plugin** in `../app/` (the
read-only iframe app on `syncables/browser`), not for the sandbox pilot in
`../plugin.ts`, which has no UI entry point. Mockups of every state are in
[`mockups.html`](mockups.html) (open it locally; it has no external
dependencies). The implementation work is split into
[`issues.md`](issues.md).

Everything below is a proposal. Nothing in it has been built, and nothing in
it has been tried with users.

## 1. Where we start from

Today `app/main.ts` renders three elements: an `h1` "Notion", one
`role=status` paragraph, and one button whose label is "Connect Notion" or
"Sync now". After a sync, the paragraph reads, for example, "Last synced
24/09/2026, 10:02:11: 3 created, 0 updated, 0 unchanged, from 1 database."
The imported rows go into the app's data table in the drive, but the app
never shows them. To see them the user has to leave the app and open the
table resource.

Facts about the host that constrain the design (atomic-server `78144ba22`,
read, not run):

- The iframe fills the app page (`AppFrame.tsx`, `min-height: 20rem`). It
  never grows to fit its document, so the app must scroll inside itself.
- The host posts a stylesheet into the frame (`__atomic_style`) with
  `--t-*` theme variables (`useCreateThemeVars.ts`): `--t-color-main`,
  `-bg`, `-bg-body`, `-bg-1`, `-bg-2`, `-text`, `-text-1`, `-text-light`,
  `-text-light-2`, `-alert`, `-warning`, `-main-selected-bg/-fg`,
  `--t-radius` (9px), `--t-font-family` (Open Sans stack),
  `--t-font-family-header` (Montserrat stack), `--t-size-1`..`15`, three
  box shadows, and an `.atomic-button` class. Dark mode is the host swapping
  these values; the frame does not need `prefers-color-scheme`.
- There was no green/success token. Since atomic-server 007869464 the host
  sends `--t-color-success`; the design keeps a fallback literal for older
  hosts (section 8). The theme message also carries `colorScheme`
  (`store.getTheme()`, `store.onThemeChange()`), so the app sets its
  `color-scheme` from the host's setting rather than guessing.
- "One module, no stylesheet": the drive plugin ships one JS file, so its CSS
  must be injected by `view()` as a `<style>` element.

What the data looks like after `syncNotion` (`app/sync.ts`):

- All data sources shared with the connection land in **one** table. Each
  row has `name`, "Notion page id", "Data source" (the database title),
  "Notion URL", "Last edited in Notion", and one column per projected Notion
  property, keyed by the property's stable id.
- Two databases whose properties share an id (every title property is
  `title`) share a column; two "Status" properties with different ids become
  two columns both named "Status".
- Select, status and multi-select cells hold Notion **option ids**, not
  names or colours. Rendering them as-is would show UUIDs.
- Projected types: title/plain text, number, checkbox, url, email, phone,
  select/status/multi-select option ids. Date, people, relation, formula,
  rollup, files, and formatted rich text are not projected.
- Last-sync time and counts exist only in memory (`controller.ts`); they are
  lost on reload.

## 2. Who uses it, for what

The user already keeps work in Notion and wants it in their own Atomic drive.
Ranked jobs:

1. **Bring my Notion databases into Atomic** and keep them fresh, without
   copying anything by hand. (Supported today, invisibly.)
2. **Look things up** in that copy without leaving Atomic: find a row,
   scan a status, open the original in Notion. (Not supported: no rows are
   shown.)
3. **Trust the copy**: know how fresh it is, which databases it covers, and
   what did _not_ come across (skipped property types, formatted text,
   archived pages). (Partly: one sentence with warnings joined by `;`.)
4. **Fix access** when Notion revokes it or a database is not shared.
   (Not supported: every failure is "Import failed: <message>".)
5. _Later:_ **edit a row in Atomic and send it to Notion**, and resolve the
   case where both sides changed. (Only the sandbox pilot can write.)

## 3. What competitors do, and what we take

Studied from public help pages (September 2026), not hands-on.

- **Notion itself** (databases): table, board, list, gallery, calendar,
  timeline views over one database. Column headers carry a property-type
  glyph; select/status values are coloured pills; opening a row uses _side
  peek_ by default in table, board and list, keeping the view interactive on
  the left. _We take:_ type glyphs, coloured pills in Notion's ten colour
  names, side peek, and table/board/list as the first three views.
- **Coda Pack sync tables**: the synced table carries its own refresh
  control with a settings menu next to it (auto-refresh, which account,
  "Enable edits"). Two-way edits are held locally and sent with an explicit
  "Update rows" action; a row that fails to update shows an error attached
  to that row. _We take:_ sync controls live on the view's own bar, not on a
  separate settings page; for two-way (later), edits are pending until sent,
  and a failed row carries its own error.
- **Airtable Sync** (incl. multi-source): several sources merge into one
  table with a "Sync source" field and an "Open source record" button; a
  warning icon on the table for "Unable to sync this source" with a
  re-authenticate action; "Synced table hasn't updated in a while" with
  "Sync now". Sync from external apps is one-way. _We take:_ the source
  column plus per-source scoping; one warning marker and one recovery action
  per failure kind; an explicit staleness hint.

Where we deliberately differ: we never hide what was skipped. The sync
details list every property type and page we did not import, because the
copy is the user's own data and they need to know when it is partial.

Sources: [Notion views](https://www.notion.com/help/views-filters-and-sorts),
[Notion view types](https://www.notion.com/help/guides/when-to-use-each-type-of-database-view),
[Coda two-way sync tables](https://coda.io/packs/build/latest/guides/blocks/sync-tables/two-way/),
[Airtable multi-source sync](https://support.airtable.com/articles/6877414132-multi-source-syncing-in-airtable),
[Airtable sync troubleshooting](https://support.airtable.com/articles/3283647378-troubleshooting-syncs-in-airtable).

## 4. Shared visual language (with sibling plugin designs)

The Calendar, Money and Timesheets designs for #89 were written in parallel.
This design adopts the shell proposed in the Money design, which Timesheets
also adopted, so the plugins look like one family:

- **Header row**: plugin mark + name | _source chips_ | _status pill_ |
  one primary action. For Notion the source chips are the shared databases.
- **Connection bar** under the header: what we are connected to, the access
  model in one phrase ("Read-only"), a details disclosure and a menu.
- **Status pill** states: `Synced 4 min ago` (neutral, green dot),
  `Syncing…` (accent), `Synced · 3 notes` (warning), `Sync failed` (alert),
  `Reconnect needed` (alert).
- **Empty** = centred mark + one sentence + one primary button (+ an
  optional secondary link). **Error** = inline banner with the cause and
  exactly one recovery action.
- **Tokens** `--pl-*`, each mapped from a host `--t-*` variable (section 8).
  Shared shell classes use the `pl-` prefix; Notion-specific parts use
  `nt-`.

Under the plugin-folder containment rule each plugin implements this shell
in its own folder. Extracting a shared `pl-` kit is a maintainer decision
(section 12).

## 5. Information architecture

```
┌ Header ──────────────────────────────────────────────────────────────┐
│ [N] Notion   [All 45] [Product roadmap 24] [Reading list 12] [Hiring 9]│
│                                      (● Synced 4 min ago)  [Sync now] │
├ Connection bar ──────────────────────────────────────────────────────┤
│ Acme Studio · 3 databases · Read-only            Sync details ▾   ⋯  │
├ Toolbar ─────────────────────────────────────────────────────────────┤
│ [Table|Board|List]   Search rows…            Sort: Last edited  45   │
├ View ──────────────────────────────────────────┬ Side peek (one row) ┤
│ table / board / list                            │ title, properties,  │
│                                                 │ Open in Notion      │
└─────────────────────────────────────────────────┴─────────────────────┘
```

- **Scope** = the source chip. "All" shows the columns every database has
  (Name, Database, Last edited) plus any column whose _name and type_ all
  databases share. A single-database chip shows exactly that database's
  columns, in Notion's property order. This fixes "two columns called
  Status" at the presentation layer; it needs a per-database column list
  (issue N6).
- **View** = Table (default at ≥ 640px), Board (grouped by a status or
  select column of the selected database; disabled on "All" with a tooltip
  saying why), List (default below 640px). The choice is remembered per app
  in `localStorage`, wrapped in `try`; losing it is harmless.
- **Sync details ▾** opens a panel: per database, rows created / updated /
  unchanged, skipped properties by type, pages whose formatted text was not
  imported, archived pages kept.
- **⋯ menu**: "Choose pages in Notion" (re-runs the connect flow, see
  section 12), "Open data table" (`store.openResource`, host navigation to
  the drive table), "Disconnect Notion…" (`store.proxy.disconnect`, after a
  confirmation; it removes only this app's delegation, and the rows stay).
  The last two exist since atomic-server 007869464 and are hidden on an
  older host.

## 6. Screens and states

Each maps to a controller state; states marked _new_ do not exist in
`ViewState` today. The mockup id is in the first column.

| #   | State                                         | Trigger                                          | What the user sees                                                                                                                            | Primary action            |
| --- | --------------------------------------------- | ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------- |
| S1  | `no-proxy`                                    | host lacks `store.proxy`                         | Empty card: "This Atomic Server can't connect apps to other services yet." plus what to ask an administrator                                  | none                      |
| S2  | `not-connected` (first run)                   | no connection for `notion`                       | Empty card with Notion mark, one sentence, three facts (what is copied; read-only; you pick the pages in Notion)                              | Connect Notion            |
| S3  | `connecting`                                  | after Connect, until the host navigates          | Same card, button busy "Waiting for confirmation…"; hint that the bar above asks first, then Notion asks which pages to share                 | Cancel (in host bar)      |
| S4  | `importing` _new_ (first import, table empty) | ready, no rows yet                               | Per-database progress list (name, "Reading… 48 pages", check when done) above skeleton rows                                                   | none                      |
| S5  | `no-databases` _new_                          | search returns 0 data sources                    | Empty card: "Notion didn't share any databases with Atomic." plus three steps to share one                                                    | Choose pages in Notion    |
| S6  | `ready`, populated                            | rows exist                                       | Header, bar, toolbar, table                                                                                                                   | Sync now                  |
| S7  | side peek                                     | click or Enter on a row                          | 400px panel: title, database, property list with type glyphs, last edited, "Open in Notion", read-only note, skipped properties for this page | Open in Notion            |
| S8  | board                                         | View = Board on one database                     | One column per status/select option in Notion's order; card = title + two properties; count per column; read-only (no drag)                   | —                         |
| S9  | `syncing` over data                           | Sync now, or on open when stale                  | Content stays usable; pill "Syncing… Reading list"; rows that changed get a short highlight                                                   | (disabled)                |
| S10 | `ready` + warnings                            | last sync had warnings                           | Pill "Synced · 3 notes" (warning); Sync details lists them grouped                                                                            | Sync details              |
| S11 | `reauth` _new_                                | proxy answers 401/403, or the connection is gone | Alert banner: "Notion no longer gives Atomic access. Your 45 rows are kept."                                                                  | Reconnect Notion          |
| S12 | `rate-limited` _new_                          | 429 with `retry-after`                           | Warning banner: "Notion asked Atomic to slow down. Trying again at 14:32."                                                                    | Try now                   |
| S13 | `failed`                                      | any other error                                  | Alert banner with the cause in plain words and a "Technical details" disclosure                                                               | Try again                 |
| S14 | narrow (< 640px)                              | frame width                                      | Chips become a `<select>`; List view; side peek becomes a full-frame sheet                                                                    | —                         |
| S15 | _later_: two-way edit                         | Devonian write bridge (#8 item 2)                | Editable cells; pending bar "2 changes not sent to Notion · Review · Send"                                                                    | Send to Notion            |
| S16 | _later_: conflict                             | Notion page changed since our baseline           | Row marked; conflict panel with Atomic vs Notion value per property                                                                           | Keep Atomic / Keep Notion |

Copy rules: use words the user recognises ("database", "page", "row"), never
"data source", "connection id", "projection" or "lens" in primary text.
HTTP status and request path go behind "Technical details", for bug reports.

## 7. Interactions

- **Open**: show cached rows from the drive table at once (they are already
  there), then sync in the background if the last sync is older than 15
  minutes or unknown. Today the app syncs on every open and shows nothing
  until it is done.
- **Sync now** is always in the header, disabled while syncing. The pill
  carries progress text (`role=status`, updated once per database, not per
  page, so screen readers are not flooded).
- **Search** filters on title and text columns, client-side, as you type
  (150 ms debounce). **Sort** by clicking a column header (ascending,
  descending, off); default "Last edited in Notion", newest first.
- **Rows**: click or Enter opens the side peek; Esc closes it and returns
  focus to the row; ↑/↓ move between rows while the peek is open, as in
  Notion.
- **Large tables**: render the first 200 rows, then "Show 200 more". No
  virtualisation in the first version. The row count at which the frame gets
  slow is not measured.
- **Links**: "Open in Notion" and url values open through
  `store.openExternal` (atomic-server 007869464): the host names the
  destination, asks, and opens it with no opener. The frame itself has no
  popup rights. Only http(s) opens, so email addresses and phone numbers are
  selectable text. On a host without `openExternal`, or when it refuses, the
  URL is shown as selectable text with a copy button.
- **Two-way (later)**: an edit marks the cell (accent dot) and adds it to the
  pending bar; nothing is sent until "Send to Notion". A row whose Notion
  page changed since our baseline goes to the conflict panel instead of
  being sent. No delete is ever inferred. This mirrors the pilot's rules in
  `model.ts` (pause before unsafe writes; a missing page is a conflict).

## 8. Theme, tokens, type

All colours come from host variables through `--pl-*`, so light/dark and the
user's main colour follow the host:

| `--pl-*`           | host variable                | role                                  |
| ------------------ | ---------------------------- | ------------------------------------- |
| `--pl-bg`          | `--t-color-bg-body`          | frame ground                          |
| `--pl-surface`     | `--t-color-bg`               | table, cards, peek                    |
| `--pl-subtle`      | `--t-color-bg-1`             | header row, hover, chips              |
| `--pl-border`      | `--t-color-bg-2`             | hairlines                             |
| `--pl-text`        | `--t-color-text`             | primary text                          |
| `--pl-muted`       | `--t-color-text-light`       | secondary text                        |
| `--pl-accent`      | `--t-color-main`             | primary button, focus ring, selection |
| `--pl-accent-soft` | `--t-color-main-selected-bg` | selected row and chip                 |
| `--pl-neg`         | `--t-color-alert`            | error, reauth                         |
| `--pl-warn`        | `--t-color-warning`          | warnings, rate limit                  |
| `--pl-pos`         | `--t-color-success`          | synced dot, check marks               |
| `--pl-radius`      | `--t-radius`                 | 9px                                   |

Each is declared with a fallback (`var(--t-color-bg, #fff)`), so the app is
legible before the host's style message arrives. `--pl-pos` falls back to
`#2f8f5b` on hosts before 007869464; it passes 3:1 against both white and
black grounds for a dot and a check mark, but is not used for text.

**Notion option colours**: pills use Notion's ten colour names (default,
gray, brown, orange, yellow, green, blue, purple, pink, red) as a fixed
table of hues, blended into the surface with
`color-mix(in srgb, <hue> 22%, var(--pl-surface))`, so they work on both
grounds. Pill text is `--pl-text`, never the hue, for contrast. This needs
option names and colours, which the sync does not store yet (N7).

**Type**: `--t-font-family` (Open Sans) for everything; Montserrat
(`--t-font-family-header`) only for the plugin name and empty-state
headings. Numbers are right-aligned with `tabular-nums`. Sizes: 13px table
cells and labels, 14px body, 18px empty-state headings.

## 9. Accessibility

- The table is a real `<table>` with `<th scope=col>` and `aria-sort` on the
  sorted column. Board and list are `<ul>`s of buttons.
- Status is always text, never colour alone; dots are decorative. Option
  pills carry the option name.
- One `role=status` region (the pill) for progress. Banners use
  `role=alert` only when they appear after an action.
- The side peek is a non-modal `<aside aria-label="Row details">` on wide
  frames, and a modal `<dialog>` (focus trapped, Esc closes) below 640px.
- Focus ring: 2px `--pl-accent` outline with 2px offset on every
  interactive element. Targets at least 32px high on wide frames, 44px
  below 640px.
- Checkbox cells render as a check mark or a dash with
  `aria-label="Yes"`/`"No"`, not as disabled inputs.
- `prefers-reduced-motion`: no spinner rotation, no row highlight fade.

## 10. Responsive

Plugin frames range from about 360px to 1200px wide:

- **≥ 960px**: header on one row; table and a 400px side peek side by side
  (the table keeps at least 520px, otherwise the peek overlays).
- **640–959px**: chips scroll horizontally in their own track; the side
  peek overlays the table from the right (`min(400px, 90%)`).
- **< 640px**: the header stacks (name, pill and Sync on row 1; a database
  `<select>` on row 2); the connection bar collapses to one line plus "⋯";
  List is the default view (a card per row: title, database, two
  properties, last edited); the peek is a full-frame sheet. Table stays
  available and scrolls horizontally in its own container, with the title
  column sticky.

## 11. Scope

**Now (read-only; issues N1–N12):** shell and tokens; richer controller
states with a persisted last sync; progress; reading rows back; table, list
and board views; source scoping with per-database columns; option names and
colours; side peek; sync details; all empty and error states; responsive and
accessible behaviour; mock-proxy e2e for each state.

**Later (sketched, not specified to implementation detail):** two-way edit,
pending changes and conflict review (S15, S16; blocked on the Devonian write
bridge, #8 item 2); date, people, relation and formula columns (lens
coverage); calendar and timeline views (need dates); choosing inside Atomic
_which_ shared databases to import (today: all shared ones); disconnect from
inside the app; background sync (#10).

## 12. Gaps vs today, and decisions needed

Gaps the implementation must close (each is an issue in `issues.md`):

1. Rows are never shown in the app (N4, N5, N8).
2. Option ids, not names and colours, are stored (N7).
3. Columns of different databases merge by property id; same-named columns
   are indistinguishable (N6).
4. Every error is one string; there is no reauth, rate-limit or
   "nothing shared" state (N2).
5. The last sync lives in memory only (N2).
6. No progress while a multi-database import runs (N3).
7. Sync runs on every open and the view shows nothing until it ends (N2,
   N4).
8. Warnings are joined into one sentence (N10).

Decisions for the maintainer:

- **Shared shell kit.** Four plugin designs now specify the same `pl-`
  header, connection bar, pill and banner. Keep one copy per plugin (the
  containment rule as written), or allow one shared module (for example
  `integrations/plugin-ui/`)? This design assumes copies.
- **Where to persist last-sync metadata and the option dictionary.**
  _Decided_ (#144): one JSON text property, `notion-sync-record`, on the
  app's data table resource. It holds the last sync's time, duration and
  counts, and per database its schema in Notion's order (property names,
  types, option names and colours) and its grouped warnings, so the option
  dictionary is part of the same record rather than a second property. Its
  Property sits in the app's ontology but not in the row class, so it is
  never a table column. This follows the decision that plugin data and sync
  state live as resources on the drive. The pinned host accepts the write
  (the #144 e2e reloads and reads it back). A sync that fails keeps the
  previous record.
- **Auto-sync-on-open threshold**: 15 minutes proposed.
- **"Choose pages in Notion".** Whether re-running `store.proxy.connect`
  for an existing connection re-opens Notion's page picker is not verified
  against a real proxy. If it does not, S5's and the menu's action become a
  link to Notion's own connection settings with written steps.
