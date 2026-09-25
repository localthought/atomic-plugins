// @wc-ignore-file
/**
 * The issue tracker's own styles, on top of the shared kit (ui/css.ts):
 * toolbar, board, cards, list, detail panel, conflict review, onboarding.
 * Values follow design/mockups.html. Host variables only, via `--pl-*`.
 */
import css from './styles.css?raw';

/**
 * Kept in a stylesheet file so the build can minify it (esbuild's CSS
 * minifier, in build.mjs) before it is embedded in the bundle.
 */
export const APP_CSS: string = css;
