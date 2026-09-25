// @wc-ignore-file
/**
 * Plain-DOM helpers for the shared #89 plugin kit (`ui/`). Nothing here knows
 * about issues; it is kept apart so it can move to a shared package later
 * (a maintainer decision; see DESIGN.md "Shared visual language").
 *
 * Text is always set with `textContent`. The only `innerHTML` is the fixed
 * icon markup below, which never contains data.
 */

export type Child = Node | string | number | false | null | undefined | Child[];
type Handler = (event: Event) => void;

export type Attrs = Record<
  string,
  string | number | boolean | undefined | null | Handler
>;

/** `h('button', { class: 'btn', onclick }, 'Label')`. */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs | null = null,
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs ?? {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function')
      node.addEventListener(key.slice(2), value as Handler);
    else if (key === 'class') node.className = String(value);
    else if (key in node && typeof value !== 'string')
      (node as unknown as Record<string, unknown>)[key] = value;
    else node.setAttribute(key, value === true ? '' : String(value));
  }

  append(node, children);

  return node;
}

export function append(node: Node, children: Child[]): void {
  for (const child of children) {
    if (child === undefined || child === null || child === false) continue;
    if (Array.isArray(child)) append(node, child);
    else
      node.appendChild(
        typeof child === 'string' || typeof child === 'number'
          ? document.createTextNode(String(child))
          : child,
      );
  }
}

const stroke = (d: string, w = 1.6) =>
  `<path d="${d}" fill="none" stroke="currentColor" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"/>`;

/** Icon markup from mockups.html; `currentColor` everywhere. */
const ICONS = {
  mark: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.6"/><circle cx="8" cy="8" r="1.8" fill="currentColor"/>',
  synced:
    '<circle cx="8" cy="8" r="6.5" fill="currentColor"/><path d="M5 8.3 7 10.2 11 6" fill="none" stroke="var(--pl-surface)" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  syncing:
    '<g class="pl-spin"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2"/><path d="M8 2a6 6 0 0 1 6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></g>',
  paused:
    '<rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor"/>',
  reauth: stroke(
    'M5.5 1.5v3.5M10.5 1.5v3.5M3.5 5h9v2.5a4.5 4.5 0 0 1-9 0zM8 12v3',
    1.8,
  ),
  error:
    '<path d="M8 1.5 15 14H1z" fill="currentColor"/><path d="M8 6v3.5" stroke="var(--pl-surface)" stroke-width="1.8" stroke-linecap="round"/><circle cx="8" cy="11.8" r="1" fill="var(--pl-surface)"/>',
  idle: '<circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2 2"/>',
  plus: stroke('M8 3v10M3 8h10'),
  more: '<circle cx="3.5" cy="8" r="1.3" fill="currentColor"/><circle cx="8" cy="8" r="1.3" fill="currentColor"/><circle cx="12.5" cy="8" r="1.3" fill="currentColor"/>',
  board:
    '<rect x="2" y="2.5" width="3.3" height="11" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="6.35" y="2.5" width="3.3" height="7" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/><rect x="10.7" y="2.5" width="3.3" height="9" rx="1" fill="none" stroke="currentColor" stroke-width="1.3"/>',
  list: '<path d="M5.5 4h8M5.5 8h8M5.5 12h8" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="2.7" cy="4" r="1" fill="currentColor"/><circle cx="2.7" cy="8" r="1" fill="currentColor"/><circle cx="2.7" cy="12" r="1" fill="currentColor"/>',
  search:
    '<circle cx="7" cy="7" r="4.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="m10.5 10.5 3 3" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  chevron: stroke('m4 6 4 4 4-4', 1.8),
  comment: stroke('M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z', 1.3),
  close: stroke('m4 4 8 8M12 4l-8 8'),
  back: stroke('M10 3 5 8l5 5'),
  external: stroke('M6 3H3v10h10v-3M9 3h4v4M13 3 7 9', 1.5),
  info: '<circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M6.3 6.3a1.8 1.8 0 1 1 2.4 1.7c-.5.2-.7.6-.7 1.1v.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><circle cx="8" cy="11.4" r=".8" fill="currentColor"/>',
  warn: '<path d="M8 2 14.5 13.5h-13z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><path d="M8 6.5v3.2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><circle cx="8" cy="11.6" r=".9" fill="currentColor"/>',
  plug: stroke(
    'M5.5 2v3.5M10.5 2v3.5M3.5 5.5h9V8a4.5 4.5 0 0 1-9 0zM8 12.5V15',
    1.5,
  ),
  ghost: stroke(
    'M3.5 14V7a4.5 4.5 0 0 1 9 0v7l-1.5-1.2L9.5 14 8 12.8 6.5 14 5 12.8z',
    1.4,
  ),
  lock: '<rect x="3.5" y="7" width="9" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  // 24px empty-state icons.
  inbox: stroke(
    'M3 13.5 5.5 5h13l2.5 8.5V19H3z M3 13.5h5l1 2.5h6l1-2.5h5',
    1.4,
  ),
  filter: stroke('M4 5h16l-6 7.5V19l-4-2v-4.5z', 1.4),
  server:
    '<rect x="4" y="4" width="16" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><rect x="4" y="13.5" width="16" height="6.5" rx="1.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M7.5 7.25h.01M7.5 16.75h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>',
  // Status glyphs (14px box): ring, half ring, filled check.
  todo: '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/>',
  doing:
    '<circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M7 3.2 A3.8 3.8 0 0 1 7 10.8 Z" fill="currentColor"/>',
  done: '<circle cx="7" cy="7" r="6.25" fill="currentColor"/><path d="M4.3 7.2 6.2 9 9.8 5.2" fill="none" stroke="var(--pl-surface)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
} as const;

export type IconName = keyof typeof ICONS;

const BOX: Partial<Record<IconName, number>> = {
  inbox: 24,
  filter: 24,
  server: 24,
  todo: 14,
  doing: 14,
  done: 14,
};

/** An inline SVG icon, hidden from assistive technology. */
export function icon(name: IconName, size = 16, cls?: string): SVGSVGElement {
  const box = BOX[name] ?? 16;
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('viewBox', `0 0 ${box} ${box}`);
  svg.setAttribute('aria-hidden', 'true');
  if (cls) svg.setAttribute('class', cls);
  svg.innerHTML = ICONS[name];

  return svg;
}
