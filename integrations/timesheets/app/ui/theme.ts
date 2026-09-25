// @wc-ignore-file
/**
 * PLUGIN CSS (#89 §4): the `--pl-*` tokens, each mapped from the theme
 * variable the host posts into plugin frames (`--t-*`, via
 * `__atomic_style`), and the shared components' styles. Values are copied
 * from `design/mockups.html`. Shared-kit candidate: nothing here is
 * Clockify-specific except the source chip's colour.
 *
 * Dark mode is the host sending dark `--t-*` values; the fallbacks are the
 * host's light defaults, for a host that sends none. One `<style>` element
 * in the view root: the module ships no stylesheet, and nothing is loaded
 * from elsewhere (no `@import`, no `url()`).
 *
 * The rules are in `theme.css`, imported as text (`?raw`): `build.mjs`
 * minifies it with esbuild's CSS minifier before embedding it; Vitest reads
 * it as written.
 */
import css from './theme.css?raw';

export { css };

/** Appends the one `<style>` element to the view root. */
export function installStyles(root: HTMLElement): HTMLStyleElement {
  const style = root.ownerDocument.createElement('style');
  style.textContent = css;
  root.append(style);

  return style;
}
