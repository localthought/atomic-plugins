// @wc-ignore-file
/**
 * PLUGIN CSS — the shared plugin chrome of the #89 design family (Calendar,
 * Money, Timesheets, Notion, Issue tracker designs): `--pl-*` tokens mapped
 * from the host's `--t-*` variables, and the header row, connection bar,
 * status pill, buttons, segmented control, banners, empty-state card, menu
 * and sheet. Nothing in here is calendar-specific; the calendar's own rules
 * are in `../calendarStyles.ts`.
 *
 * Kept inside the Calendar plugin on purpose (per-plugin containment).
 * Extracting it into a shared kit is a separate decision for the
 * maintainer; this file and the rest of `ui/` are written so they can move
 * as they are.
 *
 * The host re-sends its `--t-*` variables into `<style id="__atomic_theme">`
 * when the person switches theme (atomic-server `plugin_ui.rs`); since every
 * rule reads them through `var()`, the view restyles without a reload.
 * `theme.ts` sets `data-pl-theme` from the host's background so the few
 * values the host has no variable for (tint strength, success green, text on
 * the accent colour) follow too. The `prefers-color-scheme` fallbacks only
 * matter outside the host (tests, a standalone preview).
 */

const LIGHT = `
  --pl-bg: var(--t-color-bg-body, #ffffff);
  --pl-surface: var(--t-color-bg-1, #f5f6f8);
  --pl-border: var(--t-color-bg-2, #e3e6ea);
  --pl-text: var(--t-color-text, #1b1e22);
  --pl-muted: var(--t-color-text-light, #626a73);
  --pl-accent: var(--t-color-main, #1a6ef5);
  --pl-neg: var(--t-color-alert, #c62828);
  --pl-warn: var(--t-color-warning, #9a6200);
  --pl-pos: #1f7a45;
  --pl-on-accent: #ffffff;
  --pl-tint: 14%;
  --pl-shadow: rgb(0 0 0 / 0.12);
  color-scheme: light;
`;

const DARK = `
  --pl-bg: var(--t-color-bg-body, #15171a);
  --pl-surface: var(--t-color-bg-1, #1d2024);
  --pl-border: var(--t-color-bg-2, #2c3036);
  --pl-text: var(--t-color-text, #e8eaed);
  --pl-muted: var(--t-color-text-light, #9aa2ab);
  --pl-accent: var(--t-color-main, #6ea3ff);
  --pl-neg: var(--t-color-alert, #ff7b72);
  --pl-warn: var(--t-color-warning, #e3b341);
  --pl-pos: #56c98a;
  --pl-on-accent: #0c1320;
  --pl-tint: 22%;
  --pl-shadow: rgb(0 0 0 / 0.4);
  color-scheme: dark;
`;

export const PLUGIN_CSS = `
:root {
  ${LIGHT}
  --pl-radius: var(--t-radius, 8px);
  --pl-font: var(--t-font-family, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif);
}
@media (prefers-color-scheme: dark) {
  :root:not([data-pl-theme="light"]) { ${DARK} }
}
:root[data-pl-theme="dark"] { ${DARK} }

html, body { height: 100%; margin: 0; background: var(--pl-bg); }
.pl-app {
  font-family: var(--pl-font); font-size: 14px; line-height: 1.45;
  background: var(--pl-bg); color: var(--pl-text);
  height: 100vh; display: flex; flex-direction: column; min-width: 0;
  overflow: hidden; position: relative;
}
.pl-app *, .pl-app *::before, .pl-app *::after { box-sizing: border-box; }
.pl-app button, .pl-app input, .pl-app textarea, .pl-app select { font: inherit; color: inherit; }
.pl-app :focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
.pl-app a { color: var(--pl-accent); }
.sr-only { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
.sr-only-focusable:focus { position: static; width: auto; height: auto; clip: auto; margin: 4px 14px; }
.muted { color: var(--pl-muted); }
.pl-scroll { flex: 1; min-height: 0; overflow: auto; }

/* header row: [icon + title | chips | status pill | primary action] */
.hd { display: flex; align-items: center; gap: 12px; padding: 10px 14px; flex-wrap: wrap; }
.hd-id { display: flex; align-items: center; gap: 8px; }
.hd-id h1 { margin: 0; font-size: 16px; font-weight: 650; letter-spacing: -0.005em; }
.mark { display: grid; place-items: center; width: 30px; height: 30px; border-radius: 8px;
  background: color-mix(in srgb, var(--pl-accent) 12%, transparent); color: var(--pl-accent); }
.hd-chips { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 0; }
.hd-act { margin-left: auto; display: flex; gap: 8px; align-items: center; }
.chip { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 10px 0 8px;
  border: 1px solid var(--pl-border); border-radius: 999px; font-size: 12.5px; background: var(--pl-bg);
  cursor: pointer; white-space: nowrap; }
.chip[aria-pressed="false"] { color: var(--pl-muted); }
.chip[aria-pressed="false"] .sw { background: transparent; box-shadow: inset 0 0 0 1.5px var(--c); }
.sw { display: inline-block; width: 10px; height: 10px; border-radius: 3px; background: var(--c); flex: none; }
.sw-stack { display: inline-flex; }
.sw-stack i { width: 10px; height: 10px; border-radius: 50%; background: var(--c); box-shadow: 0 0 0 2px var(--pl-bg); }
.sw-stack i + i { margin-left: -3px; }

.pill { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: 999px;
  font-size: 12.5px; color: var(--pl-muted); background: var(--pl-surface); border: 1px solid transparent;
  white-space: nowrap; cursor: default; }
button.pill { cursor: pointer; }
.pill-accent { color: var(--pl-accent); background: color-mix(in srgb, var(--pl-accent) 10%, var(--pl-bg)); }
.pill-warn { color: var(--pl-warn); background: color-mix(in srgb, var(--pl-warn) 12%, var(--pl-bg));
  border-color: color-mix(in srgb, var(--pl-warn) 30%, transparent); }
.pill-warn::before { content: "!"; font-weight: 800; }
.pill-neg { color: var(--pl-neg); background: color-mix(in srgb, var(--pl-neg) 10%, var(--pl-bg)); }
.spin { width: 10px; height: 10px; border-radius: 50%; border: 2px solid currentColor; border-right-color: transparent;
  animation: pl-spin 1s linear infinite; flex: none; }
@keyframes pl-spin { to { transform: rotate(360deg); } }

.btn { display: inline-flex; align-items: center; justify-content: center; gap: 6px; height: 32px; padding: 0 14px;
  border-radius: var(--pl-radius); border: 1px solid var(--pl-border); background: var(--pl-bg); cursor: pointer;
  font-weight: 550; white-space: nowrap; text-decoration: none; color: var(--pl-text); }
.btn:hover { background: var(--pl-surface); }
.btn-primary { background: var(--pl-accent); border-color: var(--pl-accent); color: var(--pl-on-accent); }
.btn-primary:hover { background: color-mix(in srgb, var(--pl-accent) 88%, #000); }
.btn[disabled] { opacity: 0.45; cursor: not-allowed; }
.btn-ghost { border-color: transparent; background: transparent; color: var(--pl-accent); }
.btn-sm { height: 28px; padding: 0 10px; font-size: 13px; }
.btn-lg { height: 40px; padding: 0 18px; font-size: 14.5px; }
.btn-neg { color: var(--pl-neg); }
.link { background: none; border: 0; padding: 0; color: var(--pl-accent); text-decoration: underline; cursor: pointer; font-weight: 550; }
.icon-btn { display: inline-grid; place-items: center; width: 30px; height: 30px; border-radius: 6px; border: 0;
  background: transparent; color: var(--pl-muted); cursor: pointer; font-size: 18px; line-height: 1; flex: none; }
.icon-btn:hover { background: var(--pl-surface); color: var(--pl-text); }

/* connection bar */
.cbar { position: relative; display: flex; align-items: center; gap: 8px; padding: 6px 14px;
  border-block: 1px solid var(--pl-border); background: var(--pl-surface); font-size: 12.5px; color: var(--pl-muted);
  min-width: 0; }
.cbar b { color: var(--pl-text); font-weight: 550; }
.cbar-acc { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.cbar-menu { margin-left: auto; position: relative; }
.cbar .icon-btn { width: 26px; height: 26px; }
.cbar.is-busy::after { content: ""; position: absolute; left: 0; bottom: -1px; height: 2px; width: 35%;
  background: var(--pl-accent); animation: pl-slide 1.4s ease-in-out infinite; }
@keyframes pl-slide { 0% { left: -35%; } 100% { left: 100%; } }

.menu { position: absolute; right: 0; top: calc(100% + 4px); z-index: 20; min-width: 200px; padding: 4px;
  background: var(--pl-bg); border: 1px solid var(--pl-border); border-radius: 8px;
  box-shadow: 0 8px 24px var(--pl-shadow); display: grid; }
.menu button { text-align: left; border: 0; background: transparent; padding: 8px 10px; border-radius: 6px;
  cursor: pointer; font-size: 13px; color: var(--pl-text); }
.menu button:hover, .menu button:focus-visible { background: var(--pl-surface); }
.menu button[disabled] { color: var(--pl-muted); cursor: not-allowed; }
.menu small { display: block; color: var(--pl-muted); font-size: 11.5px; }

/* segmented control */
.segs { display: inline-flex; padding: 2px; background: var(--pl-surface); border-radius: 8px; border: 1px solid var(--pl-border); }
.seg { border: 0; background: transparent; height: 26px; padding: 0 10px; border-radius: 6px; font-size: 12.5px;
  color: var(--pl-muted); cursor: pointer; }
.seg[aria-pressed="true"] { background: var(--pl-bg); color: var(--pl-text); font-weight: 600; box-shadow: 0 1px 2px rgb(0 0 0 / 0.08); }

/* banners: cause, one action, Details */
.banners { display: grid; }
.banner { display: flex; gap: 10px; align-items: flex-start; margin: 10px 12px 0; padding: 10px 12px; border-radius: 8px;
  font-size: 13px; border: 1px solid; }
.banner .bi { width: 18px; height: 18px; border-radius: 50%; display: grid; place-items: center; font-weight: 800;
  font-size: 11px; flex: none; margin-top: 1px; color: var(--pl-bg); }
.banner .bt { flex: 1; display: grid; gap: 2px; min-width: 0; }
.banner .bt b { font-weight: 650; }
.banner .bt span { color: var(--pl-muted); }
.banner details { font-size: 12px; color: var(--pl-muted); }
.banner summary { cursor: pointer; }
.banner code { font-size: 11.5px; overflow-wrap: anywhere; }
.banner .btn { flex: none; }
.b-neg { background: color-mix(in srgb, var(--pl-neg) 7%, var(--pl-bg)); border-color: color-mix(in srgb, var(--pl-neg) 30%, transparent); }
.b-neg .bi { background: var(--pl-neg); }
.b-warn { background: color-mix(in srgb, var(--pl-warn) 8%, var(--pl-bg)); border-color: color-mix(in srgb, var(--pl-warn) 30%, transparent); }
.b-warn .bi { background: var(--pl-warn); }
.b-info { background: var(--pl-surface); border-color: var(--pl-border); }
.b-info .bi { background: var(--pl-muted); }

/* empty state: centred icon, one sentence, one primary button */
.center { display: grid; place-items: center; padding: 36px 20px; min-height: 100%; }
.card { width: 100%; max-width: 400px; display: grid; gap: 14px; text-align: center; justify-items: center; }
.card h2 { margin: 0; font-size: 19px; font-weight: 650; text-wrap: balance; }
.card p { margin: 0; color: var(--pl-muted); max-width: 36ch; }
.big-ic { width: 52px; height: 52px; border-radius: 14px; display: grid; place-items: center;
  background: color-mix(in srgb, var(--pl-accent) 12%, transparent); color: var(--pl-accent); }
.big-ic svg { width: 28px; height: 28px; }
.big-ic.muted-ic { background: var(--pl-surface); color: var(--pl-muted); }
.fine { font-size: 12px; color: var(--pl-muted); }

/* sheets and dialogs */
.scrim { position: absolute; inset: 0; z-index: 30; background: rgb(0 0 0 / 0.28); display: grid; place-items: center; padding: 16px; }
.sheet { width: 100%; max-width: 560px; max-height: 100%; overflow: auto; background: var(--pl-bg);
  border: 1px solid var(--pl-border); border-radius: 12px; box-shadow: 0 12px 40px var(--pl-shadow);
  padding: 16px; display: grid; gap: 14px; align-content: start; }
.sheet-hd { display: flex; align-items: flex-start; gap: 10px; }
.sheet-hd div { flex: 1; display: grid; gap: 2px; }
.sheet-hd h2 { margin: 0; font-size: 17px; font-weight: 650; }
.sheet-hd p { margin: 0; font-size: 12.5px; color: var(--pl-muted); }
.sheet-ft { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap;
  padding-top: 12px; border-top: 1px solid var(--pl-border); }
.sheet-ft p { margin: 0; font-size: 12.5px; color: var(--pl-muted); }
@media (max-width: 719px) {
  .scrim { padding: 0; place-items: stretch; }
  .sheet { max-width: none; border-radius: 0; border: 0; }
}

.kbd { display: grid; grid-template-columns: auto 1fr; gap: 6px 14px; margin: 0; font-size: 13px; }
.kbd dt { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12px; }
.kbd dt kbd { border: 1px solid var(--pl-border); border-bottom-width: 2px; border-radius: 4px; padding: 0 5px; background: var(--pl-surface); }
.kbd dd { margin: 0; color: var(--pl-muted); }

/* Below 720px every target is at least 44px: small controls keep their
   look and get a transparent hit area around them. */
@media (max-width: 719px) {
  .pl-app :is(.btn-sm, .chip, .seg, .icon-btn, button.pill, .link) { position: relative; }
  .pl-app :is(.btn-sm, .chip, .seg, .icon-btn, button.pill, .link)::after {
    content: ""; position: absolute; inset: -9px -4px; }
}
@media (prefers-reduced-motion: reduce) {
  .spin, .cbar.is-busy::after { animation: none; }
  .cbar.is-busy::after { width: 100%; left: 0; opacity: 0.4; }
}
`;
