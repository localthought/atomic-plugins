// @wc-ignore-file
/**
 * The Calendar's own rules, on top of the shared `ui/styles.ts`: first-run
 * and picker cards, import progress, sidebar, toolbar, Week grid, Agenda,
 * event drawer, review and conflicts. Class names follow
 * `design/mockups.html`, which is the visual spec.
 */
export const CALENDAR_CSS = `
.shell { flex: 1; min-height: 0; display: flex; position: relative; }
.main { flex: 1; min-width: 0; display: flex; flex-direction: column; min-height: 0; }
.view { flex: 1; min-height: 0; overflow: auto; }

/* first run */
.prov { width: 100%; list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; text-align: left; }
.prov li { display: flex; align-items: center; gap: 12px; padding: 10px 12px; border: 1px solid var(--pl-border); border-radius: 10px; }
.prov li.off { opacity: 0.62; }
.prov .pl { width: 30px; height: 30px; border-radius: 8px; display: grid; place-items: center; font-weight: 800; font-size: 13px; flex: none; color: #fff; }
.prov .pn { flex: 1; display: grid; font-size: 13.5px; font-weight: 600; min-width: 0; }
.prov .pn span { font-weight: 400; font-size: 12px; color: var(--pl-muted); }
.waiting { display: flex; align-items: center; gap: 8px; color: var(--pl-accent); font-weight: 550; justify-content: center; flex-wrap: wrap; }

/* picker */
.panel { padding: 16px 16px 14px; display: grid; gap: 12px; max-width: 560px; }
.panel h2 { margin: 0; font-size: 17px; font-weight: 650; }
.panel > p { margin: 0; color: var(--pl-muted); font-size: 13px; }
.pick { list-style: none; margin: 0; padding: 0; border: 1px solid var(--pl-border); border-radius: 10px; overflow: hidden; }
.pick li + li { border-top: 1px solid var(--pl-border); }
.pick label { display: flex; align-items: center; gap: 10px; padding: 10px 12px; cursor: pointer; min-height: 48px; }
.pick input { accent-color: var(--pl-accent); width: 16px; height: 16px; margin: 0; flex: none; }
.pick .pn { flex: 1; display: grid; font-size: 13.5px; font-weight: 550; min-width: 0; }
.pick .pn span { font-size: 12px; color: var(--pl-muted); font-weight: 400; }
.tag { font-style: normal; font-size: 10.5px; padding: 1px 6px; border-radius: 999px; background: var(--pl-surface);
  color: var(--pl-muted); border: 1px solid var(--pl-border); white-space: nowrap; }
.panel-ft { display: flex; justify-content: space-between; align-items: center; gap: 10px; flex-wrap: wrap; }

/* import progress */
.prog { display: grid; gap: 8px; padding: 14px; border-bottom: 1px solid var(--pl-border); }
.prog-row { display: grid; grid-template-columns: auto 1fr auto; align-items: center; gap: 10px; font-size: 12.5px; }
.prog-row b { font-weight: 600; }
.bar { height: 4px; border-radius: 999px; background: var(--pl-surface); overflow: hidden; position: relative; }
.bar i { position: absolute; inset: 0 auto 0 0; width: 40%; background: var(--pl-accent); border-radius: inherit;
  animation: pl-slide 1.4s ease-in-out infinite; }
.prog-row .n { color: var(--pl-muted); font-variant-numeric: tabular-nums; }
.skel { padding: 12px; display: grid; gap: 10px; }
.sk { height: 44px; border-radius: 8px; background: linear-gradient(90deg, var(--pl-surface), color-mix(in srgb, var(--pl-border) 60%, var(--pl-surface)), var(--pl-surface)); }
.sk.h { height: 14px; width: 30%; }
@media (prefers-reduced-motion: reduce) { .bar i { animation: none; width: 100%; opacity: 0.4; } }

/* sidebar */
.side { width: 232px; flex: none; border-right: 1px solid var(--pl-border); padding: 12px 12px 16px; display: grid;
  gap: 18px; align-content: start; overflow: auto; grid-template-columns: minmax(0, 1fr); }
.mm-hd { display: flex; align-items: center; justify-content: space-between; font-size: 13px; margin-bottom: 4px; }
.mm-hd b { font-weight: 650; }
.mm-g { display: grid; grid-template-columns: repeat(7, 1fr); text-align: center; font-size: 11.5px; font-variant-numeric: tabular-nums; row-gap: 2px; }
.mm-w { color: var(--pl-muted); font-weight: 600; font-size: 10.5px; padding: 2px 0; }
.mm-d { padding: 3px 0; border-radius: 6px; border: 0; background: transparent; cursor: pointer; font-size: 11.5px; }
.mm-d.out { color: color-mix(in srgb, var(--pl-muted) 55%, transparent); }
.mm-d.in-wk { background: var(--pl-surface); }
.mm-d.today { background: var(--pl-accent); color: var(--pl-on-accent); font-weight: 700; }
.side-sec h3 { margin: 0 0 6px; font-size: 11px; letter-spacing: 0.06em; text-transform: uppercase; color: var(--pl-muted); }
.cals { list-style: none; margin: 0; padding: 0; display: grid; gap: 2px; grid-template-columns: minmax(0, 1fr); }
.cals label { display: flex; align-items: center; gap: 8px; padding: 5px 6px; border-radius: 6px; font-size: 13px; cursor: pointer; }
.cals label:hover { background: var(--pl-surface); }
.cals input { accent-color: var(--pl-accent); margin: 0; }
.cals span.nm { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.note p { margin: 0; font-size: 12.5px; color: var(--pl-muted); }

/* toolbar */
.tb { display: flex; align-items: center; gap: 8px; padding: 10px 14px; flex-wrap: wrap; }
.tb-nav { display: flex; }
.tb-title { margin: 0 8px 0 2px; font-size: 16px; font-weight: 620; flex: 1; min-width: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

/* week grid */
.wk { --row: 44px; --gut: 52px; display: flex; flex-direction: column; border-top: 1px solid var(--pl-border); flex: 1; min-height: 0; }
.wk-head, .wk-all { display: grid; grid-template-columns: var(--gut) repeat(var(--n), minmax(0, 1fr)); flex: none; }
.wk-tz { font-size: 10.5px; color: var(--pl-muted); padding: 6px 6px 0 0; text-align: right; }
.wk-dh { display: flex; align-items: baseline; gap: 6px; padding: 8px 8px 6px; font-size: 12px; color: var(--pl-muted);
  border-left: 1px solid var(--pl-border); min-width: 0; white-space: nowrap; overflow: hidden; }
.wk-dh b { font-size: 17px; color: var(--pl-text); font-weight: 600; font-variant-numeric: tabular-nums; }
.wk-dh.is-today span { color: var(--pl-accent); font-weight: 600; }
.wk-dh.is-today b { background: var(--pl-accent); color: var(--pl-on-accent); border-radius: 999px; min-width: 28px; text-align: center; padding: 1px 6px; }
.wk-all { border-bottom: 1px solid var(--pl-border); padding-block: 4px; row-gap: 3px; grid-auto-rows: 22px; min-height: 30px; }
.wk-all .wk-tz { grid-row: 1 / span 2; padding-top: 3px; }
.ad { border: 0; border-radius: 5px; margin: 0 3px; padding: 0 8px; height: 22px; min-width: 0; text-align: left; font-size: 12px;
  font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; cursor: pointer; color: var(--pl-text);
  background: color-mix(in srgb, var(--c) calc(var(--pl-tint) + 6%), var(--pl-bg)); box-shadow: inset 3px 0 0 var(--c); }
.wk-scroll { flex: 1; min-height: 0; overflow-y: auto; overflow-x: hidden; scrollbar-gutter: stable; }
/* Same gutter as the scrolling body, so the columns line up with classic scrollbars. */
.wk-head, .wk-all { overflow-y: hidden; scrollbar-gutter: stable; }
.wk-body { display: grid; grid-template-columns: var(--gut) repeat(var(--n), minmax(0, 1fr)); position: relative;
  background-image: repeating-linear-gradient(to bottom, var(--pl-border) 0 1px, transparent 1px var(--row)); background-position: 0 -1px; }
.wk-h { height: var(--row); position: relative; }
.wk-h span { position: absolute; right: 8px; top: -8px; font-size: 10.5px; color: var(--pl-muted); font-variant-numeric: tabular-nums; }
.wk-h:first-child span { visibility: hidden; }
.wk-col { position: relative; border-left: 1px solid var(--pl-border); height: calc(var(--row) * 24); min-width: 0; }
.wk-col.is-today { background: color-mix(in srgb, var(--pl-accent) 4%, transparent); }
.wk-col h3 { margin: 0; }
.wk-col ul { list-style: none; margin: 0; padding: 0; }
.ev { position: absolute; display: flex; flex-direction: column; gap: 1px; align-items: flex-start; text-align: left; border: 0;
  border-radius: 5px; padding: 3px 6px 3px 8px; overflow: hidden; cursor: pointer; color: var(--pl-text);
  background: color-mix(in srgb, var(--c) var(--pl-tint), var(--pl-surface)); box-shadow: inset 3px 0 0 var(--c); font-size: 12px; line-height: 1.3; }
.ev:hover { background: color-mix(in srgb, var(--c) calc(var(--pl-tint) + 8%), var(--pl-surface)); }
.ev-t { font-weight: 600; overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; max-width: 100%; }
.ev-m { color: color-mix(in srgb, var(--pl-text) 60%, var(--pl-muted)); font-size: 11px; font-variant-numeric: tabular-nums; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.ev-short { flex-direction: row; align-items: center; padding-block: 0; }
.ev-short .ev-t { -webkit-line-clamp: 1; font-size: 11px; }
.ev-edited { outline: 1.5px dashed color-mix(in srgb, var(--pl-accent) 70%, transparent); outline-offset: -1.5px; }
.ev-dot { position: absolute; right: 5px; top: 5px; width: 7px; height: 7px; border-radius: 50%; background: var(--pl-accent); }
.ev-badge { position: absolute; right: 4px; top: 4px; width: 15px; height: 15px; border-radius: 50%; background: var(--pl-warn);
  color: var(--pl-bg); font-size: 10.5px; font-weight: 800; display: grid; place-items: center; }
.ev-more { position: absolute; border: 1px solid var(--pl-border); border-radius: 5px; background: var(--pl-bg); font-size: 11px;
  font-weight: 650; cursor: pointer; color: var(--pl-muted); padding: 0; }
.now { position: absolute; left: -1px; right: 0; height: 2px; background: var(--pl-neg); z-index: 2; pointer-events: none; }
.now::before { content: ""; position: absolute; left: -5px; top: -4px; width: 10px; height: 10px; border-radius: 50%; background: var(--pl-neg); }

/* agenda */
.strip { display: grid; grid-template-columns: repeat(7, 1fr); gap: 2px; padding: 0 8px 8px; border-bottom: 1px solid var(--pl-border); }
.st-d { display: grid; justify-items: center; gap: 1px; border: 0; background: transparent; border-radius: 10px; padding: 6px 0 5px; cursor: pointer; min-height: 48px; }
.st-d span { font-size: 10.5px; color: var(--pl-muted); font-weight: 600; }
.st-d b { font-size: 15px; font-variant-numeric: tabular-nums; font-weight: 600; }
.st-d i { width: 4px; height: 4px; border-radius: 50%; background: var(--pl-muted); }
.st-d i.off { visibility: hidden; }
.st-d[aria-current="date"] { background: var(--pl-accent); }
.st-d[aria-current="date"] span, .st-d[aria-current="date"] b { color: var(--pl-on-accent); }
.st-d[aria-current="date"] i { background: var(--pl-on-accent); }
.agenda { display: grid; }
.ag-dh { position: sticky; top: 0; z-index: 1; margin: 0; display: flex; justify-content: space-between; align-items: baseline;
  padding: 10px 12px 4px; font-size: 13px; font-weight: 650; background: var(--pl-bg); }
.ag-dh span { font-size: 12px; color: var(--pl-muted); font-weight: 500; }
.ag-dh.is-today { color: var(--pl-accent); }
.ag-day ul { list-style: none; margin: 0; padding: 0 4px 6px; }
.ag-row { width: 100%; display: flex; align-items: flex-start; gap: 10px; border: 0; background: transparent; text-align: left;
  padding: 8px; border-radius: 8px; min-height: 48px; cursor: pointer; color: var(--pl-text); }
.ag-row:hover { background: var(--pl-surface); }
.ag-row .sw { margin-top: 5px; }
.ag-time { width: 44px; flex: none; display: grid; font-size: 12.5px; font-weight: 600; font-variant-numeric: tabular-nums; line-height: 1.35; }
.ag-time small { font-weight: 400; color: var(--pl-muted); font-size: 11.5px; }
.ag-main { display: grid; min-width: 0; gap: 1px; }
.ag-main b { font-weight: 600; font-size: 14px; overflow-wrap: anywhere; }
.ag-main > span { font-size: 12.5px; color: var(--pl-muted); }
.tagline { font-size: 11px; font-weight: 650; letter-spacing: 0.02em; }
.tagline.accent { color: var(--pl-accent); }
.tagline.warn { color: var(--pl-warn); }
.ag-none { padding: 6px 12px 10px 66px; color: var(--pl-muted); font-size: 12.5px; margin: 0; }

/* drawer */
.drawer { position: absolute; top: 0; right: 0; bottom: 0; width: 380px; max-width: 100%; background: var(--pl-bg);
  border-left: 1px solid var(--pl-border); box-shadow: -12px 0 32px var(--pl-shadow); padding: 14px 18px 16px;
  display: flex; flex-direction: column; gap: 14px; z-index: 10; overflow: auto; animation: pl-in 0.16s ease-out; }
@keyframes pl-in { from { transform: translateX(24px); opacity: 0; } }
@media (max-width: 899px) { .drawer { width: 360px; } }
@media (max-width: 719px) { .drawer { width: 100%; border-left: 0; box-shadow: none; } }
@media (prefers-reduced-motion: reduce) { .drawer { animation: none; } }
.dr-hd { display: flex; align-items: center; gap: 8px; font-size: 12.5px; color: var(--pl-muted); }
.dr-hd .icon-btn { margin-left: auto; font-size: 14px; }
.drawer h2 { margin: 0; font-size: 20px; line-height: 1.25; font-weight: 650; text-wrap: balance; overflow-wrap: anywhere; }
.dr-f { margin: 0; display: grid; gap: 12px; }
.dr-f div { display: grid; grid-template-columns: 64px 1fr; gap: 8px; }
.dr-f dt { font-size: 12px; color: var(--pl-muted); padding-top: 1px; }
.dr-f dd { margin: 0; display: grid; overflow-wrap: anywhere; white-space: pre-wrap; }
.dr-f dd b { font-variant-numeric: tabular-nums; font-weight: 600; }
.dr-f .muted { font-size: 12.5px; }
.dr-hint { margin: 0; font-size: 12.5px; color: var(--pl-muted); padding: 8px 10px; background: var(--pl-surface); border-radius: 6px; }
.dr-ft { margin-top: auto; display: flex; justify-content: space-between; align-items: center; gap: 8px; padding-top: 12px; border-top: 1px solid var(--pl-border); }
.form { display: flex; flex-direction: column; gap: 12px; flex: 1; }
.fld { display: grid; gap: 4px; font-size: 12px; color: var(--pl-muted); }
.fld input, .fld textarea { height: 34px; border: 1px solid var(--pl-border); border-radius: 6px; padding: 0 10px; background: var(--pl-bg); font-size: 14px; color: var(--pl-text); min-width: 0; }
.fld textarea { height: auto; padding: 8px 10px; resize: vertical; }
.fld input:focus, .fld textarea:focus { outline: 2px solid var(--pl-accent); outline-offset: -1px; border-color: transparent; }
.fld-2 { display: grid; grid-template-columns: minmax(0, 1fr) 112px; column-gap: 6px; row-gap: 4px; font-size: 12px; color: var(--pl-muted); }
.fld-2 > span { grid-column: 1 / -1; }
.fld-2.all-day { grid-template-columns: minmax(0, 1fr); }
.fld-2 input { height: 34px; border: 1px solid var(--pl-border); border-radius: 6px; padding: 0 8px; background: var(--pl-bg); font-size: 14px; color: var(--pl-text); min-width: 0; }
.fld-2 input.t { font-variant-numeric: tabular-nums; text-align: center; }
.pl-app input.is-bad { border-color: var(--pl-neg); box-shadow: 0 0 0 1px var(--pl-neg); }
.err { margin: -6px 0 0; color: var(--pl-neg); font-size: 12.5px; font-weight: 550; }
.sw-row { display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer; }
.sw-row input { appearance: none; width: 32px; height: 18px; border-radius: 999px; background: var(--pl-border); position: relative; margin: 0; cursor: pointer; flex: none; }
.sw-row input::after { content: ""; position: absolute; top: 2px; left: 2px; width: 14px; height: 14px; border-radius: 50%; background: var(--pl-bg); box-shadow: 0 1px 2px rgb(0 0 0 / 0.25); transition: left 0.12s; }
.sw-row input:checked { background: var(--pl-accent); }
.sw-row input:checked::after { left: 16px; }
.saved { display: flex; align-items: center; gap: 10px; padding: 10px 12px; border-radius: 8px; flex-wrap: wrap;
  background: color-mix(in srgb, var(--pl-accent) 8%, var(--pl-bg)); border: 1px solid color-mix(in srgb, var(--pl-accent) 25%, transparent); }
.saved div { display: grid; flex: 1; min-width: 12ch; font-size: 12.5px; color: var(--pl-muted); }
.saved b { color: var(--pl-text); font-size: 13px; }
.dot-accent { width: 8px; height: 8px; border-radius: 50%; background: var(--pl-accent); flex: none; }
.conflict-note { display: flex; gap: 10px; align-items: center; padding: 10px 12px; border-radius: 8px; flex-wrap: wrap;
  background: color-mix(in srgb, var(--pl-warn) 8%, var(--pl-bg)); border: 1px solid color-mix(in srgb, var(--pl-warn) 30%, transparent); font-size: 12.5px; }
.conflict-note span { flex: 1; min-width: 12ch; }

/* review and conflicts */
.chg { list-style: none; margin: 0; padding: 0; display: grid; gap: 10px; }
.chg > li { border: 1px solid var(--pl-border); border-radius: 10px; padding: 10px 12px; display: grid; gap: 8px; }
.chg-hd { display: flex; align-items: center; gap: 8px; font-size: 13.5px; flex-wrap: wrap; }
.chg-hd b { flex: 1; font-weight: 600; min-width: 10ch; overflow-wrap: anywhere; }
.chg-hd .when { font-size: 12px; color: var(--pl-muted); font-variant-numeric: tabular-nums; }
.diff { display: grid; grid-template-columns: 78px minmax(0, 1fr); gap: 4px 10px; font-size: 12.5px; margin: 0; }
.diff dt { color: var(--pl-muted); }
.diff dd { margin: 0; display: flex; flex-wrap: wrap; gap: 4px 6px; align-items: baseline; overflow-wrap: anywhere; min-width: 0; }
.diff del { color: var(--pl-muted); text-decoration-color: color-mix(in srgb, var(--pl-neg) 70%, transparent); }
.diff ins { text-decoration: none; font-weight: 600; background: color-mix(in srgb, var(--pl-accent) 10%, transparent); padding: 0 4px; border-radius: 3px; }
.rs { font-size: 12px; font-weight: 600; display: inline-flex; align-items: center; gap: 5px; white-space: nowrap; }
.rs.ok { color: var(--pl-pos); }
.rs.fail { color: var(--pl-warn); }
.rs.wait { color: var(--pl-muted); }
.chg-ft { display: flex; gap: 8px; justify-content: flex-end; flex-wrap: wrap; align-items: center; }
.cf { display: grid; gap: 6px; }
.cf-row { display: grid; grid-template-columns: 78px minmax(0, 1fr) minmax(0, 1fr); gap: 6px; align-items: stretch; font-size: 12.5px; }
.cf-row > span { color: var(--pl-muted); padding-top: 9px; }
.opt { display: grid; gap: 1px; border: 1px solid var(--pl-border); border-radius: 8px; padding: 7px 10px 7px 30px; position: relative; cursor: pointer; overflow-wrap: anywhere; }
.opt input { position: absolute; left: 9px; top: 10px; margin: 0; accent-color: var(--pl-accent); }
.opt small { font-size: 11px; color: var(--pl-muted); font-weight: 600; letter-spacing: 0.02em; text-transform: uppercase; }
.opt:has(input:checked) { border-color: var(--pl-accent); background: color-mix(in srgb, var(--pl-accent) 6%, var(--pl-bg)); }
.cf-lost { font-size: 12.5px; color: var(--pl-muted); margin: 0; }
.confirm { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; }
@media (max-width: 559px) {
  .cf-row { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
  .cf-row > span { grid-column: 1 / -1; padding-top: 0; }
}

/* narrow layout */
@media (max-width: 719px) {
  .hd { padding: 10px 12px; gap: 8px; }
  .hd-act { gap: 6px; }
  .hd .pill { padding: 0 8px; }
  .hd-chips { flex: none; order: 3; width: 100%; }
  .cbar { padding-inline: 12px; }
  .cbar-last { display: none; }
  .tb { padding: 10px 12px 6px; gap: 4px; }
  .tb .icon-btn { width: 26px; }
  .tb-title { font-size: 15px; margin-right: 4px; }
}
`;
