// @wc-ignore-file
/**
 * Host theme and frame width, as attributes on the app root.
 *
 * - `data-pl-scheme="light|dark"`: the host's `colorScheme`
 *   (`store.getTheme()` / `onThemeChange()`, pin 007869464), or on older
 *   hosts the luminance of its `--t-color-bg`. The user's Atomic setting,
 *   not the OS (`prefers-color-scheme` is never read). Only the `--pl-pos`
 *   fallback needs it.
 * - `data-size="s|m|l|xl"` from the root's own width, the only breakpoint
 *   input a frame has: < 600, 600–719, 720–999, ≥ 1000.
 */
import { KIT_CSS } from './css.js';

export type Size = 's' | 'm' | 'l' | 'xl';

export function sizeFor(width: number): Size {
  if (width < 600) return 's';
  if (width < 720) return 'm';
  if (width < 1000) return 'l';

  return 'xl';
}

/** Relative luminance of `#rgb`, `#rrggbb` or `rgb(…)`; undefined if unknown. */
export function luminance(color: string): number | undefined {
  const c = color.trim();
  let rgb: number[] | undefined;
  const hex = c.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i)?.[1];

  if (hex) {
    const full =
      hex.length === 3
        ? hex
            .split('')
            .map(x => x + x)
            .join('')
        : hex;
    rgb = [0, 2, 4].map(i => parseInt(full.slice(i, i + 2), 16));
  } else {
    const m = c.match(/^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/i);
    if (m) rgb = [m[1], m[2], m[3]].map(Number);
  }

  if (!rgb) return undefined;
  const [r, g, b] = rgb.map(v => {
    const s = v / 255;

    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });

  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Injects the kit's and the app's CSS once, as one `<style>` element. */
export function injectStyles(root: HTMLElement, css: string): void {
  const doc = root.ownerDocument;
  const id = 'pl-app-styles';
  if (doc.getElementById(id)) return;
  const style = doc.createElement('style');
  style.id = id;
  style.textContent = KIT_CSS + css;
  doc.head.append(style);
}

/** What a host tells about its light/dark setting (the store's theme calls). */
export interface ThemeSource {
  getTheme?(): { colorScheme?: 'light' | 'dark' };
  onThemeChange?(
    handler: (theme: { colorScheme?: 'light' | 'dark' }) => void,
  ): () => void;
}

/**
 * Keeps `data-pl-scheme` and `data-size` current. `onSize` runs when the
 * size class changes. Returns a stop function.
 */
export function watchFrame(
  root: HTMLElement,
  onSize: (size: Size, width: number) => void,
  theme: ThemeSource = {},
): () => void {
  const win = root.ownerDocument.defaultView;

  const scheme = () => {
    const told = theme.getTheme?.().colorScheme;

    if (told) {
      root.dataset.plScheme = told;

      return;
    }

    const bg = win
      ?.getComputedStyle(root.ownerDocument.documentElement)
      .getPropertyValue('--t-color-bg');
    const l = bg ? luminance(bg) : undefined;
    root.dataset.plScheme = l !== undefined && l < 0.4 ? 'dark' : 'light';
  };

  let last: Size | undefined;

  const measure = () => {
    const width = root.getBoundingClientRect().width || win?.innerWidth || 0;
    const size = sizeFor(width);
    root.dataset.size = size;

    if (size !== last) {
      last = size;
      onSize(size, width);
    }
  };

  scheme();
  measure();

  // The host re-sends `__atomic_style` when the user switches theme.
  const onMessage = (event: MessageEvent) => {
    if ((event.data as { type?: string })?.type === '__atomic_style')
      setTimeout(scheme, 0);
  };

  win?.addEventListener('message', onMessage);
  const unsubscribe = theme.onThemeChange?.(({ colorScheme }) => {
    if (colorScheme) root.dataset.plScheme = colorScheme;
    else scheme();
  });
  const RO = (
    win as (Window & { ResizeObserver?: typeof ResizeObserver }) | null
  )?.ResizeObserver;
  const observer = RO ? new RO(measure) : undefined;
  observer?.observe(root);
  if (!observer) win?.addEventListener('resize', measure);

  return () => {
    win?.removeEventListener('message', onMessage);
    unsubscribe?.();
    observer?.disconnect();
    win?.removeEventListener('resize', measure);
  };
}
