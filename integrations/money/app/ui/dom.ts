// @wc-ignore-file
/**
 * A tiny element builder for plain-DOM plugin views. Part of the #89 plugin
 * shell kept in `app/ui/`: nothing in here knows about money, so the folder
 * can move to a shared kit once sharing code across plugin folders is
 * decided (AGENTS.md, "Boundaries").
 */

type Handler = (event: Event) => void;

export type Attrs = Record<
  string,
  string | number | boolean | undefined | null | Handler
>;
export type Child = Node | string | false | null | undefined | Child[];

function append(parent: Node, child: Child): void {
  if (child === false || child === null || child === undefined) return;

  if (Array.isArray(child)) {
    for (const c of child) append(parent, c);

    return;
  }

  parent.appendChild(
    typeof child === 'string' ? document.createTextNode(child) : child,
  );
}

/**
 * `h('button', { class: 'btn', onclick: fn, 'aria-label': 'Close' }, 'x')`.
 * `on*` keys become listeners; `true` sets an empty attribute; `false`,
 * `null` and `undefined` leave it out.
 */
export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }

    if (key === 'value' && 'value' in node) {
      (node as HTMLInputElement).value = String(value);
      continue;
    }

    node.setAttribute(key, value === true ? '' : String(value));
  }

  append(node, children);

  return node;
}

const SVG = 'http://www.w3.org/2000/svg';

/** An inline 16×16 stroke icon; `paths` are `d` attributes. Decorative. */
export function icon(paths: string[], className = 'pl-ico'): SVGSVGElement {
  const svg = document.createElementNS(SVG, 'svg');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);

  for (const d of paths) {
    const path = document.createElementNS(SVG, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '1.6');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
    svg.appendChild(path);
  }

  return svg;
}

export const icons = {
  upload: () =>
    icon([
      'M8 11V2.5M4.5 6 8 2.5 11.5 6M2.5 10.5v2a1 1 0 0 0 1 1h9a1 1 0 0 0 1-1v-2',
    ]),
  search: () =>
    icon(['M11.5 7a4.5 4.5 0 1 1-9 0 4.5 4.5 0 0 1 9 0Z', 'm10.5 10.5 3 3']),
  close: () => icon(['m4 4 8 8M12 4l-8 8']),
  back: () => icon(['M10 3 5 8l5 5']),
};
