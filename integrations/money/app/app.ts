// @wc-ignore-file
/**
 * Mounts the Money app: controller, rendering, layout bands, keyboard and
 * file handling. `main.ts` exports it to the host as `view()`; the
 * screenshot harness calls it with a pinned date and locale.
 */
import { decodeStatement } from './check.js';
import { createController, type ImportPort, type State } from './controller.js';
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
  /** Applies an import; the pinned host offers none (issues.md M-8). */
  importer?: ImportPort;
  /** Yield between import check steps (the harness holds one). */
  tick?: () => Promise<void>;
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

  // The host's light/dark setting, for native controls and scrollbars; the
  // colours themselves arrive as --t-* variables.
  const scheme = (theme?: { colorScheme: string }) => {
    if (theme) root.dataset.colorScheme = theme.colorScheme;
  };

  scheme(store.getTheme?.());
  store.onThemeChange?.(scheme);
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
    closeImport: () => {
      controller.closeImport();
      opener?.focus();
    },
    setPreviewTab: tab => controller.setPreviewTab(tab),
    applyImport: () => void controller.applyImport(),
    openImporter: () => void controller.openImporter(),
    toggleHelp: open => {
      controller.toggleHelp(open);
      if (!controller.state().help) helpOpener?.focus();
    },
  };
  let helpOpener: HTMLElement | undefined;

  /** Where focus goes back to when the import sheet closes. */
  let opener: HTMLElement | undefined;

  const importFile = (file: File) => {
    const active = doc.activeElement as HTMLElement | null;
    if (!current?.importing && active && root.contains(active)) opener = active;
    void controller.importFile({
      name: file.name,
      size: file.size,
      text: async () =>
        decodeStatement(new Uint8Array(await file.arrayBuffer())),
    });
  };

  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (file) importFile(file);
  });

  // Dropping a file anywhere starts an import; the file button stays the
  // accessible path.
  let dragging = 0;
  const hasFiles = (event: DragEvent) =>
    [...(event.dataTransfer?.types ?? [])].includes('Files');
  doc.addEventListener('dragenter', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragging++;
    root.classList.add('m-dropping');
  });
  doc.addEventListener('dragover', event => {
    if (hasFiles(event)) event.preventDefault();
  });
  doc.addEventListener('dragleave', () => {
    dragging = Math.max(0, dragging - 1);
    if (!dragging) root.classList.remove('m-dropping');
  });
  doc.addEventListener('drop', event => {
    if (!hasFiles(event)) return;
    event.preventDefault();
    dragging = 0;
    root.classList.remove('m-dropping');
    const file = event.dataTransfer?.files?.[0];
    if (file) importFile(file);
  });

  /** The modal (detail drawer or sheet, import sheet) that holds focus. */
  const modal = () =>
    root.querySelector<HTMLElement>('[role="dialog"][aria-modal="true"]');

  const draw = (state: State) => {
    const opened = state.selected && state.selected !== current?.selected;
    const sheet = state.importing;
    const before = current?.importing;
    const sheetOpened = sheet && !before;
    const sheetFailed =
      sheet &&
      (sheet.step === 'error' || sheet.step === 'blocked') &&
      before?.step !== sheet.step;
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
    // A blocking import error moves focus to the banner's title.
    if (sheetFailed)
      root.querySelector<HTMLElement>('.m-dialog .pl-banner h3')?.focus();
    else if (sheetOpened)
      root.querySelector<HTMLElement>('[data-key="import-close"]')?.focus();
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

  const controller = createController(store, draw, {
    today: options.today,
    importer: options.importer,
    tick: options.tick,
  });

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

    if (event.key === 'Escape' && current?.help) {
      event.preventDefault();
      actions.toggleHelp(false);

      return;
    }

    if (event.key === 'Escape' && current?.importing) {
      event.preventDefault();
      actions.closeImport();

      return;
    }

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
    } else if (event.key === '?' && !open) {
      event.preventDefault();
      if (!current?.help) helpOpener = doc.activeElement as HTMLElement;
      actions.toggleHelp();
      if (current?.help)
        root.querySelector<HTMLElement>('[data-key="help-close"]')?.focus();
    } else if (event.key === 'i' && !open) {
      event.preventDefault();
      actions.chooseFile();
    }
  });

  draw(controller.state());
  await controller.load();
}
