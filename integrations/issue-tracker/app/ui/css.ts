// @wc-ignore-file
/**
 * ---- PLUGIN CSS (shared #89 kit) ----
 *
 * The `--pl-*` aliases of the host's `--t-*` theme variables (atomic-server
 * `useCreateThemeVars.ts`, sent to the frame as `__atomic_style`) and the
 * chrome every #89 app shares: header, sync pill, connection bar, banner,
 * empty state, buttons, segmented control, search field, label chip and
 * status glyph. Values follow `design/mockups.html`.
 *
 * Rules: every colour comes from a host variable. `--pl-pos` is the host's
 * `--t-color-success`, with a literal fallback only for hosts from before
 * it existed. Light or dark is the host's choice, never
 * `prefers-color-scheme`: `ui/theme.ts` sets `data-pl-scheme` from the
 * host's `colorScheme` (or, on older hosts, its background).
 *
 * Kept inside this plugin (per-plugin containment) until the maintainer
 * decides on a shared package; nothing here is issue-specific.
 */
import css from './kit.css?raw';

/**
 * Kept in a stylesheet file so the build can minify it (esbuild's CSS
 * minifier, in build.mjs) before it is embedded in the bundle.
 */
export const KIT_CSS: string = css;
