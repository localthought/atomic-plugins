// @wc-ignore-file
/**
 * PLUGIN CSS: the shared #89 plugin shell (DESIGN.md §4–5).
 *
 * The host posts its theme into the frame as `--t-*` custom properties
 * (atomic-server `useCreateThemeVars.ts`); dark mode is the host swapping
 * those values, so there are no `prefers-color-scheme` rules here. Everything
 * styles through the `--pl-*` map below, each with a light fallback for the
 * moment before the host's stylesheet arrives. Class and token names are the
 * ones the #89 designs share (`.pl-header`, `.pl-pill[data-state]`,
 * `.pl-conn`, `.pl-empty`, `.pl-banner[data-tone]`); buttons, chips, tabs and
 * the detail panel carry the same `pl-` prefix so a host stylesheet cannot
 * collide with them. Money-only rules live in `../styles.ts`.
 */
export const PLUGIN_CSS = `
.pl-app {
  --pl-bg: var(--t-color-bg-body, #fafafa);
  --pl-surface: var(--t-color-bg, #ffffff);
  --pl-subtle: var(--t-color-bg-1, #f2f2f2);
  --pl-border: var(--t-color-bg-2, #cccccc);
  --pl-text: var(--t-color-text, #000000);
  --pl-muted: var(--t-color-text-light, #666666);
  --pl-accent: var(--t-color-main, #1b50d8);
  --pl-accent-soft: var(--t-color-main-selected-bg, #f1f4fd);
  --pl-accent-ink: var(--t-color-main-selected-fg, #0f2d7a);
  --pl-on-accent: var(--t-color-bg, #ffffff);
  --pl-neg: var(--t-color-alert, #cf5b5b);
  --pl-warn: var(--t-color-warning, #f5a623);
  /* The host's success colour (since the 007869464 pin); before that, a
     green mixed toward the text colour, so it darkens on a white ground and
     lightens on a black one. */
  --pl-pos: var(--t-color-success, color-mix(in oklab, #2f8f5b 75%, var(--pl-text)));
  --pl-radius: var(--t-radius, 9px);
  --pl-font: var(--t-font-family, system-ui, sans-serif);
  --pl-font-header: var(--t-font-family-header, var(--pl-font));
  --pl-tint: color-mix(in oklab, var(--pl-text) 4%, var(--pl-surface));
  --pl-hair: color-mix(in oklab, var(--pl-text) 12%, var(--pl-surface));
  --pl-neg-soft: color-mix(in oklab, var(--pl-neg) 10%, var(--pl-surface));
  --pl-warn-soft: color-mix(in oklab, var(--pl-warn) 14%, var(--pl-surface));
  --pl-pos-soft: color-mix(in oklab, var(--pl-pos) 12%, var(--pl-surface));
  container: pl-app / inline-size;
  background: var(--pl-surface);
  color: var(--pl-text);
  font-family: var(--pl-font);
  font-size: 14px;
  line-height: 1.45;
  position: relative;
  min-height: 100vh;
  box-sizing: border-box;
}
.pl-app[data-color-scheme='light'] { color-scheme: light; }
.pl-app[data-color-scheme='dark'] { color-scheme: dark; }
.pl-app *, .pl-app *::before, .pl-app *::after { box-sizing: border-box; }
.pl-app button, .pl-app input, .pl-app select, .pl-app textarea {
  font: inherit;
  color: inherit;
}
.pl-app :focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 2px; }
.pl-app [hidden] { display: none !important; }
.pl-sr {
  position: absolute !important;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
.pl-num { font-variant-numeric: tabular-nums; }
.pl-muted { color: var(--pl-muted); }
.pl-mono {
  font-family: ui-monospace, 'SF Mono', Menlo, Consolas, monospace;
  font-size: 12.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.pl-ico { width: 16px; height: 16px; flex: none; }

/* Header */
.pl-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 20px;
  min-height: 56px;
  border-bottom: 1px solid var(--pl-hair);
  flex-wrap: wrap;
}
.pl-header h1 {
  margin: 0;
  font-family: var(--pl-font-header);
  font-size: 1.125rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.pl-spacer { flex: 1; }
@container pl-app (max-width: 559px) {
  .pl-header { padding: 8px 12px; gap: 8px; }
  .pl-header .pl-context { order: 5; flex: 1 1 100%; }
}

/* Status pill: the live region. Its text always names the state. */
.pl-pill {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 24px;
  padding: 0 10px;
  border-radius: 999px;
  font-size: 12.5px;
  background: var(--pl-tint);
  white-space: nowrap;
}
.pl-pill::before {
  content: '';
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--pl-dot, var(--pl-muted));
}
.pl-pill[data-state='syncing'] {
  --pl-dot: var(--pl-accent);
  background: var(--pl-accent-soft);
  color: var(--pl-accent-ink);
}
.pl-pill[data-state='syncing']::before { animation: pl-pulse 1.2s ease-in-out infinite; }
.pl-pill[data-state='synced'] { --pl-dot: var(--pl-pos); background: var(--pl-pos-soft); }
.pl-pill[data-state='paused'], .pl-pill[data-state='reauth'] {
  --pl-dot: var(--pl-warn);
  background: var(--pl-warn-soft);
}
.pl-pill[data-state='error'] { --pl-dot: var(--pl-neg); background: var(--pl-neg-soft); }
@keyframes pl-pulse { 50% { opacity: 0.25; } }

/* Buttons */
.pl-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 14px;
  border-radius: 8px;
  border: 1px solid var(--pl-border);
  background: var(--pl-surface);
  cursor: pointer;
  font-weight: 600;
  font-size: 13.5px;
  white-space: nowrap;
  text-decoration: none;
}
.pl-btn[data-variant='primary'] {
  background: var(--pl-accent);
  border-color: var(--pl-accent);
  color: var(--pl-on-accent);
}
.pl-btn[data-variant='ghost'] {
  border-color: transparent;
  background: transparent;
  color: var(--pl-accent);
  padding-inline: 6px;
}
.pl-btn[data-icon-only] { width: 40px; min-height: 40px; padding: 0; }
.pl-btn:disabled { opacity: 0.45; cursor: not-allowed; }
@container pl-app (max-width: 559px) {
  .pl-btn { min-height: 40px; }
}

/* Chips (toggle buttons) */
.pl-chips { display: flex; gap: 6px; flex-wrap: wrap; }
.pl-chip {
  border: 1px solid var(--pl-border);
  border-radius: 999px;
  padding: 4px 11px;
  font-size: 12.5px;
  background: var(--pl-surface);
  cursor: pointer;
  white-space: nowrap;
}
.pl-chip[aria-pressed='true'] {
  background: var(--pl-accent-soft);
  color: var(--pl-accent-ink);
  border-color: color-mix(in oklab, var(--pl-accent) 40%, var(--pl-surface));
  font-weight: 600;
}
@container pl-app (max-width: 559px) {
  .pl-chip { min-height: 40px; padding-inline: 13px; }
}

/* Tabs */
.pl-tabs {
  display: flex;
  gap: 2px;
  padding: 0 16px;
  border-bottom: 1px solid var(--pl-hair);
  overflow-x: auto;
}
.pl-tabs button {
  border: 0;
  background: none;
  cursor: pointer;
  padding: 10px 10px 9px;
  color: var(--pl-muted);
  border-bottom: 2px solid transparent;
  font-weight: 600;
  font-size: 13.5px;
  white-space: nowrap;
}
.pl-tabs button[aria-selected='true'] {
  color: var(--pl-text);
  border-bottom-color: var(--pl-accent);
}
.pl-tabs .pl-count { font-weight: 500; color: var(--pl-muted); margin-left: 4px; }
@container pl-app (max-width: 559px) {
  .pl-tabs { padding: 0 6px; }
  .pl-tabs button { min-height: 40px; }
}

/* Connection bar: proxy-backed sources only */
.pl-conn {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 40px;
  padding: 6px 20px;
  background: var(--pl-subtle);
  font-size: 13px;
  flex-wrap: wrap;
}
.pl-conn[data-tone='warn'] { background: var(--pl-warn-soft); }

/* Empty state */
.pl-empty {
  padding: 36px 24px 32px;
  display: grid;
  gap: 12px;
  max-width: 560px;
  margin: 0 auto;
  text-align: center;
  justify-items: center;
}
.pl-empty h2 {
  margin: 0;
  font-family: var(--pl-font-header);
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-wrap: balance;
}
.pl-empty p { margin: 0; max-width: 58ch; }
.pl-empty .pl-actions { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }

/* Banner */
.pl-banner {
  border-left: 3px solid var(--pl-neg);
  background: var(--pl-neg-soft);
  border-radius: 0 8px 8px 0;
  padding: 12px 14px;
  display: grid;
  gap: 8px;
}
.pl-banner[data-tone='warn'] { border-left-color: var(--pl-warn); background: var(--pl-warn-soft); }
.pl-banner[data-tone='info'] { border-left-color: var(--pl-accent); background: var(--pl-accent-soft); }
.pl-banner h3 { margin: 0; font-size: 14.5px; font-weight: 650; }
.pl-banner h3:focus { outline: none; }
.pl-banner p { margin: 0; }
.pl-banner details summary { cursor: pointer; font-size: 12.5px; color: var(--pl-muted); }
.pl-banner details p { margin-top: 6px; }

/* Detail panel: side panel (≥900px), drawer (560–899px), sheet (<560px) */
.pl-panel {
  background: var(--pl-surface);
  border-left: 1px solid var(--pl-border);
  display: flex;
  flex-direction: column;
  min-height: 100%;
}
.pl-panel[data-mode='drawer'] {
  position: fixed;
  inset: 0 0 0 auto;
  width: min(420px, 90vw);
  z-index: 20;
  overflow-y: auto;
  box-shadow: -18px 0 40px -24px rgba(0, 0, 0, 0.45);
  animation: pl-slide 0.18s ease-out;
}
.pl-panel[data-mode='sheet'] {
  position: fixed;
  inset: 0;
  z-index: 20;
  border-left: 0;
  overflow-y: auto;
}
.pl-scrim {
  position: fixed;
  inset: 0;
  z-index: 19;
  background: color-mix(in oklab, var(--pl-text) 28%, transparent);
}
@keyframes pl-slide { from { transform: translateX(24px); opacity: 0.6; } }

@media (prefers-reduced-motion: reduce) {
  .pl-pill[data-state='syncing']::before { animation: none; }
  .pl-panel[data-mode='drawer'] { animation: none; }
}
`;
