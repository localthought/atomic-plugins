// @wc-ignore-file
/**
 * A tiny DOM builder for plain-DOM plugin views (no framework: a drive app
 * is one module). Part of the shared plugin chrome in `ui/`.
 */

export type Child = Node | string | false | null | undefined;

export type Attrs = Record<
  string,
  string | number | boolean | undefined | null | EventListener
>;

/** `h('button', { class: 'btn', onclick: … }, 'Label')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = doc.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2), value as EventListener);
    else if (key === 'style' && typeof value === 'string')
      node.setAttribute('style', value);
    else if (value === true) node.setAttribute(key, '');
    else node.setAttribute(key, String(value));
  }

  // A plain <button> submits in a form, which the sandboxed frame never
  // dispatches (no allow-forms); every button here is type=button.
  if (tag === 'button' && !('type' in attrs))
    node.setAttribute('type', 'button');
  append(node, children);

  return node;
}

export function append(node: Node, children: Child[]): void {
  for (const child of children)
    if (child !== undefined && child !== null && child !== false)
      node.appendChild(
        typeof child === 'string'
          ? node.ownerDocument!.createTextNode(child)
          : child,
      );
}

/** Builds an SVG element from trusted, static markup written in this module. */
export function svg(doc: Document, markup: string): SVGElement {
  const template = doc.createElement('template');
  template.innerHTML = markup.trim();
  const node = template.content.firstElementChild as SVGElement;
  node.setAttribute('aria-hidden', 'true');
  node.setAttribute('focusable', 'false');

  return node;
}

export const ICONS = {
  calendar:
    '<svg viewBox="0 0 20 20" width="20" height="20"><rect x="2.5" y="4" width="15" height="13.5" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M2.5 8h15M6.5 2.5v3M13.5 2.5v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><rect x="6" y="10.5" width="3" height="3" rx=".6" fill="currentColor"/></svg>',
  more: '<svg viewBox="0 0 16 16" width="16" height="16"><circle cx="3.5" cy="8" r="1.4" fill="currentColor"/><circle cx="8" cy="8" r="1.4" fill="currentColor"/><circle cx="12.5" cy="8" r="1.4" fill="currentColor"/></svg>',
  close:
    '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M3.5 3.5l9 9M12.5 3.5l-9 9" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
  prev: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M10 3.5L5.5 8l4.5 4.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  next: '<svg viewBox="0 0 16 16" width="14" height="14"><path d="M6 3.5L10.5 8 6 12.5" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  google:
    '<svg viewBox="0 0 16 16" width="14" height="14"><rect x="1" y="1" width="14" height="14" rx="3" fill="#fff" stroke="#dadce0"/><rect x="1" y="1" width="14" height="4" rx="2" fill="#4285f4"/><text x="8" y="13" text-anchor="middle" font-size="7" font-weight="700" fill="#4285f4" font-family="system-ui">31</text></svg>',
} as const;

/** The key of the element that has focus, so a re-render can put it back. */
export function focusKey(doc: Document): string | undefined {
  return (doc.activeElement as HTMLElement | null)?.dataset?.key;
}

export function restoreFocus(root: HTMLElement, key: string | undefined): void {
  if (!key) return;
  const node = root.querySelector<HTMLElement>(
    `[data-key="${CSS.escape(key)}"]`,
  );
  if (node && node !== root.ownerDocument.activeElement)
    node.focus({ preventScroll: true });
}
