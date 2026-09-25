// @wc-ignore-file
/**
 * Focus handling for views that re-render by replacing their DOM: elements
 * that should keep focus, caret and scroll across a render carry a stable
 * `data-key`.
 */

const FOCUSABLE =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

interface Snapshot {
  key?: string;
  start?: number | null;
  end?: number | null;
  scroll: Map<string, { top: number; left: number }>;
}

function snapshot(root: HTMLElement): Snapshot {
  const active = root.ownerDocument.activeElement as HTMLElement | null;
  const key = active && root.contains(active) ? active.dataset.key : undefined;
  const scroll = new Map<string, { top: number; left: number }>();

  for (const node of root.querySelectorAll<HTMLElement>('[data-scroll-key]'))
    scroll.set(node.dataset.scrollKey!, {
      top: node.scrollTop,
      left: node.scrollLeft,
    });

  const field = active as HTMLInputElement | null;
  const hasSelection =
    field && (field.tagName === 'INPUT' || field.tagName === 'TEXTAREA');

  return {
    key,
    start: hasSelection ? safe(() => field.selectionStart) : undefined,
    end: hasSelection ? safe(() => field.selectionEnd) : undefined,
    scroll,
  };
}

function safe<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    // `type="search"` and others refuse selection APIs in some engines.
    return undefined;
  }
}

function restore(root: HTMLElement, before: Snapshot): void {
  for (const [key, pos] of before.scroll) {
    const node = root.querySelector<HTMLElement>(
      `[data-scroll-key="${CSS.escape(key)}"]`,
    );

    if (node) {
      node.scrollTop = pos.top;
      node.scrollLeft = pos.left;
    }
  }

  if (!before.key) return;
  const target = root.querySelector<HTMLElement>(
    `[data-key="${CSS.escape(before.key)}"]`,
  );
  if (!target || target === root.ownerDocument.activeElement) return;
  target.focus({ preventScroll: true });

  if (
    (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') &&
    typeof before.start === 'number'
  )
    safe(() =>
      (target as HTMLInputElement).setSelectionRange(
        before.start!,
        before.end ?? before.start!,
      ),
    );
}

/** Replaces `root`'s children, keeping focus, caret and keyed scroll offsets. */
export function replaceKeepingFocus(root: HTMLElement, nodes: Node[]): void {
  const before = snapshot(root);
  root.replaceChildren(...nodes);
  restore(root, before);
}

/** Keeps Tab inside `container` (a modal dialog). */
export function trapTab(container: HTMLElement, event: KeyboardEvent): void {
  if (event.key !== 'Tab') return;
  const items = [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
    node => !node.closest('[hidden]'),
  );
  if (!items.length) return;
  const first = items[0];
  const last = items[items.length - 1];
  const active = container.ownerDocument.activeElement;

  if (event.shiftKey && (active === first || !container.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

/** True when a key press is typing into a field, so shortcuts stay off. */
export function isTyping(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;

  return (
    target.isContentEditable ||
    ['INPUT', 'TEXTAREA', 'SELECT'].includes(target.tagName)
  );
}
