// @wc-ignore-file
/**
 * Mounts the Money app: controller, rendering, layout bands, keyboard and
 * file handling. `main.ts` exports it to the host as `view()`; the
 * screenshot harness calls it with a pinned date and locale.
 */
import { createController, type State } from './controller.js';
import { MONEY_CSS } from './styles.js';
import type { PluginStore } from './store.js';
import { installStyles } from './ui/components.js';
import { isTyping, replaceKeepingFocus, trapTab } from './ui/focus.js';
import { renderApp, type Actions } from './view.js';

export interface MountOptions {
  /** ISO date the period filters count from; today by default. */
  today?: () => string;
  /** BCP 47 locale for dates and amounts; the browser's by default. */
  locale?: string;
  /** A fixed layout width (tests); otherwise the frame's, observed. */
  width?: number;
}

/** Renders the app into `root`. `view()` is this with the browser's defaults. */
export async function mount(
  root: HTMLElement,
  store: PluginStore,
  options: MountOptions = {},
): Promise<void> {
  const doc = root.ownerDocument;
  const win = doc.defaultView ?? window;
  installStyles(doc, 'money-app-styles', MONEY_CSS);
  root.classList.add('pl-app');
  const locale = options.locale ?? win.navigator?.language;
  let width = options.width ?? (root.clientWidth || win.innerWidth || 1024);
  let current: State | undefined;
  let rendered: string | undefined;

  const fileInput = doc.createElement('input');
  fileInput.type = 'file';
  fileInput.accept = '.mt940,.sta,.940,.txt,.xml,.camt,.053';
  fileInput.hidden = true;

  const actions: Actions = {
    setTab: tab => controller.setTab(tab),
    reload: () => void controller.load(),
    setFilters: patch => controller.setFilters(patch),
    clearFilters: () => controller.clearFilters(),
    showMore: () => controller.showMore(),
    select: subject => {
      if (subject === undefined) closeDetail();
      else controller.select(subject);
    },
    draft: (field, value) => controller.draft(field, value),
    saveNote: (field, value) => void controller.saveNote(field, value),
    showStatement: key => {
      controller.select(undefined);
      controller.setTab('transactions');
      controller.setFilters({
        statement: key,
        account: '',
        period: { kind: 'all' },
      });
    },
    chooseFile: () => {
      fileInput.value = '';
      fileInput.click();
    },
  };

  /** The modal (detail drawer or sheet, import sheet) that holds focus. */
  const modal = () =>
    root.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');

  const draw = (state: State) => {
    const opened = state.selected && state.selected !== current?.selected;
    current = state;
    replaceKeepingFocus(root, [
      ...renderApp(
        { state, width, locale, today: controller.today() },
        actions,
      ),
      fileInput,
    ]);
    // A modal detail takes focus when it opens; the docked one leaves it on
    // the row, which stays in view beside it.
    if (opened)
      modal()?.querySelector<HTMLElement>('[data-key="detail-close"]')?.focus();
  };

  /** Closes the detail and returns focus to the row that opened it. */
  const closeDetail = () => {
    const subject = current?.selected;
    if (!subject) return;
    controller.select(undefined);
    root
      .querySelector<HTMLElement>(`[data-row="${CSS.escape(subject)}"]`)
      ?.focus();
  };

  const controller = createController(store, draw, { today: options.today });

  // Layout follows the frame's width: table or list, docked or modal detail.
  if (options.width === undefined && typeof ResizeObserver !== 'undefined')
    new ResizeObserver(() => {
      const next = root.clientWidth;
      const band = next < 560 ? 'narrow' : next < 900 ? 'medium' : 'wide';

      if (next && band !== rendered) {
        rendered = band;
        width = next;
        if (current) draw(current);
      } else width = next || width;
    }).observe(root);

  doc.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.metaKey || event.ctrlKey) return;
    const open = modal();
    if (open) trapTab(open, event);

    if (event.key === 'Escape' && current?.selected) {
      event.preventDefault();
      closeDetail();

      return;
    }

    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      const target = event.target as HTMLElement;
      if (!target.dataset?.row) return;
      const rows = [...root.querySelectorAll<HTMLElement>('[data-row]')];
      const at = rows.indexOf(target);
      const next = rows[at + (event.key === 'ArrowDown' ? 1 : -1)];

      if (next) {
        event.preventDefault();
        for (const row of rows) row.tabIndex = row === next ? 0 : -1;
        next.focus();
      }

      return;
    }

    if (isTyping(event)) return;

    if (event.key === '/') {
      const search = root.querySelector<HTMLInputElement>(
        '[data-key="search"]',
      );

      if (search) {
        event.preventDefault();
        search.focus();
      }
    } else if (event.key === 'i' && !open) {
      event.preventDefault();
      actions.chooseFile();
    }
  });

  draw(controller.state());
  await controller.load();
}
