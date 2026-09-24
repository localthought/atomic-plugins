// @wc-ignore-file
/**
 * Injects the plugin stylesheet once and keeps `data-pl-theme` on the
 * document in step with the host's theme. Part of the shared chrome in `ui/`.
 *
 * The host sends no "dark" flag, only its `--t-*` colours (into
 * `<style id="__atomic_theme">`, re-sent on every theme switch). The page
 * is dark when `--pl-bg`, which reads `--t-color-bg-body`, is dark.
 */

/** Relative luminance of an `rgb()`/`rgba()` or `#rrggbb` colour, 0–1. */
export function luminance(color: string): number | undefined {
  let rgb: number[] | undefined;
  const hex = /^#([0-9a-f]{6})$/i.exec(color.trim());

  if (hex) rgb = [0, 2, 4].map(i => parseInt(hex[1].slice(i, i + 2), 16));
  else {
    const m = /rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i.exec(color);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }

  if (!rgb) return undefined;
  const [r, g, b] = rgb.map(v => {
    const c = v / 255;

    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

export function contrast(a: string, b: string): number {
  const la = luminance(a) ?? 0;
  const lb = luminance(b) ?? 0;

  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Mixes `color` into `over` at `percent`, like CSS `color-mix(in srgb, …)`. */
export function mix(color: string, percent: number, over: string): string {
  const parse = (c: string) =>
    [0, 2, 4].map(i => parseInt(c.slice(1 + i, 3 + i), 16));
  const a = parse(color);
  const b = parse(over);
  const out = a.map((v, i) =>
    Math.round(v * (percent / 100) + b[i] * (1 - percent / 100)),
  );

  return `#${out.map(v => v.toString(16).padStart(2, '0')).join('')}`;
}

export function installTheme(root: HTMLElement, css: string): () => void {
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  let style = doc.getElementById('pl-styles') as HTMLStyleElement | null;

  if (!style) {
    style = doc.createElement('style');
    style.id = 'pl-styles';
    style.textContent = css;
    doc.head.appendChild(style);
  }

  const sync = () => {
    if (!win) return;
    // Read the host variable itself: `--pl-bg` would follow our own flag.
    const host = win
      .getComputedStyle(doc.documentElement)
      .getPropertyValue('--t-color-bg-body');
    const l = host ? luminance(host.trim()) : undefined;
    if (l === undefined) doc.documentElement.removeAttribute('data-pl-theme');
    else
      doc.documentElement.setAttribute(
        'data-pl-theme',
        l < 0.3 ? 'dark' : 'light',
      );
  };

  sync();
  const hostStyle = doc.getElementById('__atomic_theme');
  const observer =
    hostStyle && typeof MutationObserver !== 'undefined'
      ? new MutationObserver(sync)
      : undefined;
  observer?.observe(hostStyle!, {
    childList: true,
    characterData: true,
    subtree: true,
  });

  return () => observer?.disconnect();
}
