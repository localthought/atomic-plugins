// @wc-ignore-file
/**
 * The Notion view's regions, each a function of a `ViewContext`: toolbar,
 * table, board, list, side peek, sync details, first-import progress, and
 * the per-state banners and empty states. `app.ts` owns the state and calls
 * these on every render.
 */
import type { ConnectedState, ViewState } from '../controller.js';
import type { Row } from '../rows.js';
import type { SyncProgress } from '../sync.js';
import { byKey, h, icon, type Child } from '../ui/dom.js';
import { clock, plural, when } from '../ui/format.js';
import {
  button,
  emptyGlyph,
  renderBanner,
  renderCopy,
  renderEmpty,
} from '../ui/shell.js';
import {
  glyphFor,
  isNumeric,
  optionPill,
  renderValue,
  typeName,
  type CellContext,
} from './cells.js';
import {
  ALL,
  cellValue,
  columnsFor,
  groupable,
  groupRows,
  nextSort,
  OPTION_TYPES,
  type Source,
  type Sort,
  type ViewColumn,
  type ViewKind,
} from './model.js';

export const PAGE_SIZE = 200;

export interface UiState {
  scope: string;
  /** Chosen view; `undefined` follows the frame width. */
  view?: ViewKind;
  query: string;
  sort: Sort | null;
  limit: number;
  selected?: string;
  details: boolean;
  menu: boolean;
  groupBy?: string;
  /** A link that could not open in a new tab: its row shows it to copy. */
  linkFallback?: { subject: string; href: string };
}

export interface ViewContext extends CellContext {
  ui: UiState;
  state: ConnectedState;
  sources: Source[];
  columns: ViewColumn[];
  /** Rows in scope, searched and sorted. */
  visible: Row[];
  /** Rows in scope before search. */
  scoped: Row[];
  view: ViewKind;
  size: 'narrow' | 'medium' | 'wide';
  flash: ReadonlySet<string>;
  /** Whether a banner is the answer to an action (role=alert). */
  alert: boolean;
  searchInput: HTMLInputElement;
  fallback: ReadonlyMap<string, { name: string; datatype: string }>;
  update(patch: Partial<UiState>): void;
  open(subject: string | undefined): void;
  sync(): void;
  connect(): void;
}

const fixedName = (column: ViewColumn) =>
  column.type === 'edited' ? 'Last edited' : column.name;

// ---------------------------------------------------------------- toolbar

export function renderToolbar(ctx: ViewContext): HTMLElement {
  const { doc, ui } = ctx;
  const groupColumns = groupable(ctx.columns);
  const boardReason =
    ui.scope === ALL
      ? 'Choose one database to see it as a board'
      : groupColumns.length
        ? undefined
        : 'This database has no status or select property to group by';
  const seg = h(
    doc,
    'div',
    { class: 'nt-seg', role: 'group', 'aria-label': 'View' },
    (
      [
        ['table', 'Table', 'table'],
        ['board', 'Board', 'board'],
        ['list', 'List', 'list'],
      ] as const
    ).map(([kind, label, glyph]) =>
      h(
        doc,
        'button',
        {
          type: 'button',
          'aria-pressed': ctx.view === kind ? 'true' : 'false',
          disabled: kind === 'board' && !!boardReason,
          title: kind === 'board' ? boardReason : undefined,
          'data-key': `view:${kind}`,
          onclick: () => ctx.update({ view: kind, selected: undefined }),
        },
        icon(doc, glyph),
        label,
      ),
    ),
  );

  const search = h(
    doc,
    'label',
    { class: 'nt-search' },
    icon(doc, 'search'),
    h(doc, 'span', { class: 'pl-sr' }, 'Search rows'),
    ctx.searchInput,
  );

  let label: Child = null;

  if (ctx.view === 'board') {
    const group = boardGroupColumn(ctx);
    if (group)
      label =
        groupColumns.length > 1
          ? h(
              doc,
              'label',
              { class: 'nt-sortlabel' },
              'Grouped by ',
              h(
                doc,
                'select',
                {
                  'data-key': 'groupby',
                  onchange: (event: Event) =>
                    ctx.update({ groupBy: (event.target as HTMLSelectElement).value }),
                },
                groupColumns.map(c =>
                  h(doc, 'option', { value: c.key, selected: c.key === group.key }, c.name),
                ),
              ),
            )
          : h(doc, 'span', { class: 'nt-sortlabel' }, 'Grouped by ', h(doc, 'b', {}, group.name));
  } else {
    const sorted = ui.sort && ctx.columns.find(c => c.key === ui.sort!.key);
    label = h(
      doc,
      'span',
      { class: 'nt-sortlabel' },
      sorted
        ? ['Sorted by ', h(doc, 'b', {}, fixedName(sorted))]
        : 'Unsorted',
    );
  }

  const total = ctx.scoped.length;
  const shown = ctx.visible.length;

  return h(
    doc,
    'div',
    { class: 'nt-toolbar' },
    seg,
    search,
    label,
    h(
      doc,
      'span',
      { class: 'nt-count' },
      shown === total ? plural(total, 'row') : `${shown} of ${plural(total, 'row')}`,
    ),
  );
}

export function boardGroupColumn(ctx: Pick<ViewContext, 'columns' | 'ui'>) {
  const candidates = groupable(ctx.columns);

  return candidates.find(c => c.key === ctx.ui.groupBy) ?? candidates[0];
}

// ---------------------------------------------------------------- table

function moveFocus(ctx: ViewContext, from: Row, delta: number) {
  const at = ctx.visible.findIndex(r => r.subject === from.subject);
  const next = ctx.visible[at + delta];
  if (!next) return;
  if (ctx.ui.selected) ctx.open(next.subject);
  const el = ctx.doc.querySelector<HTMLElement>(byKey(`row:${next.subject}`));
  el?.focus();
}

const rowKeys = (ctx: ViewContext, row: Row) => (event: Event) => {
  const key = (event as KeyboardEvent).key;
  if (key === 'Enter' || key === ' ') {
    event.preventDefault();
    ctx.open(row.subject);
  } else if (key === 'ArrowDown' || key === 'ArrowUp') {
    event.preventDefault();
    moveFocus(ctx, row, key === 'ArrowDown' ? 1 : -1);
  } else if (key === 'Escape' && ctx.ui.selected) {
    ctx.open(undefined);
  }
};

export function renderTable(ctx: ViewContext): HTMLElement {
  const { doc, ui } = ctx;
  const rows = ctx.visible.slice(0, ui.limit);
  const head = h(
    doc,
    'tr',
    {},
    ctx.columns.map(column => {
      const sorted = ui.sort?.key === column.key ? ui.sort.dir : undefined;

      return h(
        doc,
        'th',
        {
          scope: 'col',
          class: isNumeric(column) ? 'num' : undefined,
          'aria-sort': sorted ? (sorted === 'asc' ? 'ascending' : 'descending') : undefined,
        },
        h(
          doc,
          'button',
          {
            type: 'button',
            class: 'nt-th',
            'data-key': `th:${column.key}`,
            onclick: () => ctx.update({ sort: nextSort(ui.sort, column.key) }),
          },
          icon(doc, glyphFor(column.type)),
          column.name,
          sorted &&
            h(doc, 'span', { class: 'nt-sortmark' }, icon(doc, sorted === 'asc' ? 'up' : 'down', 'sm')),
        ),
      );
    }),
  );

  const body = h(
    doc,
    'tbody',
    {},
    rows.map(row =>
      h(
        doc,
        'tr',
        {
          tabindex: 0,
          'data-key': `row:${row.subject}`,
          'aria-selected': ui.selected === row.subject ? 'true' : undefined,
          class: ctx.flash.has(row.subject) ? 'nt-flash' : undefined,
          onclick: () => ctx.open(row.subject),
          onkeydown: rowKeys(ctx, row),
        },
        ctx.columns.map(column =>
          h(
            doc,
            'td',
            {
              class:
                column.type === 'title'
                  ? 'nt-title'
                  : isNumeric(column)
                    ? 'num'
                    : column.type === 'checkbox'
                      ? 'nt-bool'
                      : undefined,
            },
            renderValue(ctx, row, column),
          ),
        ),
      ),
    ),
  );

  return h(
    doc,
    'div',
    { class: 'nt-tablewrap', 'data-scroll-key': 'table' },
    h(
      doc,
      'table',
      { class: 'nt-table', 'aria-label': ui.scope === ALL ? 'All rows' : `${ui.scope} rows` },
      h(doc, 'thead', {}, head),
      body,
    ),
    !rows.length &&
      h(doc, 'p', { class: 'nt-empty-row' }, ui.query ? 'No row matches this search.' : 'No rows.'),
    moreButton(ctx),
  );
}

function moreButton(ctx: ViewContext): Child {
  const left = ctx.visible.length - ctx.ui.limit;
  if (left <= 0) return null;

  return h(
    ctx.doc,
    'div',
    { class: 'nt-more' },
    button(ctx.doc, {
      kind: 'secondary',
      size: 'sm',
      key: 'more',
      label: `Show ${Math.min(PAGE_SIZE, left)} more`,
      onClick: () => ctx.update({ limit: ctx.ui.limit + PAGE_SIZE }),
    }),
  );
}

// ---------------------------------------------------------------- board

export function renderBoard(ctx: ViewContext): HTMLElement {
  const { doc } = ctx;
  const group = boardGroupColumn(ctx)!;
  const others = ctx.columns.filter(
    c => c.key !== group.key && OPTION_TYPES.has(c.type),
  ).slice(0, 2);
  const number = ctx.columns.find(c => c.type === 'number');

  return h(
    doc,
    'div',
    { class: 'nt-board', 'data-scroll-key': 'board', role: 'list', 'aria-label': `Grouped by ${group.name}` },
    groupRows(ctx.visible, group).map(g =>
      h(
        doc,
        'section',
        { class: 'nt-col', role: 'listitem', 'aria-label': `${g.option?.name ?? (g.key ? 'Unknown option' : 'No value')}, ${plural(g.rows.length, 'row')}` },
        h(
          doc,
          'h3',
          {},
          g.key
            ? optionPill(doc, g.option, g.key, group.type === 'status')
            : h(doc, 'span', { class: 'nt-tag c-default' }, 'No value'),
          h(doc, 'span', { class: 'pl-count' }, g.rows.length),
        ),
        h(
          doc,
          'ul',
          {},
          g.rows.slice(0, ctx.ui.limit).map(row =>
            h(
              doc,
              'li',
              {},
              h(
                doc,
                'button',
                {
                  type: 'button',
                  class: 'nt-card',
                  'data-key': `row:${row.subject}`,
                  'aria-current': ctx.ui.selected === row.subject ? 'true' : undefined,
                  onclick: () => ctx.open(row.subject),
                },
                h(doc, 'span', { class: 'nt-card-t' }, row.name),
                h(
                  doc,
                  'span',
                  { class: 'nt-card-m' },
                  others.map(c => renderValue(ctx, row, c)),
                  number &&
                    typeof cellValue(row, number) === 'number' &&
                    h(doc, 'span', { class: 'nt-pts' }, renderValue(ctx, row, number), ` ${number.name.toLocaleLowerCase()}`),
                ),
              ),
            ),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- list

export function renderList(ctx: ViewContext): HTMLElement {
  const { doc } = ctx;
  const pills = [
    ...ctx.columns.filter(c => c.type === 'status').slice(0, 1),
    ...ctx.columns.filter(c => c.type === 'select').slice(0, 1),
  ];
  const edited = ctx.columns.find(c => c.type === 'edited')!;

  return h(
    doc,
    'div',
    { class: 'nt-content' },
    h(
      doc,
      'ul',
      { class: 'nt-list', 'data-scroll-key': 'list', 'aria-label': 'Rows' },
      ctx.visible.slice(0, ctx.ui.limit).map(row =>
        h(
          doc,
          'li',
          {},
          h(
            doc,
            'button',
            {
              type: 'button',
              class: 'nt-li',
              'data-key': `row:${row.subject}`,
              'aria-current': ctx.ui.selected === row.subject ? 'true' : undefined,
              onclick: () => ctx.open(row.subject),
              onkeydown: rowKeys(ctx, row),
            },
            h(doc, 'span', { class: 'nt-li-t' }, row.name),
            (pills.length || ctx.ui.scope === ALL) &&
              h(
                doc,
                'span',
                { class: 'nt-li-m' },
                ctx.ui.scope === ALL && h(doc, 'span', { class: 'nt-dbname' }, icon(doc, 'db'), row.dataSource),
                pills.map(c => renderValue(ctx, row, c)),
              ),
            row.lastEdited !== undefined &&
              h(doc, 'span', { class: 'nt-li-s' }, 'Edited ', renderValue(ctx, row, edited)),
          ),
        ),
      ),
      !ctx.visible.length &&
        h(doc, 'li', { class: 'nt-empty-row' }, ctx.ui.query ? 'No row matches this search.' : 'No rows.'),
    ),
    moreButton(ctx),
  );
}

// ---------------------------------------------------------------- peek

export function renderPeek(ctx: ViewContext, row: Row, sheet: boolean): HTMLElement {
  const { doc } = ctx;
  const source = ctx.sources.find(s => s.title === row.dataSource);
  const columns = columnsFor(row.dataSource, ctx.sources, ctx.fallback).filter(
    c => c.type !== 'title',
  );
  const at = ctx.visible.findIndex(r => r.subject === row.subject);
  const skipped = (source?.report?.properties ?? []).filter(p => !p.shortname);
  const formatted = (source?.report?.formatted ?? []).filter(f => f.page === row.pageId);
  const move = (delta: number) => {
    const next = ctx.visible[at + delta];
    if (next) ctx.open(next.subject);
  };

  const iconButton = (label: string, glyph: string, onClick: () => void, disabled = false) =>
    h(
      doc,
      'button',
      { type: 'button', class: 'pl-icon-btn', 'aria-label': label, disabled, 'data-key': `peek:${glyph}`, onclick: onClick },
      icon(doc, glyph),
    );

  return h(
    doc,
    sheet ? 'div' : 'aside',
    {
      class: `nt-peek${sheet ? ' is-sheet' : ctx.size === 'wide' ? '' : ' is-overlay'}`,
      'aria-label': sheet ? undefined : 'Row details',
      'data-scroll-key': 'peek',
      onkeydown: (event: Event) => {
        const key = (event as KeyboardEvent).key;
        if (key === 'Escape') ctx.open(undefined);
        else if ((key === 'ArrowDown' || key === 'ArrowUp') && !(event.target instanceof HTMLSelectElement)) {
          event.preventDefault();
          move(key === 'ArrowDown' ? 1 : -1);
        }
      },
    },
    h(
      doc,
      'div',
      { class: 'nt-peek-bar' },
      iconButton('Close', 'close', () => ctx.open(undefined)),
      iconButton('Previous row', 'up', () => move(-1), at <= 0),
      iconButton('Next row', 'down', () => move(1), at < 0 || at >= ctx.visible.length - 1),
      h(doc, 'span', { class: 'pl-spacer' }),
      row.url &&
        button(doc, {
          kind: 'secondary',
          size: 'sm',
          label: 'Open in Notion',
          key: 'peek:open',
          onClick: () => ctx.openLink(row.url!, row),
        }),
    ),
    ctx.ui.linkFallback?.subject === row.subject &&
      renderCopy(
        doc,
        ctx.ui.linkFallback.href.replace(/^(mailto|tel):/, ''),
        'This frame cannot open new tabs. Copy the link instead.',
      ),
    h(doc, 'p', { class: 'nt-peek-db' }, icon(doc, 'db'), row.dataSource),
    h(doc, 'h3', { id: 'nt-peek-title' }, row.name),
    h(
      doc,
      'dl',
      { class: 'nt-props' },
      columns.flatMap(column => [
        h(doc, 'dt', {}, icon(doc, glyphFor(column.type)), fixedName(column)),
        h(
          doc,
          'dd',
          {},
          renderValue(ctx, row, column, { inPeek: true }) ??
            h(doc, 'span', { class: 'nt-muted' }, 'Empty'),
        ),
      ]),
    ),
    (skipped.length > 0 || formatted.length > 0) &&
      h(
        doc,
        'section',
        { class: 'nt-skipped', 'aria-label': 'Not copied from this page' },
        h(doc, 'p', { class: 'nt-skipped-h' }, icon(doc, 'info'), 'Not copied from this page'),
        h(
          doc,
          'ul',
          {},
          skipped.map(p =>
            h(doc, 'li', {}, icon(doc, glyphFor(p.type)), p.name, h(doc, 'span', {}, typeName(p.type))),
          ),
          formatted.map(f =>
            h(doc, 'li', {}, icon(doc, 'text'), f.property, h(doc, 'span', {}, 'has formatting')),
          ),
        ),
        h(
          doc,
          'p',
          { class: 'nt-fine' },
          'These stay in Notion: this app copies only plain text, numbers, checkboxes, options, links, emails and phone numbers.',
        ),
      ),
    h(
      doc,
      'p',
      { class: 'nt-readonly' },
      icon(doc, 'lock'),
      'Read-only copy. Edit this page in Notion; the change arrives here on the next sync.',
    ),
  );
}

// ---------------------------------------------------------------- details

export function renderDetails(ctx: ViewContext): HTMLElement | null {
  const { doc } = ctx;
  const last = ctx.state.last;
  if (!last) return null;
  const raw: string[] = [...last.general];

  const items = last.dataSources.map(d => {
    const skipped = d.properties.filter(p => !p.shortname);
    const byProperty = new Map<string, number>();
    for (const f of d.formatted) byProperty.set(f.property, (byProperty.get(f.property) ?? 0) + 1);
    for (const f of d.formatted) raw.push(`${d.title}: page ${f.page} (${f.title}) property "${f.property}" has formatting`);
    for (const a of d.archived) raw.push(`${d.title}: page ${a} is archived or in trash`);
    raw.push(...d.errors.map(e => `${d.title}: ${e}`));
    const counts: Child[] = [h(doc, 'b', {}, d.pages), ` ${d.pages === 1 ? 'row' : 'rows'}`];
    if (d.created) counts.push(` · ${d.created} new`);
    if (d.updated) counts.push(` · ${d.updated} updated`);
    if (d.unchanged) counts.push(` · ${d.unchanged} unchanged`);

    return h(
      doc,
      'li',
      {},
      h(doc, 'p', { class: 'nt-d-name' }, icon(doc, 'db'), d.title),
      h(doc, 'p', { class: 'nt-d-counts' }, counts),
      skipped.length > 0 &&
        h(
          doc,
          'p',
          { class: 'nt-d-skip' },
          'Not copied: ',
          skipped.flatMap((p, i) => [i ? ', ' : '', h(doc, 'span', {}, p.name), ` ${typeName(p.type)}`]),
        ),
      [...byProperty].map(([property, n]) =>
        warning(doc, [
          `${plural(n, 'page')} ${n === 1 ? 'has' : 'have'} formatting in `,
          h(doc, 'b', {}, property),
          `, so ${property} was not copied for ${n === 1 ? 'it' : 'them'}.`,
        ]),
      ),
      d.archived.length > 0 &&
        warning(doc, `${plural(d.archived.length, 'page')} ${d.archived.length === 1 ? 'was' : 'were'} archived in Notion. ${d.archived.length === 1 ? 'Its row is' : 'Their rows are'} kept here.`),
      d.errors.map(e => warning(doc, e)),
    );
  });

  return h(
    doc,
    'div',
    {
      class: 'nt-details',
      role: 'dialog',
      'aria-label': 'Sync details',
      'data-key': 'details',
      tabindex: -1,
      onkeydown: (event: Event) => {
        if ((event as KeyboardEvent).key === 'Escape') ctx.update({ details: false });
      },
    },
    h(
      doc,
      'div',
      { class: 'nt-details-h' },
      h(doc, 'b', {}, 'Last sync'),
      h(doc, 'span', {}, `${when(last.at, ctx.now, ctx.locale)} · took ${Math.max(1, Math.round(last.durationMs / 1000))} s`),
    ),
    items.length
      ? h(doc, 'ul', { class: 'nt-details-dbs' }, items)
      : h(doc, 'p', { class: 'nt-muted' }, 'Notion shared no databases in the last sync.'),
    last.general.length > 0 &&
      h(doc, 'div', { class: 'nt-details-general' }, last.general.map(g => warning(doc, g))),
    raw.length > 0 &&
      h(
        doc,
        'details',
        { class: 'nt-tech' },
        h(doc, 'summary', {}, 'Technical details'),
        h(doc, 'pre', {}, raw.join('\n')),
      ),
  );
}

const warning = (doc: Document, text: Child | Child[]) =>
  h(doc, 'p', { class: 'nt-d-warn' }, icon(doc, 'alert', 'sm'), h(doc, 'span', {}, ...[text].flat()));

// ---------------------------------------------------------------- first import

export function renderImport(ctx: ViewContext, progress: SyncProgress[]): HTMLElement {
  const { doc } = ctx;
  const active = progress.findIndex(p => p.phase !== 'done');

  return h(
    doc,
    'div',
    { class: 'nt-content' },
    h(
      doc,
      'div',
      { class: 'nt-import' },
      h(doc, 'h2', {}, 'Importing your first rows'),
      h(
        doc,
        'p',
        {},
        'This runs once in full; later syncs only update what changed. You can leave this page: the import stops, and starts again next time.',
      ),
      progress.length
        ? h(
            doc,
            'ul',
            { class: 'nt-progress', 'aria-label': 'Databases' },
            progress.map((p, i) => {
              const done = p.phase === 'done';
              const current = i === active;

              return h(
                doc,
                'li',
                { class: done ? 'is-done' : current ? 'is-active' : undefined },
                icon(doc, 'db'),
                h(doc, 'span', { class: 'nt-p-name' }, p.title),
                h(
                  doc,
                  'span',
                  { class: 'nt-p-state' },
                  done
                    ? [icon(doc, 'check', 'ok'), plural(p.pages, 'page')]
                    : current && p.phase !== 'listing'
                      ? [h(doc, 'span', { class: 'pl-spin' }, icon(doc, 'sync', 'sm')), `${p.phase === 'writing' ? 'Saving…' : 'Reading…'} ${plural(p.pages, 'page')}`]
                      : 'Waiting',
                ),
                current &&
                  h(doc, 'span', { class: 'nt-bar is-indeterminate', 'aria-hidden': 'true' }, h(doc, 'span')),
              );
            }),
          )
        : h(doc, 'p', { class: 'nt-muted' }, 'Asking Notion which databases it shares…'),
    ),
    h(
      doc,
      'div',
      { class: 'nt-tablewrap nt-skel', 'aria-hidden': 'true' },
      [0, 1, 2, 3, 4].map(i =>
        h(
          doc,
          'div',
          { class: 'nt-skel-row' },
          [38 - i * 3, 16 + (i % 2) * 4, 22 + i * 2].map(w =>
            h(doc, 'span', { style: `width:${w}%` }),
          ),
        ),
      ),
    ),
  );
}

// ---------------------------------------------------------------- states

export function stateBanner(ctx: ViewContext): HTMLElement | null {
  const { doc, state } = ctx;
  const rows = state.rows.length;
  const kept = rows ? `Your ${plural(rows, 'row')} ${rows === 1 ? 'is' : 'are'} kept` : 'Nothing was imported yet';
  const lastGood = state.last ? ` Your rows are from the last good sync (${when(state.last.at, ctx.now, ctx.locale).replace(/^Today/, 'today').replace(/^Yesterday/, 'yesterday')}).` : '';

  switch (state.kind) {
    case 'reauth':
      return renderBanner(doc, {
        tone: 'neg',
        title: 'Notion no longer gives Atomic access',
        text: `Someone removed the connection in Notion, or it expired. ${kept}${rows ? '; they just won’t update.' : '.'}`,
        action: { kind: 'danger', label: 'Reconnect Notion', key: 'reconnect', onClick: ctx.connect },
        ...(state.technical ? { technical: state.technical } : {}),
        alert: ctx.alert,
      });
    case 'rate-limited':
      return renderBanner(doc, {
        tone: 'warn',
        title: 'Notion asked Atomic to slow down',
        text: `The sync paused ${state.pagesRead ? `after ${plural(state.pagesRead, 'page')}` : 'before reading any pages'} and tries again at ${clock(state.retryAt, ctx.locale)}. Rows already here stay as they are.`,
        action: { kind: 'secondary', label: 'Try now', key: 'try-now', onClick: ctx.sync },
        technical: state.technical,
        alert: ctx.alert,
      });
    case 'failed':
      return renderBanner(doc, {
        tone: 'neg',
        title: state.title,
        text: `${state.message}${lastGood}`,
        action: { kind: 'danger', label: 'Try again', key: 'try-again', onClick: ctx.sync },
        technical: state.technical,
        alert: ctx.alert,
      });
    case 'no-databases':
      return rows
        ? renderBanner(doc, {
            tone: 'warn',
            title: 'Notion no longer shares any databases with Atomic',
            text: `${kept}. Share a database with the integration in Notion, then sync again.`,
            action: { kind: 'secondary', label: 'Choose pages in Notion', key: 'choose', onClick: ctx.connect },
            alert: ctx.alert,
          })
        : null;
    default:
      return null;
  }
}

export function noDatabases(ctx: ViewContext): HTMLElement {
  const { doc } = ctx;

  return renderEmpty(doc, {
    glyph: emptyGlyph(doc, 'db'),
    title: 'Notion didn’t share any databases with Atomic',
    text: 'The connection works, but Atomic can only see what you share with it in Notion. Pages that aren’t in a database are not imported.',
    action: { label: 'Choose pages in Notion', key: 'choose', onClick: ctx.connect },
    steps: [
      'Open the database in Notion.',
      ['Choose ', h(doc, 'b', {}, '•••'), ' in its top-right corner, then ', h(doc, 'b', {}, 'Connections'), '.'],
      ['Pick the Atomic integration. Come back and choose ', h(doc, 'b', {}, 'Sync now'), '.'],
    ],
  });
}

export function noRows(ctx: ViewContext): HTMLElement {
  const { doc } = ctx;

  return renderEmpty(doc, {
    glyph: emptyGlyph(doc, 'db'),
    title: 'The shared databases have no pages yet',
    text: 'Add a page to one of them in Notion, then sync again.',
    action: { label: 'Sync now', icon: 'sync', key: 'empty-sync', onClick: ctx.sync, disabled: ctx.state.kind !== 'ready' },
  });
}

/** Empty states before a connection: S1, S2, S3 and loading. */
export function preConnection(
  doc: Document,
  state: Exclude<ViewState, ConnectedState>,
  connect: () => void,
): HTMLElement {
  const mark = h(doc, 'span', { class: 'pl-mark is-lg', 'aria-hidden': 'true' }, 'N');

  switch (state.kind) {
    case 'loading':
      return h(doc, 'div', { class: 'pl-empty' }, h(doc, 'p', { class: 'nt-muted' }, 'Loading…'));
    case 'no-proxy':
      return renderEmpty(doc, {
        glyph: emptyGlyph(doc, 'plug'),
        title: 'This Atomic Server can’t connect apps to other services yet',
        text: 'The Notion app needs the server’s integration relay to read from Notion. Nothing was fetched and nothing was stored.',
        secondary: 'Ask the person who runs this server to update it (the relay arrived in atomic-server PR #1657).',
      });
    case 'not-connected':
      return renderEmpty(doc, {
        glyph: mark,
        title: 'Bring your Notion databases into Atomic',
        text: 'Atomic keeps a copy of the pages in the Notion databases you choose, as rows in this app’s table.',
        facts: [
          { icon: 'check', text: 'Every property of type text, number, checkbox, select, status, URL, email and phone is copied' },
          { icon: 'lock', text: 'Read-only: nothing is ever written back to Notion' },
          { icon: 'db', text: 'Notion asks you which pages and databases to share; only those are read' },
        ],
        action: { label: 'Connect Notion', key: 'connect', onClick: connect },
        secondary: 'Your Notion sign-in stays with the integration relay. This app only ever sees the pages.',
      });
    case 'connecting':
      return renderEmpty(doc, {
        glyph: mark,
        title: 'Confirm in the bar above',
        text: 'Atomic asks first. Then Notion shows its own page, where you pick the pages and databases to share. You come back here afterwards.',
        action: { label: 'Waiting for confirmation…', key: 'connect', busy: true, onClick: () => {} },
        secondary: ['Changed your mind? Choose ', h(doc, 'b', {}, 'Cancel'), ' in the bar above.'],
      });
  }
}
