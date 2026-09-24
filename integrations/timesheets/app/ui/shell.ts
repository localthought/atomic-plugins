// @wc-ignore-file
/**
 * The app's view (#89 frame by frame): header row, connection bar, toolbar,
 * one of the three views, and the detail and settings overlays, rendered
 * from the controller's `ViewState` and `Timesheet`. Plain DOM, re-rendered
 * whole on every change; focus is kept by each control's `data-k`.
 *
 * View, week, highlighted cell and open entry live in memory only: the
 * frame is null-origin with no storage, and writing them to the App would
 * be a signed write per click (§5).
 */
import type { LookbackDays } from '../../localthought.js';
import {
  describe,
  type Controller,
  type SyncOutcome,
  type ViewState,
} from '../controller.js';
import {
  ago,
  dayKey,
  formatRange,
  shiftWeek,
  weekOf,
  weekSpan,
  type DayKey,
  type Week,
} from '../model/time.js';
import type { Timesheet } from '../model/types.js';
import { dayList, projectSummary, weekGrid } from '../model/views.js';
import { button, header, pill, type PillState } from './components.js';
import { renderConflicts, renderUnknown, unknownIn } from './coverage.js';
import { entryDetail, type Overlay } from './detail.js';
import { builder, type Child } from './dom.js';
import { dayCard, dayCards, weekStrip, type Highlight } from './entries.js';
import { projectsView } from './projects.js';
import { settingsSheet } from './settings.js';
import {
  emptyWindow,
  firstRun,
  loadingPanel,
  noRelay,
  outsideWindow,
  problemBanner,
  setupError,
  setupForm,
  skeleton,
  waiting,
  warningBanner,
} from './states.js';
import { duration, runningNote, weekFoot, weekTable } from './week.js';

export type Size = 'narrow' | 'mid' | 'wide';
type ViewName = 'week' | 'entries' | 'projects';

/** Frame widths from the design (§8): < 560 narrow, < 720 mid, else wide. */
export const sizeOf = (width: number): Size =>
  width < 560 ? 'narrow' : width < 720 ? 'mid' : 'wide';

interface Choice {
  workspaceId: string;
  lookbackDays: LookbackDays;
}

interface Ui {
  view: ViewName;
  /** Undefined: the current week. */
  week?: Week;
  highlight?: Highlight;
  /** The narrow strip's selected day. */
  day?: DayKey;
  entryId?: string;
  /** `data-k` of the row that opened the drawer, to return focus to. */
  opener?: string;
  /** Settings was asked for over the data (sheet), not first-run setup. */
  settingsOpen: boolean;
  choice?: Choice;
  confirming: boolean;
  /** `at` of the outcome whose warnings were dismissed. */
  dismissed?: number;
  scrollTo?: DayKey;
}

export interface Shell {
  render(): void;
  destroy(): void;
}

export interface ShellOptions {
  now?: () => number;
  /** For tests: a fixed frame width instead of a ResizeObserver. */
  width?: number;
}

const DAY = 86_400_000;

export function mountShell(
  root: HTMLElement,
  controller: Controller,
  options: ShellOptions = {},
): Shell {
  const doc = root.ownerDocument;
  const h = builder(doc);
  const now = options.now ?? Date.now;
  const ui: Ui = { view: 'week', settingsOpen: false, confirming: false };
  const status = h('div', { role: 'status', class: 'sr' });
  const frame = h('div', { class: 'pl' });
  frame.append(status);
  const main = h('div');
  frame.append(main);
  root.append(frame);

  let size: Size = sizeOf(options.width ?? (root.clientWidth || 1024));
  let timer: ReturnType<typeof setTimeout> | undefined;
  let overlayWas = false;
  let observer: ResizeObserver | undefined;

  if (options.width === undefined && typeof ResizeObserver === 'function') {
    observer = new ResizeObserver(() => {
      const next = sizeOf(root.clientWidth || 1024);

      if (next !== size) {
        size = next;
        render();
      }
    });
    observer.observe(root);
  }

  const update = (change: () => void) => () => {
    change();
    render();
  };

  const sync = () => void controller.sync();

  const openSettings = () => {
    ui.settingsOpen = true;
    ui.confirming = false;
    void controller.openSettings();
  };

  // ---- pieces --------------------------------------------------------------

  function pillFor(state: ViewState): [PillState, string] {
    switch (state.kind) {
      case 'loading':
        return ['idle', 'Loading…'];
      case 'no-proxy':
        return ['paused', 'Offline'];
      case 'not-connected':
        return ['idle', 'Not connected'];
      case 'connecting':
        return ['syncing', 'Connecting…'];
      case 'setup':
        return state.busy === 'saving'
          ? ['syncing', 'Saving…']
          : ['synced', 'Connected'];
      case 'syncing':
        return ['syncing', 'Syncing…'];
      case 'failed':
        return ['error', 'Error'];
      case 'ready':
        if (!state.last) return ['idle', 'Not synced yet'];
        if (state.last.ok)
          return ['synced', `Synced ${ago(state.last.at, now())}`];

        return state.last.problem.kind === 'reauth'
          ? ['reauth', 'Reconnect needed']
          : ['error', 'Sync failed'];
    }
  }

  const failure = (state: ViewState) =>
    state.kind === 'ready' && state.last && !state.last.ok
      ? (state.last as Extract<SyncOutcome, { ok: false }>)
      : undefined;

  const waitSeconds = (state: ViewState) => {
    const last = failure(state);
    if (last?.problem.kind !== 'rate-limited') return 0;
    const until = last.at + (last.problem.retryAfterSeconds ?? 60) * 1000;

    return Math.max(0, Math.ceil((until - now()) / 1000));
  };

  function headerRow(state: ViewState, sheet: Timesheet | undefined) {
    const [pillState, pillText] = pillFor(state);
    const connected =
      state.kind === 'ready' ||
      state.kind === 'syncing' ||
      state.kind === 'setup' ||
      state.kind === 'no-proxy';
    const workspace = controller.names().workspaceName;
    const chipText = workspace ? `Clockify · ${workspace}` : 'Clockify';
    // Frame I puts Sync now in the empty state instead.
    const canSync =
      (state.kind === 'ready' || state.kind === 'syncing') &&
      !isEmpty(state, sheet);
    const reauth = failure(state)?.problem.kind === 'reauth';

    return header(h, {
      title: 'Timesheets',
      srPrefix: 'Clockify ',
      mark: 'clock',
      chip:
        connected && size !== 'narrow'
          ? { letter: 'C', text: chipText }
          : undefined,
      pill: pill(h, pillState, pillText),
      action: canSync
        ? button(h, 'Sync now', {
            icon: 'sync',
            iconOnly: size !== 'wide',
            key: 'sync',
            variant: reauth ? 'sec' : 'primary',
            disabled: state.kind === 'syncing' || waitSeconds(state) > 0,
            onClick: sync,
          })
        : null,
    });
  }

  function connectionBar(state: ViewState, sheet: Timesheet | undefined) {
    const { userName, workspaceName } = controller.names();
    const items: Child[] = [];
    const windowText = sheet?.window
      ? formatRange(
          dayKey(sheet.window.from, sheet.timeZone),
          dayKey(sheet.window.to, sheet.timeZone),
          false,
        )
      : undefined;

    if (size === 'narrow')
      items.push(
        h(
          'span',
          null,
          h(
            'b',
            null,
            workspaceName ? `Clockify · ${workspaceName}` : 'Clockify',
          ),
        ),
      );
    else if (userName)
      items.push(h('span', null, 'Connected as ', h('b', null, userName)));

    const inWindow = sheet ? entriesInWindow(sheet) : 0;
    let progress: HTMLElement | null = null;

    if (state.kind === 'syncing' && state.progress) {
      const p = state.progress;

      if (p.phase === 'fetch')
        items.push(
          h(
            'span',
            null,
            'Fetching time entries… ',
            h('b', null, `page ${p.page}`),
          ),
        );
      else {
        items.push(
          h(
            'span',
            null,
            `Saving ${p.total} ${p.total === 1 ? 'entry' : 'entries'}… `,
            h('b', null, `${p.done} of ${p.total}`),
          ),
        );
        progress = h(
          'span',
          { class: 'progress', 'aria-hidden': 'true' },
          h('i', {
            style: `width: ${p.total ? Math.round((p.done / p.total) * 100) : 0}%`,
          }),
        );
      }
    }

    const failed = failure(state);

    if (failed && sheet?.lastChecked)
      items.push(
        h(
          'span',
          null,
          'Last synced ',
          h('b', null, ago(Date.parse(sheet.lastChecked), now())),
        ),
      );
    else if (windowText)
      items.push(
        h(
          'span',
          null,
          size === 'narrow'
            ? windowText
            : ['Importing ', h('b', null, windowText)],
          size === 'narrow' || state.kind === 'syncing'
            ? ''
            : ', your entries only',
        ),
      );

    if (sheet && state.kind === 'ready' && size === 'wide')
      items.push(
        h('span', null, `${inWindow} ${inWindow === 1 ? 'entry' : 'entries'}`),
      );

    if (state.kind === 'ready') {
      const settings = h(
        'button',
        { type: 'button', class: 'link', 'data-k': 'settings' },
        'Settings',
      );
      settings.addEventListener('click', openSettings);
      items.push(settings);
    }

    if (!items.length) return null;

    return h('div', { class: 'conn' }, ...items, progress);
  }

  const currentWeek = (sheet: Timesheet) =>
    weekOf(now(), sheet.weekStart, sheet.timeZone);

  function toolbar(sheet: Timesheet, week: Week, total: number | undefined) {
    const current = currentWeek(sheet);
    const isCurrent = week.start >= current.start;
    const tabs = (['week', 'entries', 'projects'] as const).map(name => {
      const tab = h(
        'button',
        {
          type: 'button',
          role: 'tab',
          'aria-selected': ui.view === name ? 'true' : 'false',
          'aria-controls': 'view-panel',
          tabindex: ui.view === name ? '0' : '-1',
          'data-k': `view:${name}`,
        },
        name[0].toUpperCase() + name.slice(1),
      );
      tab.addEventListener(
        'click',
        update(() => {
          ui.view = name;
          ui.highlight = undefined;
        }),
      );

      return tab;
    });
    const seg = h(
      'div',
      { class: 'seg', role: 'tablist', 'aria-label': 'View' },
      ...tabs,
    );
    seg.addEventListener('keydown', event => {
      const step = ({ ArrowRight: 1, ArrowLeft: -1 } as Record<string, number>)[
        event.key
      ];
      if (!step) return;
      event.preventDefault();
      const names = ['week', 'entries', 'projects'] as const;
      ui.view = names[(names.indexOf(ui.view) + step + 3) % 3];
      ui.highlight = undefined;
      render();
      (
        main.querySelector(`[data-k="view:${ui.view}"]`) as HTMLElement | null
      )?.focus();
    });

    const nav =
      ui.view === 'projects'
        ? h(
            'div',
            { class: 'weeknav' },
            h(
              'span',
              { class: 'range' },
              sheet.window
                ? formatRange(
                    dayKey(sheet.window.from, sheet.timeZone),
                    dayKey(sheet.window.to, sheet.timeZone),
                  )
                : 'Everything imported',
            ),
            sheet.window
              ? h(
                  'span',
                  { class: 'muted', style: 'font-size: 12.5px' },
                  'the whole import window',
                )
              : null,
          )
        : h(
            'div',
            { class: 'weeknav' },
            button(h, 'Previous week', {
              variant: 'sec',
              icon: 'left',
              iconOnly: true,
              key: 'prev',
              onClick: update(() => goWeek(shiftWeek(week, -1))),
            }),
            h(
              'span',
              { class: 'range', 'aria-live': 'polite' },
              formatRange(week.days[0], week.days[6], size !== 'narrow'),
            ),
            button(h, 'Next week', {
              variant: 'sec',
              icon: 'right',
              iconOnly: true,
              key: 'next',
              disabled: isCurrent,
              onClick: update(() => goWeek(shiftWeek(week, 1))),
            }),
            size === 'narrow'
              ? null
              : button(h, 'This week', {
                  variant: 'ghost',
                  key: 'this',
                  disabled: isCurrent,
                  onClick: update(() => goWeek(undefined)),
                }),
          );

    const weekTotal =
      total === undefined
        ? null
        : h(
            'div',
            { class: 'weektotal' },
            h('small', null, size === 'narrow' ? 'Week' : 'Week total'),
            h('strong', null, ...duration(h, total)),
          );

    return size !== 'wide'
      ? h('div', { class: 'bar' }, nav, weekTotal, seg)
      : h('div', { class: 'bar' }, nav, seg, weekTotal);
  }

  const goWeek = (week: Week | undefined) => {
    ui.week = week;
    ui.highlight = undefined;
    ui.day = undefined;
  };

  /** Frame I: synced fine, and nothing in the window. */
  function isEmpty(state: ViewState, sheet: Timesheet | undefined) {
    return (
      !!sheet?.window &&
      state.kind === 'ready' &&
      !!state.last?.ok &&
      !entriesInWindow(sheet)
    );
  }

  function entriesInWindow(sheet: Timesheet) {
    const w = sheet.window;

    return w
      ? sheet.entries.filter(e => e.start >= w.from && e.start < w.to).length
      : sheet.entries.length;
  }

  // ---- the data views ------------------------------------------------------

  function dataView(
    state: ViewState,
    sheet: Timesheet,
  ): { body: Child[]; overlay?: Overlay } {
    const week = ui.week ?? currentWeek(sheet);
    const today = dayKey(now(), sheet.timeZone);
    const syncing = state.kind === 'syncing';
    const settings =
      state.kind === 'ready' || state.kind === 'syncing'
        ? state.settings
        : undefined;
    const lookbackDays: LookbackDays = settings?.lookbackDays ?? 30;
    const grid = weekGrid(sheet.entries, week, {
      timeZone: sheet.timeZone,
      now: now(),
      ...(sheet.window ? { window: sheet.window } : {}),
    });
    const content: Child[] = [];
    const failed = failure(state);
    const last = state.kind === 'ready' ? state.last : undefined;

    content.push(renderConflicts(h, sheet));
    if (state.kind === 'no-proxy') content.push(noRelay(h));

    if (failed)
      content.push(
        problemBanner(h, failed.problem, {
          workspaceName: controller.names().workspaceName,
          lookbackDays,
          waitSeconds: waitSeconds(state),
          syncing,
          actions: {
            reconnect: () => void controller.reconnect(),
            chooseWorkspace: openSettings,
            retry: sync,
            narrow: () => void controller.setLookback(7),
          },
        }),
      );

    if (last?.ok && last.result.warnings.length && ui.dismissed !== last.at)
      content.push(
        warningBanner(
          h,
          last.result.warnings,
          update(() => {
            ui.dismissed = last.at;
          }),
        ),
      );

    const firstImport = syncing && !sheet.entries.length;
    const empty = isEmpty(state, sheet);

    if (firstImport)
      return {
        body: [
          toolbarSkeleton(week),
          h('div', { class: 'content' }, ...content, ...skeleton(h)),
        ],
      };

    if (empty && sheet.window)
      return {
        body: [
          h(
            'div',
            { class: 'content', style: 'padding-top: 12px' },
            ...content,
            emptyWindow(h, {
              from: dayKey(sheet.window.from, sheet.timeZone),
              to: dayKey(sheet.window.to, sheet.timeZone),
              lookbackDays,
              syncing: false,
              onSync: sync,
              onWiden: () => void controller.setLookback(30),
            }),
          ),
        ],
      };

    const span = weekSpan(week, sheet.timeZone);
    const outside =
      ui.view !== 'projects' && sheet.window && grid.days.some(d => !d.inWindow)
        ? outsideWindow(h, {
            windowStart: dayKey(sheet.window.from, sheet.timeZone),
            lookbackDays,
            syncing,
            onWiden: () => void controller.setLookback(30),
          })
        : null;
    const unknown =
      ui.view !== 'projects'
        ? renderUnknown(h, sheet, span, unknownIn(sheet, span))
        : null;
    const dayProps = {
      timeZone: sheet.timeZone,
      today,
      stack: size === 'narrow',
      highlight: ui.highlight,
      onOpen: (entry: { id: string }) => {
        ui.entryId = entry.id;
        ui.opener = `entry:${entry.id}`;
        render();
      },
    };

    if (ui.view === 'week') {
      content.push(
        // Running timers are now, so the note belongs to the current week.
        week.start === currentWeek(sheet).start
          ? runningNote(h, sheet.running)
          : null,
        outside,
        unknown,
      );

      if (size === 'narrow') {
        const enabled = grid.days.filter(d => !d.isFuture).map(d => d.key);
        const withTime = grid.days
          .filter((d, i) => grid.dayTotals[i] > 0)
          .map(d => d.key);
        const selected =
          ui.day && enabled.includes(ui.day)
            ? ui.day
            : enabled.includes(today)
              ? today
              : (withTime.at(-1) ?? enabled.at(-1) ?? week.days[0]);
        const group = dayList(sheet.entries, week, sheet.timeZone).find(
          g => g.key === selected,
        ) ?? { key: selected, total: 0, entries: [] };
        content.push(
          weekStrip(h, grid.days, grid.dayTotals, selected, day => {
            ui.day = day;
            render();
            find(`tab:${day}`)?.focus();
          }),
          dayCard(h, group, {
            ...dayProps,
            attrs: {
              role: 'tabpanel',
              id: 'day-panel',
              'aria-labelledby': `tab-${selected}`,
            },
          }),
        );
      } else
        content.push(
          weekTable(h, {
            grid,
            week,
            onCell: (day, projectKey) => {
              ui.view = 'entries';
              ui.highlight = { day, projectKey };
              ui.scrollTo = day;
              render();
            },
          }),
          weekFoot(h, grid, sheet.timeZone),
        );
    } else if (ui.view === 'entries')
      content.push(
        outside,
        unknown,
        ...dayCards(h, dayList(sheet.entries, week, sheet.timeZone), dayProps),
      );
    else
      content.push(
        ...projectsView(h, projectSummary(sheet.entries, sheet.window)),
      );

    const entry = ui.entryId
      ? sheet.entries.find(e => e.id === ui.entryId)
      : undefined;
    if (ui.entryId && !entry) ui.entryId = undefined;

    return {
      body: [
        toolbar(sheet, week, ui.view === 'projects' ? undefined : grid.total),
        h(
          'div',
          {
            class: 'content',
            role: 'tabpanel',
            id: 'view-panel',
            'aria-label': ui.view,
          },
          ...content,
        ),
      ],
      ...(entry
        ? {
            overlay: entryDetail(h, entry, {
              timeZone: sheet.timeZone,
              full: size !== 'wide',
              lastChecked: sheet.lastChecked,
              onClose: update(() => {
                ui.entryId = undefined;
              }),
            }),
          }
        : {}),
    };
  }

  function toolbarSkeleton(week: Week) {
    return h(
      'div',
      { class: 'bar' },
      h(
        'div',
        { class: 'weeknav' },
        h(
          'span',
          { class: 'range' },
          formatRange(week.days[0], week.days[6], size !== 'narrow'),
        ),
      ),
    );
  }

  // ---- set-up --------------------------------------------------------------

  function choiceFor(state: Extract<ViewState, { kind: 'setup' }>): Choice {
    const { options: offered, draft } = state;
    ui.choice ??= {
      workspaceId:
        draft.workspaceId ??
        offered?.user.activeWorkspace ??
        offered?.workspaces[0]?.id ??
        '',
      lookbackDays: draft.lookbackDays ?? 30,
    };
    if (
      offered &&
      !offered.workspaces.some(w => w.id === ui.choice!.workspaceId)
    )
      ui.choice.workspaceId = offered.workspaces[0]?.id ?? '';

    return ui.choice;
  }

  const windowText = (days: LookbackDays) => {
    const zone = controller.sheet(now())?.timeZone ?? 'UTC';

    return formatRange(
      dayKey(now() - days * DAY, zone),
      dayKey(now(), zone),
      false,
    );
  };

  const save = () => {
    if (!ui.choice) return;
    void controller.saveSettings(ui.choice);
  };

  // ---- render --------------------------------------------------------------

  function render() {
    const state = controller.state();
    const sheet = controller.sheet(now());
    const active = doc.activeElement as HTMLElement | null;
    const focusKey = active?.closest?.('[data-k]')?.getAttribute('data-k');
    const focusInOverlay = !!active?.closest?.('[role="dialog"]');

    if (state.kind !== 'setup') {
      ui.settingsOpen = false;
      ui.choice = undefined;
      ui.confirming = false;
    }

    const text = describe(state);
    if (status.textContent !== text) status.textContent = text;
    frame.setAttribute('data-size', size);

    const parts: Child[] = [headerRow(state, sheet)];
    let overlay: Overlay | undefined;

    switch (state.kind) {
      case 'loading':
        parts.push(loadingPanel(h, 'Loading…'));
        break;
      case 'not-connected':
        parts.push(firstRun(h, () => void controller.connect()));
        break;
      case 'connecting':
        parts.push(waiting(h));
        break;
      case 'failed':
        parts.push(
          h(
            'div',
            { class: 'content', style: 'padding-top: 16px' },
            problemLike(state.message),
          ),
        );
        break;

      case 'setup': {
        const overData = ui.settingsOpen && sheet;
        const choice = choiceFor(state);

        if (overData) {
          parts.push(connectionBar(state, sheet));
          const view = dataView(state, sheet);
          parts.push(...view.body);

          if (state.error && !state.options)
            overlay = errorOverlay(state.error);
          else if (state.options)
            overlay = settingsSheet(h, {
              options: state.options,
              choice,
              timeZone: sheet.timeZone,
              zoneSource: controller.names().timeZone ? 'profile' : 'browser',
              entryCount: entriesInWindow(sheet),
              full: size !== 'wide',
              saving: state.busy === 'saving',
              error: state.error,
              canDisconnect: controller.canDisconnect(),
              confirming: ui.confirming,
              onChange: next => {
                ui.choice = next;
                render();
              },
              onSave: save,
              onCancel: () => {
                controller.cancelSettings();
                ui.opener = 'settings';
              },
              onAskDisconnect: update(() => {
                ui.confirming = true;
              }),
              onDisconnect: () => void controller.disconnect(),
              onKeepConnected: update(() => {
                ui.confirming = false;
              }),
            });
          break;
        }

        const user = state.options?.user;
        if (user)
          parts.push(
            h(
              'div',
              { class: 'conn' },
              h(
                'span',
                null,
                'Connected as ',
                h('b', null, user.name ?? user.email ?? user.id),
              ),
            ),
          );
        if (state.busy === 'options')
          parts.push(loadingPanel(h, 'Reading your Clockify workspaces…'));
        else if (!state.options)
          parts.push(
            setupError(
              h,
              state.error ?? 'Unknown error',
              () => void controller.openSettings(),
            ),
          );
        else
          parts.push(
            setupForm(h, {
              options: state.options,
              draft: state.draft,
              saving: state.busy === 'saving',
              error: state.error,
              choice,
              windowText,
              onChange: next => {
                ui.choice = next;
                render();
              },
              onSubmit: save,
            }),
          );
        break;
      }

      case 'no-proxy':
      case 'ready':

      case 'syncing': {
        if (!sheet) {
          parts.push(loadingPanel(h, 'Loading…'));
          break;
        }

        parts.push(connectionBar(state, sheet));
        const view = dataView(state, sheet);
        parts.push(...view.body);
        overlay = view.overlay;
        break;
      }
    }

    main.replaceChildren(h('div', null, ...parts));
    if (overlay) main.append(overlay.node);

    // Focus: into a newly opened overlay; back to its opener when it
    // closes; otherwise to the control that had it before the render.
    if (overlay && !overlayWas) overlay.focus.focus();
    else if (!overlay && overlayWas && ui.opener) {
      find(ui.opener)?.focus();
      ui.opener = undefined;
    } else if (focusKey) find(focusKey)?.focus();
    else if (focusInOverlay && overlay) overlay.focus.focus();
    overlayWas = !!overlay;

    if (ui.scrollTo) {
      const card = main.querySelector<HTMLElement>(
        `[data-day="${ui.scrollTo}"]`,
      );
      card?.scrollIntoView?.({ block: 'start' });
      const first = card?.querySelector<HTMLElement>('.entry.hl');
      first?.focus();
      ui.scrollTo = undefined;
    }

    schedule(state);
  }

  const find = (key: string) =>
    main.querySelector<HTMLElement>(
      `[data-k="${key.replace(/["\\]/g, '\\$&')}"]`,
    );

  function problemLike(message: string) {
    return h(
      'div',
      { class: 'banner neg', role: 'alert' },
      h('span'),
      h('p', null, h('strong', null, 'This app cannot run.'), ` ${message}`),
      h('span'),
    );
  }

  function errorOverlay(error: string): Overlay {
    const node = setupError(h, error, () => void controller.openSettings());
    const dialog = h(
      'div',
      { role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Settings' },
      h('div', { class: 'scrim' }),
      h(
        'div',
        { class: 'drawer full' },
        node,
        h(
          'footer',
          null,
          button(h, 'Close', {
            variant: 'ghost',
            key: 'settings-close',
            onClick: () => {
              controller.cancelSettings();
            },
          }),
        ),
      ),
    );

    return { node: dialog, focus: dialog.querySelector('button') ?? dialog };
  }

  /** Re-renders for "Synced 4 min ago" and a rate-limit countdown. */
  function schedule(state: ViewState) {
    if (timer) clearTimeout(timer);
    timer = undefined;
    if (ui.settingsOpen || state.kind !== 'ready') return;
    const wait = waitSeconds(state);
    timer = setTimeout(render, wait > 0 ? 1000 : 30_000);
  }

  return {
    render,
    destroy() {
      if (timer) clearTimeout(timer);
      observer?.disconnect();
    },
  };
}
