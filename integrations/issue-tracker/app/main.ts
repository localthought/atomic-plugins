// @wc-ignore-file
/**
 * The drive-plugin entry point. The host's shell does
 * `const plugin = await import(js_url); await plugin.view({ root, store })`
 * (atomic-server `server/src/handlers/plugin_ui.rs`), so this module exports
 * `view` and renders nothing on import. One module; its CSS is injected as
 * one `<style>` element, since the frame serves no stylesheet.
 *
 * The screens follow design/DESIGN.md and design/mockups.html (#89): source
 * choice, repository picker, board and list with a shared filter, the issue
 * detail, conflict review and the review-before-send list. `views.ts` builds
 * them from the controller's `ViewState` and this module's `Ui` state; this
 * module owns rendering, focus, keyboard and the automatic retry.
 *
 * Sync runs when the view opens (once a repository is bound), on "Sync now",
 * after each edit made here, and after a transient failure (4, 8, … up to 60
 * minutes, while the view is open). Nothing runs while the app is closed.
 */
import { createController, type ViewState } from './controller.js';
import {
  canMove,
  detailModeFor,
  layoutFor,
  STATUS_KEYS,
  typing,
} from './model.js';
import type { ViewArgs } from './store.js';
import { APP_CSS } from './styles.js';
import { liveRegion } from './ui/kit.js';
import { injectStyles, watchFrame } from './ui/theme.js';
import {
  page,
  refOf,
  type Actions,
  type Drafts,
  type Panel,
  type Ui,
} from './views.js';

const RETRY_FIRST = 4 * 60;
const RETRY_MAX = 60 * 60;

const freshDrafts = (): Drafts => ({
  tab: 'preview',
  comment: '',
  newTitle: '',
  newBody: '',
  newStatus: 'Todo',
});

export async function view({ root, store }: ViewArgs): Promise<void> {
  injectStyles(root, APP_CSS);
  root.classList.add('pl-app');
  const doc = root.ownerDocument;
  const win = doc.defaultView!;
  const live = liveRegion();

  const ui: Ui = {
    size: 'xl',
    search: '',
    allDone: false,
    groups: {},
    help: false,
    drafts: freshDrafts(),
    repoFilter: '',
    typedRepo: '',
    alert: false,
    flash: new Set(),
    now: Date.now(),
  };
  /** Where focus goes when the open panel closes. */
  let focusBack: string | undefined;
  /** Set once the view's first sync has settled; later problems are alerts. */
  let settled = false;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryDelay = RETRY_FIRST;
  let retryAt: number | undefined;
  let prefsTimer: ReturnType<typeof setTimeout> | undefined;
  let previous: Map<string, string> | undefined;

  const render = () => {
    ui.now = Date.now();
    if (retryAt) ui.retryIn = Math.max(0, (retryAt - ui.now) / 1000);
    else delete ui.retryIn;
    const state = controller.state();
    const active = doc.activeElement as HTMLElement | null;
    const key =
      active && root.contains(active) ? active.dataset.key : undefined;
    const field = active as HTMLInputElement | null;
    const selection =
      key && typeof field?.selectionStart === 'number'
        ? [field.selectionStart, field.selectionEnd ?? field.selectionStart]
        : undefined;
    const scrolls = [
      ...root.querySelectorAll<HTMLElement>('.board, .detail, .repos'),
    ].map(
      el => [el.className.split(' ')[0], el.scrollLeft, el.scrollTop] as const,
    );

    const layout = layoutFor(ui.size, ui.layout);
    const mode = detailModeFor(ui.size);
    root.replaceChildren(
      ...page(state, ui, layout, mode, actions),
      live.region,
    );

    for (const [cls, left, top] of scrolls) {
      const el = root.querySelector<HTMLElement>(`.${cls}`);

      if (el) {
        el.scrollLeft = left;
        el.scrollTop = top;
      }
    }

    if (!key) return;
    const again = byKey(key);
    if (!again) return;
    again.focus({ preventScroll: true });

    if (selection && 'setSelectionRange' in again) {
      try {
        (again as HTMLInputElement).setSelectionRange(
          selection[0],
          selection[1],
        );
      } catch {
        // Not a text field any more.
      }
    }
  };

  function byKey(key: string): HTMLElement | null {
    const quoted = key.replace(/["\\]/g, '\\$&');

    return root.querySelector<HTMLElement>(`[data-key="${quoted}"]`);
  }

  const focusKey = (key: string | undefined) => {
    if (key) byKey(key)?.focus();
  };

  const scheduleRetry = (state: ViewState) => {
    const failed = state.kind === 'ready' && state.problem?.kind === 'failed';

    if (!failed) {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      retryAt = undefined;
      if (state.kind === 'ready' && !state.problem && !state.busy)
        retryDelay = RETRY_FIRST;

      return;
    }

    if (retryTimer) return;
    retryAt = Date.now() + retryDelay * 1000;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      retryAt = undefined;
      retryDelay = Math.min(RETRY_MAX, retryDelay * 2);
      void controller.sync();
    }, retryDelay * 1000);
  };

  /** Rows whose content changed since the last result, for the 1.5 s highlight. */
  const noteChanges = (state: ViewState) => {
    if (state.kind !== 'ready' || state.busy || !state.last) return;
    const now = new Map(
      state.last.result.rows.map(r => [
        r.subject,
        [r.title, r.status, r.body, r.comments.length, r.updatedAt].join('\n'),
      ]),
    );
    ui.flash = new Set();

    if (previous) {
      const mine = new Set(state.touched ?? []);

      for (const [subject, sig] of now) {
        const before = previous.get(subject);
        if (before !== undefined && before !== sig && !mine.has(subject))
          ui.flash.add(subject);
      }
    }

    previous = now;
  };

  const onState = (state: ViewState) => {
    if (state.kind === 'ready') {
      ui.alert = settled && !!state.problem;
      // A settled conflict closes its review panel.
      if (
        ui.panel?.kind === 'conflict' &&
        state.problem?.kind !== 'conflict' &&
        !state.busy
      )
        ui.panel = undefined;
    }

    noteChanges(state);
    scheduleRetry(state);
    render();
  };

  const controller = createController(store, onState);

  const savePrefs = () => {
    if (prefsTimer) clearTimeout(prefsTimer);
    prefsTimer = setTimeout(() => {
      if (controller.state().kind !== 'ready') return;
      void controller.savePrefs({
        ...(ui.layout ? { layout: ui.layout } : {}),
        ...(ui.search ? { search: ui.search } : {}),
        ...(ui.label ? { label: ui.label } : {}),
      });
    }, 800);
  };

  const readyState = () => {
    const s = controller.state();

    return s.kind === 'ready' ? s : undefined;
  };

  const rowOf = (subject: string) =>
    readyState()?.last?.result.rows.find(r => r.subject === subject);

  const actions: Actions = {
    connect: () => void controller.connect(),
    listRepositories: () => void controller.listRepositories(),
    choose: repository => void controller.choose(repository),
    sync: () => void controller.sync(),
    send: () => {
      if (ui.panel?.kind === 'review') ui.panel = undefined;
      void controller.send().then(() => focusKey(focusBack ?? 'sync-now'));
    },

    move(subject, status, via) {
      const state = readyState();
      const row = rowOf(subject);
      if (!state || !row || row.status === status || !canMove(state)) return;
      live.say(`Moved ${refOf(row)} to ${status}`);
      if (via === 'key') ui.focus = subject;
      void controller.edit(subject, { status });
    },

    open(panel: Panel | undefined, back?: string) {
      if (panel && back) focusBack = back;
      const switching =
        panel?.kind !== ui.panel?.kind ||
        (panel?.kind === 'issue' &&
          ui.panel?.kind === 'issue' &&
          panel.subject !== ui.panel.subject);
      if (switching)
        ui.drafts = {
          ...freshDrafts(),
          newStatus: ui.drafts.newStatus,
          ...(panel?.kind === 'new'
            ? { newTitle: ui.drafts.newTitle, newBody: ui.drafts.newBody }
            : {}),
        };
      ui.panel = panel;
      ui.menu = undefined;
      render();

      if (!panel) {
        focusKey(focusBack);
        focusBack = undefined;
        ui.drafts.newStatus = 'Todo';

        return;
      }

      if (panel.kind === 'conflict' && !panel.fields && !panel.error) {
        void controller
          .conflict()
          .then(fields => {
            if (ui.panel?.kind !== 'conflict') return;
            ui.panel = fields
              ? { ...ui.panel, fields }
              : { ...ui.panel, error: 'This conflict is already settled.' };
            render();
          })
          .catch(error => {
            if (ui.panel?.kind !== 'conflict') return;
            ui.panel = {
              ...ui.panel,
              error: error instanceof Error ? error.message : String(error),
            };
            render();
          });
      }

      // The drawer and the sheet are modal: focus moves into them. The
      // docked panel is not, so focus stays on the card that opened it.
      if (!switching || ui.size === 'xl') return;
      // A new issue starts in its title; anything else at the panel's
      // close (or back) button, so nothing looks like it is being edited.
      focusKey(panel.kind === 'new' ? 'new-title' : 'detail-close');
    },

    saveTitle(subject, title) {
      ui.drafts.title = undefined;
      void controller.edit(subject, { title });
    },

    saveBody(subject, body) {
      ui.drafts = { ...ui.drafts, body: undefined, tab: 'preview' };
      void controller.edit(subject, { body });
    },

    comment(subject, body) {
      if (!body.trim()) return;
      ui.drafts.comment = '';
      live.say('Comment added; waiting to send');
      void controller.comment(subject, body);
    },

    create() {
      const d = ui.drafts;
      if (!d.newTitle.trim()) return;
      const input = {
        title: d.newTitle.trim(),
        body: d.newBody,
        status: d.newStatus,
      };
      ui.drafts = freshDrafts();
      void controller.create(input).then(({ subject }) => {
        if (subject && ui.panel?.kind === 'new') {
          ui.panel = { kind: 'issue', subject };
          focusBack = `card:${subject}`;
          render();
        }
      });
    },

    resolve() {
      const panel = ui.panel;
      if (panel?.kind !== 'conflict') return;
      void controller.resolve(panel.choices);
    },

    setUi(patch, again = true) {
      const persist =
        'layout' in patch || 'search' in patch || 'label' in patch;
      Object.assign(ui, patch);
      if ('label' in patch && patch.label === undefined) delete ui.label;
      if (persist) savePrefs();
      if (again) render();
    },

    setDrafts(patch, again = true) {
      ui.drafts = { ...ui.drafts, ...patch };
      if (again) render();
    },

    openGitHub(url) {
      // The frame is sandboxed without allow-popups, so this can be refused;
      // the issue panel's footer link shows the URL either way.
      try {
        win.open(url, '_blank', 'noopener');
      } catch {
        // Refused by the sandbox.
      }
    },

    focusSearch() {
      focusKey('search');
    },
  };

  // ---------------------------------------------------------- keyboard
  let gPending: ReturnType<typeof setTimeout> | undefined;

  const issues = () =>
    [...root.querySelectorAll<HTMLElement>('[data-issue]')].filter(
      el => !el.closest('.detail'),
    );

  const focusedSubject = (): string | undefined => {
    const el = (doc.activeElement as HTMLElement | null)?.closest<HTMLElement>(
      '[data-subject]',
    );

    return (
      el?.dataset.subject ??
      (ui.panel?.kind === 'issue' ? ui.panel.subject : undefined)
    );
  };

  const closeMenu = () => {
    const trigger = ui.menu ?? '';
    ui.menu = undefined;
    render();
    focusKey(
      trigger.startsWith('move:')
        ? `cardmenu:${trigger.slice(5)}`
        : trigger.startsWith('status:')
          ? `glyph:${trigger.slice(7)}`
          : trigger === 'label'
            ? 'label-filter'
            : undefined,
    );
  };

  const trapFocus = (e: KeyboardEvent) => {
    const panel = root.querySelector<HTMLElement>('.detail');
    const focusable = panel
      ? [
          ...panel.querySelectorAll<HTMLElement>(
            'button:not(:disabled), textarea, input:not(:disabled), a[href], [tabindex="0"]',
          ),
        ]
      : [];
    if (!focusable.length) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    const inside = panel!.contains(doc.activeElement);

    if (!inside || (e.shiftKey && doc.activeElement === first)) {
      e.preventDefault();
      (e.shiftKey ? last : first).focus();
    } else if (!e.shiftKey && doc.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const shortcut = (e: KeyboardEvent): boolean => {
    const key = e.key;

    if (gPending && key.toLowerCase() === 's') {
      clearTimeout(gPending);
      gPending = undefined;
      actions.sync();

      return true;
    }

    if (key === 'g' || key === 'G') {
      gPending = setTimeout(() => (gPending = undefined), 1000);

      return false;
    }

    if (key === '/') actions.focusSearch();
    else if (key === '?') {
      actions.setUi({ help: true });
      focusKey('help-close');
    } else if (key === 'b' || key === 'B') {
      const now = layoutFor(ui.size, ui.layout);
      actions.setUi({ layout: now === 'board' ? 'list' : 'board' });
    } else if (key === 'n' || key === 'N')
      actions.open({ kind: 'new' }, 'new-issue');
    else if (key === 'c' || key === 'C') {
      if (ui.panel?.kind !== 'issue') return false;
      focusKey('composer');
    } else if (['j', 'k', 'J', 'K', 'ArrowDown', 'ArrowUp'].includes(key)) {
      if (ui.panel && ui.size !== 'xl') return false;
      const all = issues();
      if (!all.length) return false;
      const at = all.indexOf(doc.activeElement as HTMLElement);
      const down = key === 'j' || key === 'J' || key === 'ArrowDown';
      const next =
        at < 0
          ? down
            ? 0
            : all.length - 1
          : Math.min(all.length - 1, Math.max(0, at + (down ? 1 : -1)));
      all[next].focus();
    } else if (key in STATUS_KEYS) {
      const subject = focusedSubject();
      if (!subject) return false;
      actions.move(subject, STATUS_KEYS[key], 'key');
    } else return false;

    return true;
  };

  doc.addEventListener('keydown', e => {
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey) return;

    if (e.key === 'Escape') {
      if (ui.menu) closeMenu();
      else if (ui.help) actions.setUi({ help: false });
      else if (ui.panel) actions.open(undefined);
      else return;
      e.preventDefault();

      return;
    }

    // The drawer and the sheet are modal: Tab stays inside them.
    if (e.key === 'Tab' && ui.panel && ui.size !== 'xl') {
      trapFocus(e);

      return;
    }

    if (typing(e.target) || ui.help || !readyState()) return;
    // Arrow keys inside an open menu move within the menu.
    if (ui.menu && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) return;
    if (shortcut(e)) e.preventDefault();
  });

  // Clicks outside an open menu or popover close it.
  doc.addEventListener('click', event => {
    if (!ui.menu) return;
    const target = event.target as HTMLElement;
    if (target.closest?.('.menu, .popover, [aria-haspopup]')) return;
    ui.menu = undefined;
    render();
  });

  watchFrame(root, size => {
    ui.size = size;
    render();
  });
  // Relative times ("Synced 3 min ago") and the retry countdown; never
  // under someone typing.
  setInterval(() => {
    if (!typing(doc.activeElement)) render();
  }, 30_000);

  render();

  try {
    const state = await controller.load();

    if (state.kind === 'ready') {
      const prefs = controller.prefs();
      if (prefs.layout) ui.layout = prefs.layout;
      if (prefs.search) ui.search = prefs.search;
      if (prefs.label) ui.label = prefs.label;
      render();
      await controller.sync();
    } else if (state.kind === 'choose-repository') {
      await controller.listRepositories();
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const p = doc.createElement('p');
    p.className = 'field-error';
    p.style.padding = '16px';
    p.textContent = `Could not load: ${message}`;
    root.append(p);
  } finally {
    settled = true;
  }
}
