// @wc-ignore-file
/**
 * The shared plugin shell's stylesheet (`pl-*`), from the "PLUGIN CSS"
 * block of integrations/notion/design/mockups.html (#89), one rule per line.
 * Every colour is a `--pl-*` token mapped from the host's `--t-*` theme
 * variables with a light fallback, so the host's light/dark switch and main
 * colour apply without `prefers-color-scheme` here. Widths use a container
 * query on the app root (`pl-app`), not viewport media queries.
 *
 * Kept free of Notion specifics so it can move to a shared kit later.
 */
export const PL_CSS = `
.pl-app{--pl-bg:var(--t-color-bg-body,#fafafa);--pl-surface:var(--t-color-bg,#fff);--pl-subtle:var(--t-color-bg-1,#f2f2f2);--pl-border:var(--t-color-bg-2,#ccc);--pl-text:var(--t-color-text,#000);--pl-muted:var(--t-color-text-light,#666);--pl-accent:var(--t-color-main,#1b50d8);--pl-accent-soft:var(--t-color-main-selected-bg,#eef2fd);--pl-neg:var(--t-color-alert,#cf5b5b);--pl-warn:var(--t-color-warning,#f5a623);--pl-pos:#2f8f5b;--pl-radius:var(--t-radius,9px);--pl-hair:color-mix(in srgb,var(--pl-border) 55%,transparent);height:100vh;min-height:20rem;container:pl-app/inline-size;display:flex;flex-direction:column;position:relative;background:var(--pl-bg);color:var(--pl-text);font:14px/1.45 var(--t-font-family,system-ui,sans-serif)}
.pl-app *{box-sizing:border-box}
.pl-app :focus-visible{outline:2px solid var(--pl-accent);outline-offset:2px}
.pl-app .ic{width:16px;height:16px;flex:none}
.pl-app .ic.sm{width:13px;height:13px}
.pl-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.pl-spacer{flex:1}
.pl-header{display:flex;align-items:center;gap:8px 14px;flex-wrap:wrap;padding:10px 16px;background:var(--pl-surface);border-bottom:1px solid var(--pl-hair)}
.pl-brand{display:flex;align-items:center;gap:9px}
.pl-mark{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:7px;background:var(--pl-text);color:var(--pl-surface);font:700 15px/1 Georgia,'Times New Roman',serif}
.pl-mark.is-lg{width:48px;height:48px;border-radius:12px;font-size:28px}
.pl-name{font:700 15px/1 var(--t-font-family-header,system-ui);letter-spacing:-0.005em}
.pl-chips{flex:1;min-width:0;display:flex;gap:6px;overflow-x:auto;scrollbar-width:none}
.pl-chip{display:inline-flex;align-items:center;gap:6px;height:28px;padding:0 11px;border-radius:999px;border:1px solid var(--pl-hair);background:transparent;color:var(--pl-muted);font:inherit;font-size:13px;white-space:nowrap;cursor:pointer}
.pl-chip:hover{background:var(--pl-subtle);color:var(--pl-text)}
.pl-chip[aria-pressed='true']{background:var(--pl-accent-soft);border-color:color-mix(in srgb,var(--pl-accent) 45%,transparent);color:var(--pl-text);font-weight:600}
.pl-chip .ic{width:13px;height:13px}
.pl-count{font-variant-numeric:tabular-nums;color:var(--pl-muted);font-weight:400;font-size:12px}
.pl-actions{display:flex;align-items:center;gap:10px;margin-left:auto}
.pl-pill{display:inline-flex;align-items:center;gap:7px;height:28px;padding:0 11px;border-radius:999px;background:var(--pl-subtle);color:var(--pl-muted);font-size:12.5px;white-space:nowrap}
.pl-pill .ic{width:14px;height:14px}
.pl-dot{width:8px;height:8px;border-radius:50%;background:var(--pl-pos);flex:none}
.pl-pill.is-sync{color:var(--pl-text);background:var(--pl-accent-soft)}
.pl-pill.is-sync .ic{color:var(--pl-accent)}
.pl-pill.is-warn{background:color-mix(in srgb,var(--pl-warn) 16%,var(--pl-surface));color:var(--pl-text)}
.pl-pill.is-warn .ic{color:color-mix(in srgb,var(--pl-warn) 75%,var(--pl-text))}
.pl-pill.is-neg{background:color-mix(in srgb,var(--pl-neg) 14%,var(--pl-surface));color:var(--pl-text)}
.pl-pill.is-neg .ic{color:var(--pl-neg)}
.pl-spin{display:inline-flex}
.pl-spin .ic{animation:pl-rot 1.1s linear infinite}
@keyframes pl-rot{to{transform:rotate(360deg)}}
.pl-select{position:relative;flex-basis:100%;display:flex}
.pl-select select{appearance:none;width:100%;height:34px;padding:0 32px 0 10px;border:1px solid var(--pl-border);border-radius:8px;background:var(--pl-surface);color:var(--pl-text);font:inherit}
.pl-select .ic{position:absolute;right:10px;top:9px;color:var(--pl-muted);pointer-events:none}
.pl-btn{display:inline-flex;align-items:center;justify-content:center;gap:7px;height:32px;padding:0 14px;border-radius:var(--pl-radius);border:1px solid transparent;font:600 13.5px/1 var(--t-font-family,system-ui);cursor:pointer;text-decoration:none;white-space:nowrap}
.pl-btn .ic{width:15px;height:15px}
.pl-btn.is-primary{background:var(--pl-accent);color:var(--pl-surface)}
.pl-btn.is-primary:hover:not([disabled]){background:var(--t-color-main-light,var(--pl-accent))}
.pl-btn.is-secondary{background:var(--pl-surface);border-color:var(--pl-border);color:var(--pl-text)}
.pl-btn.is-secondary:hover{background:var(--pl-subtle)}
.pl-btn.is-danger{background:var(--pl-neg);color:#fff}
.pl-btn.is-ghost{background:transparent;color:var(--pl-muted)}
.pl-btn.is-ghost:hover{background:var(--pl-subtle);color:var(--pl-text)}
.pl-btn.is-sm{height:28px;padding:0 10px;font-size:12.5px}
.pl-btn.is-lg{height:40px;padding:0 20px;font-size:14.5px}
.pl-btn[disabled]{opacity:0.55;cursor:default}
.pl-icon-btn{display:inline-grid;place-items:center;width:30px;height:30px;border:0;border-radius:7px;background:transparent;color:var(--pl-muted);cursor:pointer}
.pl-icon-btn:hover{background:var(--pl-subtle);color:var(--pl-text)}
.pl-connbar{display:flex;align-items:center;gap:8px;padding:5px 12px 5px 16px;min-height:38px;background:var(--pl-surface);border-bottom:1px solid var(--pl-hair);font-size:12.5px;color:var(--pl-muted);white-space:nowrap}
.pl-cb-item{display:inline-flex;align-items:center;gap:5px}
.pl-cb-item:first-of-type{color:var(--pl-text);font-weight:600}
.pl-sep{opacity:0.5}
.pl-banner{display:grid;grid-template-columns:auto 1fr auto;gap:4px 12px;align-items:start;margin:12px 16px 0;padding:12px 14px;border-radius:var(--pl-radius);border:1px solid color-mix(in srgb,var(--pl-neg) 40%,transparent);background:color-mix(in srgb,var(--pl-neg) 9%,var(--pl-surface))}
.pl-banner>.ic{margin-top:2px;color:var(--pl-neg)}
.pl-banner.is-warn{border-color:color-mix(in srgb,var(--pl-warn) 50%,transparent);background:color-mix(in srgb,var(--pl-warn) 11%,var(--pl-surface))}
.pl-banner.is-warn>.ic{color:color-mix(in srgb,var(--pl-warn) 75%,var(--pl-text))}
.pl-banner p{margin:0;font-size:13px;color:var(--pl-muted);max-width:62ch}
.pl-banner .pl-banner-t{color:var(--pl-text);font-weight:700;font-size:14px;margin-bottom:2px}
.pl-empty{margin:auto;max-width:460px;padding:32px 24px;display:grid;gap:12px;justify-items:center;text-align:center}
.pl-empty h2{margin:4px 0 0;font:700 18px/1.3 var(--t-font-family-header,system-ui);text-wrap:balance}
.pl-empty>p{margin:0;color:var(--pl-muted);max-width:44ch}
.pl-empty-glyph{display:inline-grid;place-items:center;width:48px;height:48px;border-radius:12px;background:var(--pl-subtle);color:var(--pl-muted)}
.pl-empty-glyph .ic{width:24px;height:24px}
.pl-facts{list-style:none;margin:6px 0;padding:14px 16px;display:grid;gap:9px;text-align:left;background:var(--pl-surface);border:1px solid var(--pl-hair);border-radius:var(--pl-radius);font-size:13px}
.pl-facts li{display:grid;grid-template-columns:18px 1fr;gap:10px;align-items:start}
.pl-facts .ic{margin-top:2px;color:var(--pl-muted)}
.pl-secondary{margin:0;font-size:12.5px;color:var(--pl-muted);max-width:44ch}
.pl-steps{margin:4px 0 0;padding:12px 16px 12px 34px;text-align:left;font-size:13px;display:grid;gap:5px;background:var(--pl-surface);border:1px solid var(--pl-hair);border-radius:var(--pl-radius)}
.pl-app button{font-family:inherit}
.pl-select{display:none}
.pl-muted{color:var(--pl-muted)}
.pl-live{display:contents}
.pl-menu-wrap{position:relative}
.pl-menu{position:absolute;right:0;top:calc(100% + 4px);z-index:20;min-width:220px;padding:4px;background:var(--pl-surface);border:1px solid var(--pl-border);border-radius:var(--pl-radius);box-shadow:var(--t-box-shadow-intense,0 8px 30px rgba(0,0,0,0.2));display:grid}
.pl-menu button{display:flex;align-items:center;gap:8px;height:32px;padding:0 10px;border:0;border-radius:6px;background:none;color:var(--pl-text);font:inherit;font-size:13px;text-align:left;cursor:pointer;white-space:nowrap}
.pl-menu button:hover,.pl-menu button:focus-visible{background:var(--pl-subtle)}
.pl-menu button[disabled]{color:var(--pl-muted);cursor:default}
.pl-cb-btn{display:inline-flex;align-items:center;gap:4px;height:28px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--pl-text);font:inherit;font-size:12.5px;font-weight:600;cursor:pointer}
.pl-cb-btn:hover{background:var(--pl-subtle)}
.pl-cb-btn[disabled]{color:var(--pl-muted);font-weight:400;cursor:default}
.pl-cb-btn .ic{width:13px;height:13px}
.pl-banner .pl-btn{align-self:center}
.pl-banner details{margin-top:6px;font-size:12.5px;color:var(--pl-muted)}
.pl-banner summary{cursor:pointer}
.pl-banner pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;background:var(--pl-surface);white-space:pre-wrap;font:11.5px/1.5 ui-monospace,Menlo,monospace}
.pl-copy{display:flex;align-items:center;gap:6px;margin-top:8px;padding:6px 8px;border:1px solid var(--pl-hair);border-radius:8px;background:var(--pl-subtle);font-size:12.5px}
.pl-copy code{flex:1;min-width:0;overflow-wrap:anywhere;user-select:all;font:12px/1.4 ui-monospace,Menlo,monospace}
@container pl-app (max-width:639.98px){.pl-header{padding:10px 12px}.pl-chips{display:none}.pl-select{display:flex}.pl-pill{height:26px;padding:0 9px}.pl-connbar{padding-left:12px}.pl-btn{height:36px}.pl-btn.is-sm{height:32px}.pl-icon-btn{width:44px;height:44px}.pl-cb-hide-narrow{display:none}}
@media (prefers-reduced-motion:reduce){.pl-spin .ic{animation:none}}
`;
