// @wc-ignore-file
/**
 * The Notion app's view: owns the UI state (scope, view, search, sort,
 * selection), renders a controller `ViewState` into the frame, and keeps
 * focus, scroll and the one live region stable across re-renders.
 *
 * View choices live in memory only. The frame is null-origin, where
 * `localStorage` throws, and the bundle deliberately has no storage access
 * (`build.test.ts`), so DESIGN.md's "remember per app" is not done.
 */
import { isConnected, isRunning, type ViewState } from '../controller.js';
import type { Row } from '../rows.js';
import { byKey, h, icon } from '../ui/dom.js';
import { plural } from '../ui/format.js';
import { sprite } from '../ui/icons.js';
import {
  openExternal,
  pillElement,
  renderConnbar,
  renderHeader,
  renderBanner,
  renderMenu,
  updatePill,
  type ChipModel,
} from '../ui/shell.js';
import { PL_CSS } from '../ui/styles.js';
import {
  ALL,
  columnsFor,
  DEFAULT_SORT,
  defaultView,
  groupable,
  pill,
  searchRows,
  sortRows,
  sources as listSources,
  syncAction,
} from './model.js';
import {
  noDatabases,
  noRows,
  PAGE_SIZE,
  preConnection,
  renderBoard,
  renderDetails,
  renderImport,
  renderList,
  renderPeek,
  renderTable,
  renderToolbar,
  stateBanner,
  type UiState,
  type ViewContext,
} from './parts.js';
import { NT_CSS } from './styles.js';

export const NARROW = 640;
export const WIDE = 960;
const SEARCH_DEBOUNCE_MS = 150;
const FLASH_MS = 2500;

export interface AppActions {
  sync(): void;
  connect(): void;
  /**
   * Opens an http(s) link through the host (`store.openExternal`), which
   * asks the person first. Resolves `false` when the host cannot, so the
   * app shows the URL to copy instead. Absent: always the copy fallback.
   */
  openExternal?(url: string): Promise<boolean>;
  /** Shows the app's data table in the host (`store.openResource`). */
  openTable?(): void;
  /** Stops this app using Notion (`store.proxy.disconnect`). */
  disconnect?(): void;
}

export interface AppOptions {
  now?: () => number;
  locale?: string;
  /** Width override for tests (jsdom has no layout). */
  width?: () => number;
}

export interface App {
  render(state?: ViewState): void;
  /** The host's light or dark setting (`store.getTheme`, `onThemeChange`). */
  setColorScheme(scheme: 'light' | 'dark'): void;
  /** Shows a load failure in place of the view. */
  fatal(message: string): void;
  ui(): Readonly<UiState>;
  destroy(): void;
}

const sizeOf = (width: number): ViewContext['size'] =>
  width < NARROW ? 'narrow' : width < WIDE ? 'medium' : 'wide';

export function createApp(
  root: HTMLElement,
  actions: AppActions,
  { now = Date.now, locale, width }: AppOptions = {},
): App {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const style = h(doc, 'style', { 'data-notion-app': '' }, PL_CSS + NT_CSS);
  (doc.head ?? root).appendChild(style);
  if (doc.body) doc.body.style.margin = '0';
  const app = h(doc, 'div', { class: 'pl-app' });
  root.replaceChildren(sprite(doc), app);

  const pillEl = pillElement(doc);
  const ui: UiState = {
    scope: ALL,
    query: '',
    sort: DEFAULT_SORT,
    limit: PAGE_SIZE,
    details: false,
    menu: false,
  };
  let state: ViewState = { kind: 'loading' };
  const measure = () =>
    width?.() ?? (app.clientWidth || win.innerWidth || WIDE);
  let size = sizeOf(measure());
  let flash = new Set<string>();
  let flashed: unknown;
  let alertFor: ViewState | undefined;
  let focusAfter: string | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let flashTimer: ReturnType<typeof setTimeout> | undefined;
  let searchTimer: ReturnType<typeof setTimeout> | undefined;

  const searchInput = h(doc, 'input', {
    type: 'search',
    placeholder: 'Search rows…',
    autocomplete: 'off',
    'data-key': 'search',
  });
  searchInput.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(
      () => update({ query: searchInput.value, limit: PAGE_SIZE }),
      SEARCH_DEBOUNCE_MS,
    );
  });

  const update = (patch: Partial<UiState>) => {
    Object.assign(ui, patch);
    render();
  };

  const open = (subject: string | undefined) => {
    const previous = ui.selected;
    if (subject === undefined && previous) focusAfter = `row:${previous}`;
    else if (subject && size !== 'narrow') focusAfter = `row:${subject}`;
    update({ selected: subject, linkFallback: undefined });
  };

  const openLink = (href: string, row: Row) => {
    const fallback = () =>
      update({
        selected: row.subject,
        linkFallback: { subject: row.subject, href },
      });

    if (!actions.openExternal) {
      if (!openExternal(win, href)) fallback();

      return;
    }

    actions.openExternal(href).then(handled => {
      if (!handled) fallback();
    }, fallback);
  };

  // On click, not pointerdown: a re-render between pointerdown and click
  // would replace the button under the pointer and lose the click.
  const onClick = (event: Event) => {
    const target = event.target as Element | null;
    const patch: Partial<UiState> = {};
    if (ui.menu && !target?.closest?.('.pl-menu-wrap')) patch.menu = false;
    if (
      ui.details &&
      !target?.closest?.(
        '.nt-details, [data-key="details-toggle"], .pl-menu-wrap',
      )
    )
      patch.details = false;
    if (Object.keys(patch).length) update(patch);
  };

  const onKey = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !(ui.menu || ui.details)) return;
    if (ui.details) focusAfter = 'details-toggle';
    else focusAfter = 'menu:More';
    update({ menu: false, details: false });
  };

  doc.addEventListener('click', onClick);
  doc.addEventListener('keydown', onKey);

  const observer =
    typeof win.ResizeObserver === 'function'
      ? new win.ResizeObserver(() => {
          const next = sizeOf(measure());

          if (next !== size) {
            size = next;
            render();
          }
        })
      : undefined;
  observer?.observe(app);
  const tick = setInterval(() => {
    if (state.kind === 'ready') render();
  }, 60_000);

  function scheduleRetry() {
    clearTimeout(retry);
    retry = undefined;
    if (state.kind !== 'rate-limited') return;
    retry = setTimeout(
      () => actions.sync(),
      Math.max(0, state.retryAt - now()),
    );
  }

  function header(): HTMLElement {
    if (!isConnected(state))
      return renderHeader(doc, { mark: 'N', name: 'Notion', pill: pillEl });
    const list = listSources(state.rows, state.last);
    const chips: ChipModel[] = list.length
      ? [
          {
            key: ALL,
            label: 'All',
            count: state.rows.length,
            pressed: ui.scope === ALL,
            onClick: () => update({ scope: ALL, selected: undefined }),
          },
          ...list.map(s => ({
            key: s.title,
            label: s.title,
            count: s.count,
            icon: 'db',
            pressed: ui.scope === s.title,
            onClick: () =>
              update({
                scope: s.title,
                selected: undefined,
                groupBy: undefined,
              }),
          })),
        ]
      : [];
    const sync = syncAction(state);

    return renderHeader(doc, {
      mark: 'N',
      name: 'Notion',
      chips,
      ...(list.length
        ? {
            select: {
              label: 'Database',
              value: ui.scope,
              options: [
                { value: ALL, label: `All databases (${state.rows.length})` },
                ...list.map(s => ({
                  value: s.title,
                  label: `${s.title} (${s.count})`,
                })),
              ],
              onChange: value =>
                update({
                  scope: value,
                  selected: undefined,
                  groupBy: undefined,
                }),
            },
          }
        : {}),
      pill: pillEl,
      ...(sync.shown
        ? {
            action: {
              label: 'Sync now',
              icon: 'sync',
              key: 'sync-now',
              disabled: !sync.enabled,
              onClick: actions.sync,
            },
          }
        : {}),
    });
  }

  function connbar(): HTMLElement | null {
    if (!isConnected(state)) return null;
    const databases =
      state.kind === 'importing' && state.progress.length
        ? state.progress.length
        : (state.last?.dataSources.length ?? listSources(state.rows).length);

    return renderConnbar(
      doc,
      [
        [
          h(doc, 'span', {
            class: 'pl-dot',
            'aria-hidden': 'true',
            style:
              state.kind === 'reauth'
                ? 'background:var(--pl-neg)'
                : state.kind === 'disconnected'
                  ? 'background:var(--pl-muted)'
                  : undefined,
          }),
          'Notion',
        ],
        plural(databases, 'database'),
        state.kind === 'reauth'
          ? 'Access revoked'
          : state.kind === 'disconnected'
            ? 'Not connected'
            : [icon(doc, 'lock', 'sm'), 'Read-only'],
      ],
      [
        h(
          doc,
          'button',
          {
            type: 'button',
            class: 'pl-cb-btn pl-cb-hide-narrow',
            'aria-expanded': ui.details ? 'true' : 'false',
            disabled: !state.last,
            title: state.last ? undefined : 'Available after the first sync',
            'data-key': 'details-toggle',
            onclick: () => update({ details: !ui.details, menu: false }),
          },
          'Sync details',
          icon(doc, 'chev'),
        ),
        renderMenu(
          doc,
          'More',
          [
            {
              label: 'Sync details',
              icon: 'info',
              disabled: !state.last,
              onClick: () => update({ details: true }),
            },
            ...(state.connectionId
              ? [
                  {
                    label: 'Choose pages in Notion',
                    icon: 'ext',
                    onClick: actions.connect,
                  },
                ]
              : []),
            ...(actions.openTable
              ? [
                  {
                    label: 'Open data table',
                    icon: 'table',
                    onClick: actions.openTable,
                  },
                ]
              : []),
            ...(actions.disconnect && state.connectionId
              ? [
                  {
                    label: 'Disconnect Notion…',
                    icon: 'plug',
                    disabled: isRunning(state),
                    onClick: () => {
                      focusAfter = 'disconnect-cancel';
                      update({ confirmDisconnect: true });
                    },
                  },
                ]
              : []),
          ],
          ui.menu,
          menuOpen => update({ menu: menuOpen, details: false }),
        ),
      ],
    );
  }

  function content(ctx: ViewContext): (Node | null)[] {
    const s = ctx.state;
    if (
      s.kind === 'importing' ||
      (s.kind === 'ready' && !s.last && !s.rows.length)
    )
      return [renderImport(ctx, s.kind === 'importing' ? s.progress : [])];
    if (s.kind === 'no-databases' && !s.rows.length) return [noDatabases(ctx)];
    if (!s.rows.length) return s.kind === 'ready' ? [noRows(ctx)] : [];

    const selected = ui.selected
      ? ctx.visible.find(r => r.subject === ui.selected)
      : undefined;
    const body =
      ctx.view === 'board'
        ? renderBoard(ctx)
        : ctx.view === 'list'
          ? renderList(ctx)
          : renderTable(ctx);
    if (!selected) return [renderToolbar(ctx), body];

    if (size === 'narrow') {
      const dialog = h(
        doc,
        'dialog',
        { class: 'nt-sheet', 'aria-labelledby': 'nt-peek-title' },
        renderPeek(ctx, selected, true),
      );
      dialog.addEventListener('cancel', event => {
        event.preventDefault();
        open(undefined);
      });

      return [renderToolbar(ctx), body, dialog];
    }

    const peek = renderPeek(ctx, selected, false);

    return [
      renderToolbar(ctx),
      size === 'wide' && ctx.view === 'table'
        ? h(doc, 'div', { class: 'nt-split' }, body, peek)
        : h(doc, 'div', { class: 'nt-content' }, body, peek),
    ];
  }

  function render(next?: ViewState) {
    if (next && next !== state) {
      if (isRunning(state) && !isRunning(next) && next.kind !== 'ready')
        alertFor = next;
      state = next;

      if (isConnected(state) && state.changed && state.changed !== flashed) {
        flashed = state.changed;
        flash = new Set(state.changed);
        clearTimeout(flashTimer);
        flashTimer = setTimeout(() => {
          flash = new Set();
          render();
        }, FLASH_MS);
      }

      scheduleRetry();
    }

    const active = doc.activeElement as HTMLElement | null;
    const focusKey =
      focusAfter ??
      active?.closest?.('[data-key]')?.getAttribute('data-key') ??
      undefined;
    focusAfter = undefined;
    const scrolls = new Map(
      [...app.querySelectorAll<HTMLElement>('[data-scroll-key]')].map(el => [
        el.getAttribute('data-scroll-key'),
        [el.scrollTop, el.scrollLeft] as const,
      ]),
    );

    updatePill(doc, pillEl, pill(state, now(), locale));
    app.classList.toggle('is-narrow', size === 'narrow');
    const children: (Node | null)[] = [header()];

    if (!isConnected(state)) {
      children.push(preConnection(doc, state, actions.connect));
    } else {
      const list = listSources(state.rows, state.last);
      if (ui.scope !== ALL && !list.some(s => s.title === ui.scope))
        ui.scope = ALL;
      const columns = columnsFor(ui.scope, list);
      const scoped =
        ui.scope === ALL
          ? state.rows
          : state.rows.filter(r => r.dataSource === ui.scope);
      const visible = sortRows(
        searchRows(scoped, columns, ui.query),
        columns,
        ui.sort,
      );
      let view = ui.view ?? defaultView(size === 'narrow');
      if (view === 'board' && (ui.scope === ALL || !groupable(columns).length))
        view = defaultView(size === 'narrow');
      if (ui.selected && !visible.some(r => r.subject === ui.selected))
        ui.selected = undefined;
      const ctx: ViewContext = {
        doc,
        now: now(),
        ...(locale ? { locale } : {}),
        openLink,
        ui,
        state,
        sources: list,
        columns,
        visible,
        scoped,
        view,
        size,
        flash,
        alert: alertFor === state,
        searchInput,
        fallback: new Map(),
        update,
        open,
        sync: actions.sync,
        connect: actions.connect,
      };
      children.push(
        connbar(),
        h(
          doc,
          'div',
          { class: 'nt-main' },
          ui.confirmDisconnect && actions.disconnect
            ? renderBanner(doc, {
                tone: 'warn',
                title: 'Disconnect Notion from this app?',
                text: `Syncing stops. The ${plural(state.rows.length, 'row')} already here stay${state.rows.length === 1 ? 's' : ''}. The Notion connection itself stays for other apps; connect again to resume.`,
                action: {
                  kind: 'danger',
                  label: 'Disconnect',
                  key: 'disconnect-confirm',
                  onClick: () => {
                    ui.confirmDisconnect = false;
                    actions.disconnect!();
                  },
                },
                secondary: {
                  kind: 'secondary',
                  label: 'Cancel',
                  key: 'disconnect-cancel',
                  onClick: () => update({ confirmDisconnect: false }),
                },
              })
            : // One banner at a time: the confirmation stands in for the state's.
              stateBanner(ctx),
          ui.details ? renderDetails(ctx) : null,
          ...content(ctx),
        ),
      );
    }

    app.replaceChildren(...children.filter((c): c is Node => !!c));

    for (const el of app.querySelectorAll<HTMLElement>('[data-scroll-key]')) {
      const saved = scrolls.get(el.getAttribute('data-scroll-key'));
      if (saved) [el.scrollTop, el.scrollLeft] = saved;
    }

    const dialog = app.querySelector('dialog');

    if (dialog && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    }

    if (focusKey) {
      const el = app.querySelector<HTMLElement>(byKey(focusKey));
      if (el && el !== doc.activeElement) el.focus({ preventScroll: true });
    }
  }

  return {
    render,
    setColorScheme(scheme) {
      app.dataset.scheme = scheme;
    },
    fatal(message) {
      app.replaceChildren(
        renderHeader(doc, { mark: 'N', name: 'Notion' }),
        h(
          doc,
          'div',
          { class: 'pl-empty' },
          h(doc, 'h2', {}, 'The Notion app could not load'),
          h(doc, 'p', {}, message),
        ),
      );
    },
    ui: () => ui,
    destroy() {
      observer?.disconnect();
      clearInterval(tick);
      clearTimeout(retry);
      clearTimeout(flashTimer);
      clearTimeout(searchTimer);
      doc.removeEventListener('click', onClick);
      doc.removeEventListener('keydown', onKey);
      style.remove();
    },
  };
}
