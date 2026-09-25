// @wc-ignore-file
/**
 * A few lines of DOM building for the plugin shell, so render functions stay
 * pure (state in, element out) and testable in jsdom without the host.
 */

export type Child = Node | string | number | false | null | undefined;
export type Attrs = Record<
  string,
  string | number | boolean | null | undefined | EventListener
>;

/** Creates `tag` in `doc` with attributes, `on*` listeners and children. */
export function h<K extends keyof HTMLElementTagNameMap>(
  doc: Document,
  tag: K,
  attrs: Attrs = {},
  ...children: (Child | Child[])[]
): HTMLElementTagNameMap[K] {
  const el = doc.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;

    if (typeof value === 'function') {
      el.addEventListener(key.slice(2).toLowerCase(), value);
      continue;
    }

    if (key === 'class') el.className = String(value);
    else el.setAttribute(key, value === true ? '' : String(value));
  }

  append(el, children);

  return el;
}

export function append(parent: Node, children: (Child | Child[])[]): void {
  for (const child of children.flat()) {
    if (child === undefined || child === null || child === false) continue;
    parent.appendChild(
      typeof child === 'string' || typeof child === 'number'
        ? parent.ownerDocument!.createTextNode(String(child))
        : child,
    );
  }
}

const SVG = 'http://www.w3.org/2000/svg';

/** An icon from the sprite (`icons.ts`): `<svg class="ic"><use href="#i-name">`. */
export function icon(doc: Document, name: string, extra = ''): SVGSVGElement {
  const svg = doc.createElementNS(SVG, 'svg');
  svg.setAttribute('class', extra ? `ic ${extra}` : 'ic');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('viewBox', '0 0 16 16');
  const use = doc.createElementNS(SVG, 'use');
  use.setAttribute('href', `#i-${name}`);
  svg.appendChild(use);

  return svg;
}

/** A selector for the element with `data-key` = `key` (focus restoring). */
export const byKey = (key: string) =>
  `[data-key="${key.replace(/["\\]/g, '\\$&')}"]`;
