// @wc-ignore-file
/**
 * The Calendar drive-plugin entry point. The host's generated shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module must
 * export `view` and must not render on import. One module, no stylesheet:
 * `view()` injects one `<style>`.
 *
 * Draws the #89 design (`../design/`): shared chrome from `ui/`, the
 * calendar's screens, Agenda and Week, the event drawer, and the Review and
 * Conflicts sheets. All state lives in `controller.ts`; this file keeps only
 * what is on screen (view, date, open drawer or sheet, focus).
 */
import type { Projection } from '../adapter.js';
import { agenda, dayStrip } from './agenda.js';
import { CALENDAR_CSS } from './calendarStyles.js';
import type { Ctx } from './context.js';
import {
  banner as bannerCopy,
  createController,
  pill as pillModel,
  reviewCount,
  syncedAgo,
  type Problem,
  type Snapshot,
  type ViewState,
} from './controller.js';
import { detail, editor } from './drawer.js';
import { busyDays, nextEvent, type CalEvent } from './events.js';
import { firstRun, importing, noRelay, picker } from './screens.js';
import { conflicts, review, shortcuts } from './sheets.js';
import { sidebar } from './sidebar.js';
import type { ViewArgs } from './store.js';
import type { Choice, Conflict, ImportSummary } from './sync.js';
import {
  addDays,
  longDay,
  mondayOf,
  monthTitle,
  rangeTitle,
  shortRange,
  viewerZone,
  wall,
} from './time.js';
import {
  banner,
  connectionBar,
  emptyState,
  header,
  pill,
  segmented,
} from './ui/chrome.js';
import { focusKey, h, ICONS, restoreFocus, svg } from './ui/dom.js';
import { PLUGIN_CSS } from './ui/styles.js';
import { installTheme } from './ui/theme.js';
import { dayCount, firstHour, ROW, week } from './week.js';

type Sheet = 'review' | 'conflicts' | 'shortcuts';

interface Ui {
  view: 'agenda' | 'week';
  /** The date the view is anchored on. */
  anchor: string;
  /** The month the sidebar shows. */
  month: string;
  drawer?: { subject: string; mode: 'view' | 'edit'; from?: string };
  sheet?: Sheet;
  sheetFrom?: string;
  menu: boolean;
  /** The one calendar's visibility toggle (chip, sidebar checkbox). */
  visible: boolean;
  why: boolean;
  /** Seconds left before a rate-limited sync retries. */
  countdown?: number;
  choices: Map<Conflict, Partial<Record<keyof Projection, Choice>>>;
  confirming?: Conflict;
  conflictErrors: Map<Conflict, string>;
  /** Scroll the week grid to this hour on the next render. */
  scrollTo?: number;
}

const TYPING = /^(input|textarea|select)$/i;

const EMPTY_SUMMARY: ImportSummary = {
  calendarId: '',
  total: 0,
  added: 0,
  updated: 0,
  unchanged: 0,
  skipped: { recurring: 0, cancelled: 0 },
  conflicts: [],
  localOnly: 0,
  invalid: [],
  review: [],
};

export async function view({ root, store }: ViewArgs): Promise<void> {
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  installTheme(root, `${PLUGIN_CSS}\n${CALENDAR_CSS}`);
  root.classList.add('pl-app');
  const zone = viewerZone();
  const today = () => wall(Date.now(), zone).date;
  const width = () => root.clientWidth || win.innerWidth || 1024;

  const ui: Ui = {
    view: width() < 720 ? 'agenda' : 'week',
    anchor: today(),
    month: today(),
    menu: false,
    visible: true,
    why: false,
    choices: new Map(),
    conflictErrors: new Map(),
    scrollTo: firstHour(wall(Date.now(), zone).minutes),
  };
  /** The editor keeps its own draft; it is not rebuilt while it is open. */
  let editing: { subject: string; element: HTMLElement } | undefined;
  let countdownTimer: ReturnType<typeof setInterval> | undefined;
  let lastProblem: Problem | undefined;

  let queued = false;

  const schedule = () => {
    if (queued) return;
    queued = true;
    queueMicrotask(() => {
      queued = false;
      render();
    });
  };

  const controller = createController(store, () => schedule());

  const set = (patch: Partial<Ui>) => {
    Object.assign(ui, patch);
    schedule();
  };

  const focusSoon = (selector: string) => {
    setTimeout(() => root.querySelector<HTMLElement>(selector)?.focus(), 0);
  };

  const ctx = (): Ctx => ({
    doc,
    zone,
    today: today(),
    now: Date.now(),
    width: width(),
    open: (event, from) => openEvent(event, from.dataset.key),
    goTo: date => set({ anchor: date, month: date }),
    setView: v =>
      set({
        view: v,
        ...(ui.view === v
          ? {}
          : { scrollTo: firstHour(wall(Date.now(), zone).minutes) }),
      }),
  });

  function openEvent(event: CalEvent, from?: string) {
    editing = undefined;
    set({
      drawer: {
        subject: event.subject,
        mode: 'view',
        ...(from ? { from } : {}),
      },
      menu: false,
    });
    focusSoon('#drawer-title');
  }

  function closeDrawer() {
    const from = ui.drawer?.from;
    editing = undefined;
    set({ drawer: undefined });
    if (from) focusSoon(`[data-key="${CSS.escape(from)}"]`);
  }

  function openSheet(sheet: Sheet) {
    const from = focusKey(doc);
    set({ sheet, menu: false, ...(from ? { sheetFrom: from } : {}) });
    focusSoon(`#${sheet}-title`);
  }

  function closeSheet() {
    const from = ui.sheetFrom;
    set({ sheet: undefined, confirming: undefined, sheetFrom: undefined });
    focusSoon(
      from ? `[data-key="${CSS.escape(from)}"]` : '[data-key="primary"]',
    );
  }

  async function openReview() {
    openSheet('review');
    await controller.prepareReview();
  }

  function step(direction: 1 | -1) {
    const days = ui.view === 'week' ? dayCount(width()) : 7;
    const anchor = addDays(ui.anchor, direction * days);
    set({ anchor, month: anchor });
  }

  function retryIn(seconds: number) {
    clearInterval(countdownTimer);
    ui.countdown = seconds;
    countdownTimer = setInterval(() => {
      if (!ui.countdown || ui.countdown <= 1) {
        clearInterval(countdownTimer);
        ui.countdown = undefined;
        void controller.refresh();

        return;
      }

      ui.countdown--;
      schedule();
    }, 1000);
  }

  // ---- rendering ---------------------------------------------------------

  function chips(snap: Snapshot): HTMLElement | undefined {
    if (!snap.meta) return undefined;

    return h(
      doc,
      'button',
      {
        class: 'chip',
        'aria-pressed': ui.visible ? 'true' : 'false',
        'aria-label': `Show ${snap.meta.summary}`,
        'data-key': 'chip',
        onclick: () => set({ visible: !ui.visible }),
      },
      h(doc, 'span', {
        class: 'sw',
        style: `--c:${snap.meta.color}`,
        'aria-hidden': 'true',
      }),
      snap.meta.summary,
    );
  }

  function headerRow(snap: Snapshot, narrow: boolean): HTMLElement {
    const p = pillModel(snap);
    const count = reviewCount(snap);
    const busy =
      snap.state.kind === 'refreshing' || snap.state.kind === 'sending';
    const opens = p.opens;
    const changes = `${count} ${count === 1 ? 'change' : 'changes'}`;
    const action =
      count > 0
        ? h(
            doc,
            'button',
            {
              class: 'btn btn-primary',
              'data-key': 'primary',
              'aria-label': `Review ${changes}`,
              onclick: () => void openReview(),
            },
            narrow ? `Review ${count}` : `Review ${changes}`,
          )
        : h(
            doc,
            'button',
            {
              class: 'btn',
              'data-key': 'primary',
              disabled: busy || !snap.meta,
              onclick: () => void controller.refresh(),
            },
            'Sync now',
          );

    return header(doc, {
      title: 'Calendar',
      chips: chips(snap),
      status: pill(doc, {
        ...p,
        ...(opens
          ? {
              onClick: () => {
                if (opens === 'review') void openReview();
                else if (opens === 'conflicts') openSheet('conflicts');
                else
                  root
                    .querySelector<HTMLDetailsElement>('.banner details')
                    ?.setAttribute('open', '');
              },
            }
          : {}),
      }),
      action,
    });
  }

  function cbar(snap: Snapshot): HTMLElement {
    const busy =
      snap.state.kind === 'refreshing' || snap.state.kind === 'sending';
    const detailText =
      snap.state.kind === 'refreshing'
        ? 'Reading events…'
        : snap.state.kind === 'sending'
          ? 'Sending changes…'
          : snap.at
            ? `Last synced ${syncedAgo(snap.at).replace(/^at /, '')}`
            : undefined;

    return connectionBar(doc, {
      provider: 'Google Calendar',
      ...(snap.meta?.account ? { account: snap.meta.account } : {}),
      ...(detailText ? { detail: detailText } : {}),
      busy,
      menuOpen: ui.menu,
      onMenu: open => set({ menu: open }),
      menu: [
        {
          label: 'Sync now',
          disabled: busy,
          onSelect: () => void controller.refresh(),
        },
        { label: 'Reconnect', onSelect: () => void controller.connect() },
        {
          label: 'Choose calendars',
          hint: 'One calendar per app: add another Calendar app for a second one.',
          disabled: true,
          onSelect: () => {},
        },
        {
          label: 'Keyboard shortcuts',
          onSelect: () => openSheet('shortcuts'),
        },
      ],
    });
  }

  function banners(snap: Snapshot): HTMLElement | undefined {
    const state = snap.state;

    if (state.kind !== 'error') {
      lastProblem = undefined;

      return undefined;
    }

    const problem = state.problem;

    if (problem !== lastProblem) {
      lastProblem = problem;
      if (problem.kind === 'rate-limited' && problem.retryAfter)
        retryIn(problem.retryAfter);
    }

    const copy = bannerCopy(
      problem,
      snap.meta?.summary ?? 'this calendar',
      ui.countdown,
    );
    const reconnect = copy.action?.does === 'reconnect' || state.reconnect;
    const action =
      copy.action ?? (reconnect ? { label: 'Reconnect' } : undefined);

    return h(
      doc,
      'div',
      { class: 'banners' },
      banner(doc, {
        tone: copy.tone,
        role: copy.role,
        title: copy.title,
        body: copy.body,
        details: `${problem.status ? `HTTP ${problem.status}: ` : ''}${problem.message}`,
        ...(action
          ? {
              action: {
                label: reconnect ? 'Reconnect' : action.label,
                ...(reconnect ? { name: 'Reconnect Google Calendar' } : {}),
                onClick: () => {
                  clearInterval(countdownTimer);
                  ui.countdown = undefined;
                  if (reconnect) void controller.connect();
                  else void controller.refresh();
                },
              },
            }
          : {}),
      }),
    );
  }

  function toolbar(narrow: boolean, from: string, days: number): HTMLElement {
    const nav = h(
      doc,
      'span',
      { class: 'tb-nav' },
      h(
        doc,
        'button',
        {
          class: 'icon-btn',
          'aria-label': ui.view === 'week' ? 'Previous days' : 'Previous week',
          'data-key': 'prev',
          onclick: () => step(-1),
        },
        svg(doc, ICONS.prev),
      ),
      h(
        doc,
        'button',
        {
          class: 'icon-btn',
          'aria-label': ui.view === 'week' ? 'Next days' : 'Next week',
          'data-key': 'next',
          onclick: () => step(1),
        },
        svg(doc, ICONS.next),
      ),
    );
    const title =
      ui.view === 'agenda'
        ? monthTitle(ui.anchor)
        : narrow
          ? shortRange(from, addDays(from, days - 1))
          : rangeTitle(from, addDays(from, days - 1));

    return h(
      doc,
      'div',
      { class: 'tb' },
      narrow
        ? null
        : h(
            doc,
            'button',
            {
              class: 'btn',
              'data-key': 'today',
              onclick: () => ctx().goTo(today()),
            },
            'Today',
          ),
      nav,
      h(doc, 'h2', { class: 'tb-title', 'aria-live': 'polite' }, title),
      segmented(
        doc,
        'View',
        [
          { value: 'agenda', label: 'Agenda' },
          { value: 'week', label: 'Week' },
        ],
        ui.view,
        v => ctx().setView(v),
      ),
    );
  }

  function content(snap: Snapshot, c: Ctx, narrow: boolean): HTMLElement {
    const events = ui.visible ? snap.events : [];
    const days = ui.view === 'week' ? dayCount(c.width) : 7;
    const from =
      ui.view === 'week' && days === 7 ? mondayOf(ui.anchor) : ui.anchor;
    const firstImport =
      snap.state.kind === 'refreshing' && !snap.summary && !snap.events.length;

    if (firstImport)
      return h(
        doc,
        'div',
        { class: 'main' },
        importing(doc, {
          calendar: snap.meta?.summary ?? 'Calendar',
          color: snap.meta?.color ?? '#4986e7',
          ...(snap.state.kind === 'refreshing' && snap.state.pages
            ? { pages: snap.state.pages }
            : {}),
        }),
      );

    const rangeDays = ui.view === 'week' ? days : 7;
    const rangeFrom = ui.view === 'week' ? from : mondayOf(ui.anchor);
    const empty = busyDays(events, rangeFrom, rangeDays, zone).size === 0;
    let body: HTMLElement;

    if (empty && snap.summary) {
      const next = nextEvent(events, addDays(rangeFrom, rangeDays), zone);
      body = emptyState(doc, {
        muted: true,
        title:
          ui.view === 'week' && days < 7
            ? 'No events these days'
            : 'No events this week',
        ...(next
          ? {
              text: `Your next event is ${next.event.title || '(untitled)'} on ${longDay(next.date)}.`,
            }
          : !ui.visible
            ? { text: `${snap.meta?.summary ?? 'The calendar'} is hidden.` }
            : {}),
        children: next
          ? [
              h(
                doc,
                'button',
                {
                  class: 'btn btn-primary',
                  'data-key': 'jump',
                  onclick: () => c.goTo(next.date),
                },
                'Jump to next event',
              ),
            ]
          : [],
      });
    } else if (ui.view === 'week')
      body = week(c, events, from, days, c.width - (c.width >= 900 ? 232 : 0));
    else body = agenda(c, events, ui.anchor);

    return h(
      doc,
      'div',
      { class: 'main' },
      toolbar(narrow, from, days),
      ui.view === 'agenda' ? dayStrip(c, events, ui.anchor) : null,
      ui.view === 'week' && !(empty && snap.summary)
        ? body
        : h(doc, 'div', { class: 'view', 'data-scroll': 'view' }, body),
    );
  }

  function drawer(
    snap: Snapshot,
    c: Ctx,
    narrow: boolean,
  ): HTMLElement | undefined {
    if (!ui.drawer) return undefined;
    const open = ui.drawer;
    const event = snap.events.find(e => e.subject === open.subject);

    if (!event) {
      ui.drawer = undefined;
      editing = undefined;

      return undefined;
    }

    if (open.mode === 'edit' && !event.readOnly) {
      if (editing?.subject !== event.subject)
        editing = {
          subject: event.subject,
          element: editor(c, event, {
            narrow,
            onClose: closeDrawer,
            onCancel: () => {
              editing = undefined;
              set({ drawer: { ...open, mode: 'view' } });
              focusSoon('#drawer-title');
            },
            onSave: async value => {
              await controller.saveEvent(event.subject, value);
              editing = undefined;
              set({ drawer: { ...open, mode: 'view' } });
              focusSoon('#drawer-title');
            },
          }),
        };

      return editing.element;
    }

    return detail(c, event, {
      narrow,
      onClose: closeDrawer,
      onEdit: () => {
        set({ drawer: { ...open, mode: 'edit' } });
        focusSoon('[data-key="f-title"]');
      },
      onReview: () => void openReview(),
      onConflicts: () => openSheet('conflicts'),
    });
  }

  function sheetFor(snap: Snapshot, c: Ctx): HTMLElement | undefined {
    if (ui.sheet === 'shortcuts') return shortcuts(c, closeSheet);
    const color = snap.meta?.color ?? '#4986e7';

    if (ui.sheet === 'review') {
      const state = snap.state;
      const summary =
        state.kind === 'sending' || state.kind === 'ready'
          ? state.summary
          : (snap.summary ?? EMPTY_SUMMARY);

      return review(c, {
        summary,
        ...(state.kind === 'sending' ? { progress: state.progress } : {}),
        outcomes:
          state.kind === 'ready' || state.kind === 'error'
            ? (state.outcomes ?? [])
            : [],
        color,
        busy: state.kind === 'refreshing' || snap.stale,
        onClose: closeSheet,
        onDiscard: pending => void controller.discard(pending),
        onSend: () => void controller.send(),
        onReviewAgain: () => void controller.refresh(),
      });
    }

    if (ui.sheet === 'conflicts')
      return conflicts(c, {
        list: snap.summary?.conflicts ?? [],
        color,
        choices: ui.choices,
        ...(ui.confirming ? { confirming: ui.confirming } : {}),
        errors: ui.conflictErrors,
        onClose: closeSheet,
        onChoose: (conflict, field, choice) => {
          ui.choices.set(conflict, {
            ...(ui.choices.get(conflict) ?? {}),
            [field]: choice,
          });
          ui.conflictErrors.delete(conflict);
          schedule();
        },
        onResolve: conflict =>
          void controller
            .resolve(conflict, ui.choices.get(conflict) ?? {})
            .catch((error: unknown) => {
              ui.conflictErrors.set(
                conflict,
                error instanceof Error ? error.message : String(error),
              );
              schedule();
            }),
        onKeep: conflict => void controller.keepAsLocal(conflict),
        onRemove: conflict => {
          ui.confirming = undefined;
          void controller.removeLocal(conflict);
        },
        onConfirm: conflict => set({ confirming: conflict }),
      });

    return undefined;
  }

  function screen(snap: Snapshot, c: Ctx): Array<HTMLElement | undefined> {
    const state: ViewState = snap.state;
    const narrow = c.width < 720;

    switch (state.kind) {
      case 'loading':
        return [h(doc, 'p', { class: 'sr-only', role: 'status' }, 'Loading…')];
      case 'no-relay':
        return [noRelay(doc)];
      case 'disconnected':
      case 'connecting':
        return [
          h(
            doc,
            'div',
            { class: 'pl-scroll' },
            firstRun(doc, {
              connecting: state.kind === 'connecting',
              onConnect: () => void controller.connect(),
              onCancel: () => controller.cancelConnect(),
            }),
          ),
        ];

      case 'choosing': {
        const account = state.calendars.find(x => x.primary)?.id;

        return [
          connectionBar(doc, {
            provider: 'Google Calendar',
            ...(account ? { account } : {}),
          }),
          h(
            doc,
            'div',
            { class: 'pl-scroll' },
            picker(doc, {
              calendars: state.calendars,
              onImport: id => void controller.choose(id),
            }),
          ),
        ];
      }

      default:
    }

    if (!snap.meta)
      // Listing calendars, or failed before a calendar was chosen.
      return [
        headerRow(snap, narrow),
        banners(snap),
        state.kind === 'error'
          ? undefined
          : h(
              doc,
              'p',
              { class: 'fine', style: 'padding:14px', role: 'status' },
              'Reading your calendars…',
            ),
      ];

    const days = ui.view === 'week' ? dayCount(c.width) : 7;
    const from =
      ui.view === 'week' && days === 7 ? mondayOf(ui.anchor) : ui.anchor;

    return [
      headerRow(snap, narrow),
      cbar(snap),
      banners(snap),
      h(
        doc,
        'div',
        { class: 'shell' },
        c.width >= 900 && ui.view === 'week'
          ? sidebar(c, {
              month: ui.month,
              selected: ui.anchor,
              weekFrom: from,
              weekDays: days,
              meta: snap.meta,
              visible: ui.visible,
              ...(snap.summary ? { summary: snap.summary } : {}),
              whyOpen: ui.why,
              onMonth: date => set({ month: date }),
              onVisible: visible => set({ visible }),
              onWhy: () => set({ why: !ui.why }),
            })
          : null,
        content(snap, c, narrow),
        drawer(snap, c, narrow) ?? null,
      ),
    ];
  }

  function render() {
    const snap = controller.snapshot();
    const c = ctx();
    const key = focusKey(doc);
    const scrollers = new Map<string, number>();
    for (const node of root.querySelectorAll<HTMLElement>('[data-scroll]'))
      scrollers.set(node.dataset.scroll!, node.scrollTop);

    const parts = screen(snap, c).filter((p): p is HTMLElement => !!p);
    const overlay = sheetFor(snap, c);
    root.replaceChildren(...parts, ...(overlay ? [overlay] : []));

    // Put back what a rebuild would lose: scroll positions and focus.
    for (const node of root.querySelectorAll<HTMLElement>('[data-scroll]')) {
      const before = scrollers.get(node.dataset.scroll!);
      if (before !== undefined) node.scrollTop = before;
    }

    const grid = root.querySelector<HTMLElement>('[data-scroll="week"]');

    if (grid && ui.scrollTo !== undefined) {
      // A little higher, so the first hour's label is not under the edge.
      grid.scrollTop = Math.max(0, ui.scrollTo * ROW - 10);
      ui.scrollTo = undefined;
    }

    restoreFocus(root, key);
  }

  // ---- keyboard (DESIGN.md §6) --------------------------------------------

  doc.addEventListener('keydown', event => {
    const target = event.target as HTMLElement;
    if (event.altKey || event.ctrlKey || event.metaKey) return;

    if (event.key === 'Escape') {
      if (ui.menu) set({ menu: false });
      else if (ui.sheet) closeSheet();
      else if (ui.drawer) closeDrawer();
      else return;
      event.preventDefault();

      return;
    }

    if (TYPING.test(target.tagName) || target.isContentEditable) return;
    const snap = controller.snapshot();
    if (!snap.meta) return;

    if (ui.sheet) {
      if (event.key === '?') openSheet('shortcuts');

      return;
    }

    const focused = target.closest<HTMLElement>('[data-subject]');
    let handled = true;

    switch (event.key) {
      case 't':
        ctx().goTo(today());
        break;
      case 'ArrowLeft':
      case 'k':
        step(-1);
        break;
      case 'ArrowRight':
      case 'j':
        step(1);
        break;
      case 'a':
        ctx().setView('agenda');
        break;
      case 'w':
        ctx().setView('week');
        break;
      case '?':
        openSheet('shortcuts');
        break;

      case 'e': {
        const subject = ui.drawer?.subject ?? focused?.dataset.subject;
        const e = snap.events.find(x => x.subject === subject);

        if (!e || e.readOnly) {
          handled = false;
          break;
        }

        const from = ui.drawer?.from ?? focused?.dataset.key;
        set({
          drawer: {
            subject: e.subject,
            mode: 'edit',
            ...(from ? { from } : {}),
          },
        });
        focusSoon('[data-key="f-title"]');
        break;
      }

      default:
        handled = false;
    }

    if (handled) event.preventDefault();
  });

  doc.addEventListener('click', event => {
    if (ui.menu && !(event.target as HTMLElement).closest('.cbar-menu'))
      set({ menu: false });
  });

  // ---- size and time ------------------------------------------------------

  win.addEventListener('resize', () => {
    if (!editing) schedule();
  });
  // The now line and "Synced 4 min ago" move once a minute.
  setInterval(() => {
    if (!editing) schedule();
  }, 60_000);

  render();
  await controller.load().catch((error: unknown) => {
    root.replaceChildren(
      banner(doc, {
        tone: 'neg',
        role: 'alert',
        title: 'The calendar could not load.',
        body: error instanceof Error ? error.message : String(error),
      }),
    );
  });
}
