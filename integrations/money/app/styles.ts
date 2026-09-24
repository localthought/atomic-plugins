// @wc-ignore-file
/**
 * Money-only styles, on top of the shared shell in `ui/css.ts`. Every colour
 * is a `--pl-*` token; widths follow the `pl-app` container, which is the
 * frame's width.
 */
export const MONEY_CSS = `
.pl-app { margin: 0; }
.m-amt { font-variant-numeric: tabular-nums; white-space: nowrap; font-weight: 600; }
.m-amt[data-dir='in'] { color: var(--pl-pos); }
.m-amt small { font-weight: 500; color: var(--pl-muted); margin-left: 3px; font-size: 11.5px; }

/* Account switcher: a native select dressed as the design's switcher */
.m-switcher {
  appearance: none;
  border: 1px solid var(--pl-border);
  border-radius: 8px;
  padding: 5px 30px 5px 10px;
  background-color: var(--pl-surface);
  background-image:
    linear-gradient(45deg, transparent 50%, var(--pl-muted) 50%),
    linear-gradient(135deg, var(--pl-muted) 50%, transparent 50%);
  background-position: right 15px center, right 10px center;
  background-size: 5px 5px, 5px 5px;
  background-repeat: no-repeat;
  cursor: pointer;
  max-width: 100%;
  min-height: 34px;
}
@container pl-app (max-width: 559px) {
  .m-switcher { width: 100%; min-height: 40px; }
}

/* Summary strip */
.m-strip {
  display: grid;
  grid-auto-flow: column;
  grid-auto-columns: minmax(220px, 1fr);
  border-bottom: 1px solid var(--pl-hair);
  overflow-x: auto;
  overscroll-behavior-x: contain;
}
.m-seg {
  all: unset;
  box-sizing: border-box;
  cursor: pointer;
  padding: 14px 20px;
  display: grid;
  gap: 2px;
  align-content: start;
  border-right: 1px solid var(--pl-border);
}
.m-seg:last-child { border-right: 0; }
.m-seg:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: -2px; }
.m-seg[aria-pressed='true'] {
  background: var(--pl-accent-soft);
  box-shadow: inset 0 -2px 0 var(--pl-accent);
}
.m-seg .m-acct { font-size: 12.5px; color: var(--pl-muted); }
.m-seg .m-net {
  font-family: var(--pl-font-header);
  font-size: 1.35rem;
  font-weight: 600;
  letter-spacing: -0.01em;
  font-variant-numeric: tabular-nums;
}
.m-seg .m-net small {
  font-family: var(--pl-font);
  font-size: 12px;
  font-weight: 500;
  color: var(--pl-muted);
  margin-left: 6px;
  letter-spacing: 0;
}
.m-seg .m-flow { display: flex; gap: 14px; font-size: 12.5px; flex-wrap: wrap; }
@container pl-app (max-width: 559px) {
  .m-strip { grid-auto-columns: 78%; }
  .m-seg { padding: 12px 14px; }
}

/* Filters */
.m-filters {
  display: flex;
  gap: 8px;
  padding: 12px 20px;
  align-items: center;
  flex-wrap: wrap;
}
.m-search {
  display: flex;
  align-items: center;
  gap: 6px;
  border: 1px solid var(--pl-border);
  border-radius: 8px;
  padding: 0 10px;
  min-height: 34px;
  flex: 1 1 200px;
  max-width: 320px;
  background: var(--pl-surface);
  color: var(--pl-muted);
}
.m-search:focus-within { border-color: var(--pl-accent); }
.m-search input {
  border: 0;
  background: transparent;
  outline: none;
  flex: 1;
  min-width: 0;
  padding: 6px 0;
  color: var(--pl-text);
}
.m-search kbd {
  font: 11px ui-monospace, monospace;
  border: 1px solid var(--pl-border);
  border-radius: 4px;
  padding: 0 4px;
  color: var(--pl-muted);
}
.m-chiprow { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; min-width: 0; }
.m-sep { width: 1px; align-self: stretch; background: var(--pl-border); margin: 4px 2px; }
.m-custom { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; font-size: 12.5px; }
.m-custom input {
  border: 1px solid var(--pl-border);
  border-radius: 8px;
  padding: 4px 8px;
  background: var(--pl-surface);
  color-scheme: light dark;
}
@container pl-app (max-width: 559px) {
  .m-filters { padding: 10px 12px; }
  .m-search { max-width: none; flex-basis: 100%; min-height: 40px; }
  .m-search kbd, .m-sep { display: none; }
  .m-chiprow { flex-wrap: nowrap; overflow-x: auto; flex: 1 1 100%; padding-bottom: 2px; }
  .m-chiprow .pl-chips { flex-wrap: nowrap; }
}

/* Ledger table (≥560px) */
.m-ledger { width: 100%; border-collapse: collapse; }
.m-ledger caption { text-align: left; padding: 0 20px 6px; font-size: 12px; color: var(--pl-muted); }
.m-ledger thead th {
  text-align: left;
  font-size: 11.5px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  color: var(--pl-muted);
  padding: 6px 12px;
  border-bottom: 1px solid var(--pl-hair);
}
.m-ledger th:first-child, .m-ledger td:first-child { padding-left: 20px; }
.m-ledger th:last-child, .m-ledger td:last-child { padding-right: 20px; text-align: right; }
.m-ledger .m-day th {
  text-align: left;
  padding: 14px 20px 6px 20px;
  font-size: 12.5px;
  font-weight: 650;
  border-bottom: 1px solid var(--pl-hair);
}
.m-ledger .m-day th span { float: right; font-weight: 500; color: var(--pl-muted); }
.m-ledger td { padding: 9px 12px; border-bottom: 1px solid var(--pl-hair); vertical-align: top; }
.m-ledger tr.m-row { cursor: pointer; }
.m-ledger tr.m-row:hover td { background: var(--pl-tint); }
.m-ledger tr.m-row[aria-selected='true'] td { background: var(--pl-accent-soft); }
.m-ledger tr.m-row[aria-selected='true'] td:first-child { box-shadow: inset 3px 0 0 var(--pl-accent); }
.m-rowbtn {
  all: unset;
  box-sizing: border-box;
  display: block;
  width: 100%;
  cursor: pointer;
  border-radius: 4px;
}
.m-rowbtn:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: 3px; }
.m-desc b { font-weight: 600; display: block; overflow-wrap: anywhere; }
.m-desc .m-rest {
  color: var(--pl-muted);
  font-size: 12.5px;
  display: block;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 46ch;
}
.m-cat {
  display: inline-block;
  font-size: 12px;
  padding: 1px 8px;
  border-radius: 6px;
  background: var(--pl-tint);
  border: 1px solid var(--pl-border);
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.m-cat[data-none] { color: var(--pl-muted); border-style: dashed; background: transparent; }
.m-acctcell { color: var(--pl-muted); font-size: 12.5px; white-space: nowrap; font-variant-numeric: tabular-nums; }
.m-more { padding: 14px 20px; display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }

/* Ledger list (<560px) */
.m-list { list-style: none; margin: 0; padding: 0; }
.m-list .m-dayh {
  display: flex;
  justify-content: space-between;
  padding: 12px 12px 4px;
  font-size: 12.5px;
  font-weight: 650;
  border-bottom: 1px solid var(--pl-hair);
}
.m-list .m-dayh span { font-weight: 500; color: var(--pl-muted); }
.m-list .m-item {
  all: unset;
  box-sizing: border-box;
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 2px 10px;
  width: 100%;
  padding: 10px 12px;
  min-height: 52px;
  border-bottom: 1px solid var(--pl-hair);
  cursor: pointer;
}
.m-list .m-item:focus-visible { outline: 2px solid var(--pl-accent); outline-offset: -2px; }
.m-list .m-item[aria-current='true'] { background: var(--pl-accent-soft); }
.m-list .m-t { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.m-list .m-s {
  grid-column: 1 / -1;
  font-size: 12.5px;
  color: var(--pl-muted);
  display: flex;
  gap: 6px;
  align-items: center;
  min-width: 0;
}
.m-list .m-s .m-cat { flex: none; }
.m-list .m-s > span:last-child:not(.m-cat) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }

/* Split with the docked detail panel (≥900px) */
.m-split { display: grid; grid-template-columns: minmax(0, 1fr) 360px; }
.m-main { min-width: 0; }
.m-loading { padding: 28px 20px; color: var(--pl-muted); }
.m-pad { padding: 12px 20px; }

/* Detail panel content */
.m-panel-head { display: flex; align-items: flex-start; gap: 8px; padding: 14px 16px 10px; }
.m-grow { flex: 1; display: grid; gap: 2px; min-width: 0; }
.m-big .m-amt {
  font-family: var(--pl-font-header);
  font-size: 1.6rem;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.m-small { font-size: 12.5px; }
.pl-panel section {
  padding: 12px 16px;
  border-top: 1px solid var(--pl-border);
  display: grid;
  gap: 10px;
}
.pl-panel h3 {
  margin: 0;
  font-size: 11.5px;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--pl-muted);
  font-weight: 650;
}
.m-kv {
  display: grid;
  grid-template-columns: 110px minmax(0, 1fr);
  gap: 6px 10px;
  margin: 0;
  font-size: 13px;
}
.m-kv dt { color: var(--pl-muted); }
.m-kv dd { margin: 0; overflow-wrap: anywhere; }
.m-narr {
  margin: 0;
  background: var(--pl-tint);
  border: 1px solid var(--pl-border);
  border-radius: 8px;
  padding: 8px 10px;
}
.m-field { display: grid; gap: 4px; }
.m-field label { font-size: 12.5px; font-weight: 600; }
.m-input {
  border: 1px solid var(--pl-border);
  border-radius: 8px;
  padding: 7px 10px;
  background: var(--pl-surface);
  width: 100%;
}
.m-input[aria-invalid='true'] { border-color: var(--pl-neg); }
textarea.m-input { min-height: 64px; resize: vertical; }
.m-panel-foot {
  margin-top: auto;
  padding: 10px 16px;
  border-top: 1px solid var(--pl-border);
  font-size: 12.5px;
  display: flex;
  gap: 8px;
  align-items: center;
  min-height: 48px;
}
.m-saved::before { content: '✓ '; color: var(--pl-pos); }
.m-sheetbar {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 6px;
  border-bottom: 1px solid var(--pl-hair);
}
.m-sheetbar strong { flex: 1; font-size: 14px; }
.pl-panel[data-mode='side'] {
  position: sticky;
  top: 0;
  align-self: start;
  min-height: 0;
  max-height: 100vh;
  overflow-y: auto;
}
.pl-panel .pl-banner { padding: 8px 10px; }

/* First run */
.m-drop {
  justify-self: stretch;
  justify-items: center;
  border: 1.5px dashed color-mix(in oklab, var(--pl-accent) 45%, var(--pl-surface));
  border-radius: var(--pl-radius);
  padding: 22px;
  display: grid;
  gap: 10px;
  background: color-mix(in oklab, var(--pl-accent) 4%, var(--pl-surface));
}
.m-drop .m-formats { font-size: 12.5px; color: var(--pl-muted); }
details.m-help { font-size: 13px; text-align: left; justify-self: stretch; }
details.m-help summary { cursor: pointer; color: var(--pl-accent); font-weight: 600; }
details.m-help ul { margin: 8px 0 0; padding-left: 18px; display: grid; gap: 4px; }
.m-sources-mini { justify-self: stretch; text-align: left; display: grid; gap: 8px; margin-top: 8px; }
.m-src {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border: 1px solid var(--pl-border);
  border-radius: var(--pl-radius);
  flex-wrap: wrap;
}
.m-src .m-name { font-weight: 600; }
.m-src .m-grow { flex: 1; min-width: 160px; }
.m-src .m-why { font-size: 12.5px; color: var(--pl-muted); display: block; }
.m-logo {
  width: 28px;
  height: 28px;
  border-radius: 7px;
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 12px;
  background: var(--pl-tint);
  border: 1px solid var(--pl-border);
  flex: none;
}
.m-tag {
  display: inline-block;
  font-size: 11px;
  padding: 0 6px;
  border-radius: 4px;
  border: 1px solid var(--pl-border);
  color: var(--pl-muted);
  margin-left: 6px;
  vertical-align: 1px;
  font-weight: 500;
}
.m-sources { padding: 16px 20px; display: grid; gap: 10px; }
.m-dropping::after {
  content: 'Drop to check this statement';
  position: fixed;
  inset: 8px;
  z-index: 40;
  display: grid;
  place-items: center;
  border: 2px dashed var(--pl-accent);
  border-radius: var(--pl-radius);
  background: color-mix(in oklab, var(--pl-accent-soft) 88%, transparent);
  color: var(--pl-accent-ink);
  font-weight: 650;
  font-size: 15px;
}
`;
