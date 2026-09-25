// @wc-ignore-file
/**
 * Notion-specific styles (`nt-*`): toolbar, table, option pills in Notion's
 * ten colours, first-import progress, side peek, board, list and sync
 * details. From mockups.html's "PLUGIN CSS" block (#89); the "later"
 * two-way rules (S15, S16) are left out until that work starts.
 */
export const NT_CSS = `
.nt-toolbar{display:flex;align-items:center;flex-wrap:wrap;gap:8px 12px;padding:10px 16px}
.nt-seg{display:inline-flex;padding:2px;border:1px solid var(--pl-hair);border-radius:8px;background:var(--pl-surface)}
.nt-seg button{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 10px;border:0;border-radius:6px;background:none;color:var(--pl-muted);font:inherit;font-size:13px;cursor:pointer}
.nt-seg button .ic{width:14px;height:14px}
.nt-seg button[aria-pressed='true']{background:var(--pl-subtle);color:var(--pl-text);font-weight:600}
.nt-seg button[disabled]{opacity:0.4;cursor:not-allowed}
.nt-search{position:relative;flex:1 1 180px;max-width:280px;display:flex}
.nt-search .ic{position:absolute;left:9px;top:7px;width:15px;height:15px;color:var(--pl-muted)}
.nt-search input{width:100%;height:30px;padding:0 10px 0 30px;border:1px solid var(--pl-hair);border-radius:8px;background:var(--pl-surface);color:var(--pl-text);font:inherit;font-size:13px}
.nt-sortlabel{font-size:12.5px;color:var(--pl-muted)}
.nt-sortlabel b{color:var(--pl-text);font-weight:600}
.nt-count{margin-left:auto;font-size:12.5px;color:var(--pl-muted);font-variant-numeric:tabular-nums}
.nt-tablewrap{flex:1;min-height:0;overflow:auto;margin:0 16px 16px;border:1px solid var(--pl-hair);border-radius:var(--pl-radius);background:var(--pl-surface)}
.nt-table{border-collapse:separate;border-spacing:0;width:100%;font-size:13px}
.nt-table th{position:sticky;top:0;z-index:1;background:var(--pl-subtle);text-align:left;font-weight:600;color:var(--pl-muted);border-bottom:1px solid var(--pl-hair);padding:0;white-space:nowrap}
.nt-th{display:flex;align-items:center;gap:6px;width:100%;padding:7px 10px;border:0;background:none;color:inherit;font:inherit;cursor:pointer}
.nt-table th.num .nt-th{justify-content:flex-end}
.nt-th .ic{width:14px;height:14px;opacity:0.8}
.nt-sortmark{display:inline-flex;color:var(--pl-accent)}
.nt-table td{padding:6px 10px;height:36px;border-bottom:1px solid var(--pl-hair);white-space:nowrap;max-width:300px;overflow:hidden;text-overflow:ellipsis;vertical-align:middle}
.nt-table tr:last-child td{border-bottom:0}
.nt-table td:first-child,.nt-table th:first-child{position:sticky;left:0}
.nt-table th:first-child{z-index:2}
.nt-table td:first-child{background:var(--pl-surface);font-weight:600;border-right:1px solid var(--pl-hair)}
.nt-table tbody tr{cursor:pointer}
.nt-table tbody tr:hover td{background:var(--pl-subtle)}
.nt-table tbody tr[aria-selected='true'] td{background:var(--pl-accent-soft)}
.nt-table td.num{text-align:right;font-variant-numeric:tabular-nums}
.nt-muted{color:var(--pl-muted)}
.nt-title span{overflow:hidden;text-overflow:ellipsis}
.nt-flash td{background:color-mix(in srgb,var(--pl-accent) 10%,var(--pl-surface)) !important}
.nt-bool{text-align:center}
.nt-yes{display:inline-flex;color:var(--pl-pos)}
.nt-no{display:inline-flex;color:var(--pl-muted);opacity:0.6;vertical-align:middle}
.nt-link{color:var(--pl-accent);text-decoration:none}
.nt-link:hover{text-decoration:underline}
.nt-dbname{display:inline-flex;align-items:center;gap:6px;color:var(--pl-muted)}
.nt-tag{--hue:#9b9a97;display:inline-flex;align-items:center;gap:5px;height:21px;padding:0 7px;border-radius:5px;font-size:12px;line-height:1;white-space:nowrap;color:var(--pl-text);background:color-mix(in srgb,var(--hue) 22%,var(--pl-surface))}
.nt-status{border-radius:999px;padding:0 9px 0 7px}
.nt-status::before{content:'';width:7px;height:7px;border-radius:50%;background:var(--hue)}
.nt-tags{display:inline-flex;gap:4px;flex-wrap:nowrap}
.c-default{--hue:#a5a29d}
.c-gray{--hue:#8f8d88}
.c-brown{--hue:#a27456}
.c-orange{--hue:#d9730d}
.c-yellow{--hue:#cb912f}
.c-green{--hue:#448361}
.c-blue{--hue:#337ea9}
.c-purple{--hue:#9065b0}
.c-pink{--hue:#c14c8a}
.c-red{--hue:#d44c47}
.nt-import{padding:18px 16px 10px;max-width:620px}
.nt-import h2{margin:0 0 4px;font:700 16px/1.3 var(--t-font-family-header,system-ui)}
.nt-import>p{margin:0 0 12px;color:var(--pl-muted);font-size:13px}
.nt-progress{list-style:none;margin:0;padding:0;border:1px solid var(--pl-hair);border-radius:var(--pl-radius);background:var(--pl-surface)}
.nt-progress li{display:grid;grid-template-columns:18px 1fr auto;gap:4px 10px;align-items:center;padding:10px 12px;border-bottom:1px solid var(--pl-hair);color:var(--pl-muted)}
.nt-progress li:last-child{border-bottom:0}
.nt-progress li.is-done,.nt-progress li.is-active{color:var(--pl-text)}
.nt-p-name{font-weight:600}
.nt-p-state{display:inline-flex;align-items:center;gap:6px;font-size:12.5px;color:var(--pl-muted);font-variant-numeric:tabular-nums}
.nt-p-state .ic.ok{color:var(--pl-pos)}
.nt-bar{grid-column:2/4;height:4px;border-radius:2px;background:var(--pl-subtle);overflow:hidden}
.nt-bar span{display:block;height:100%;background:var(--pl-accent)}
.nt-skel{margin-top:14px;padding:6px 0;flex:1}
.nt-skel-row{display:flex;gap:24px;padding:12px 12px;border-bottom:1px solid var(--pl-hair)}
.nt-skel-row span{height:10px;border-radius:5px;background:var(--pl-subtle)}
.nt-split{flex:1;min-height:0;display:grid;grid-template-columns:minmax(0,1fr) 400px;gap:0}
.nt-split .nt-tablewrap{margin-right:0;border-top-right-radius:0;border-bottom-right-radius:0}
.nt-peek{min-height:0;overflow:auto;margin:0 16px 16px 0;padding:10px 18px 18px;background:var(--pl-surface);border:1px solid var(--pl-hair);border-left-color:var(--pl-border);border-radius:0 var(--pl-radius) var(--pl-radius) 0;box-shadow:-8px 0 16px -12px rgba(0,0,0,0.25)}
.nt-peek-bar{display:flex;align-items:center;gap:2px;margin:0 -8px 8px}
.nt-peek-db{display:flex;align-items:center;gap:6px;margin:6px 0 2px;color:var(--pl-muted);font-size:12.5px}
.nt-peek h3{margin:0 0 14px;font:700 20px/1.25 var(--t-font-family-header,system-ui);text-wrap:balance}
.nt-props{display:grid;grid-template-columns:130px 1fr;gap:10px 12px;margin:0 0 16px;font-size:13px}
.nt-props dt{display:flex;align-items:center;gap:7px;color:var(--pl-muted)}
.nt-props dt .ic{width:14px;height:14px}
.nt-props dd{margin:0;display:flex;align-items:center;gap:6px;min-width:0;overflow-wrap:anywhere}
.nt-skipped{border-top:1px solid var(--pl-hair);padding-top:12px;margin-bottom:12px}
.nt-skipped-h{display:flex;align-items:center;gap:6px;margin:0 0 8px;font-size:12.5px;font-weight:600;color:var(--pl-muted)}
.nt-skipped ul{list-style:none;margin:0;padding:0;display:grid;gap:5px;font-size:13px}
.nt-skipped li{display:flex;align-items:center;gap:7px;color:var(--pl-muted)}
.nt-skipped li span{margin-left:auto;font-size:12px;opacity:0.85}
.nt-fine{margin:8px 0 0;font-size:12.5px;color:var(--pl-muted)}
.nt-fine a{color:var(--pl-accent)}
.nt-readonly{display:flex;gap:7px;align-items:flex-start;margin:0;padding:9px 11px;border-radius:8px;background:var(--pl-subtle);font-size:12.5px;color:var(--pl-muted)}
.nt-readonly .ic{margin-top:2px}
.nt-board{flex:1;min-height:0;display:grid;grid-auto-flow:column;grid-auto-columns:minmax(250px,1fr);gap:12px;overflow:auto;padding:0 16px 16px;align-items:start}
.nt-col{background:color-mix(in srgb,var(--pl-subtle) 70%,transparent);border-radius:var(--pl-radius);padding:8px}
.nt-col h3{display:flex;align-items:center;gap:8px;margin:2px 4px 8px;font-size:13px}
.nt-col ul{list-style:none;margin:0;padding:0;display:grid;gap:6px}
.nt-card{display:grid;gap:8px;width:100%;text-align:left;padding:10px 11px;border:1px solid var(--pl-hair);border-radius:8px;background:var(--pl-surface);color:var(--pl-text);font:inherit;cursor:pointer;box-shadow:0 1px 1px rgba(0,0,0,0.04)}
.nt-card:hover{border-color:var(--pl-border)}
.nt-card-t{font-weight:600;font-size:13.5px;line-height:1.35}
.nt-card-m{display:flex;flex-wrap:wrap;gap:4px;align-items:center}
.nt-pts{margin-left:auto;font-size:12px;color:var(--pl-muted);font-variant-numeric:tabular-nums}
.nt-list{list-style:none;margin:0 12px 12px;padding:0;border:1px solid var(--pl-hair);border-radius:var(--pl-radius);background:var(--pl-surface);overflow:auto;flex:1}
.nt-list li + li{border-top:1px solid var(--pl-hair)}
.nt-li{display:grid;gap:6px;width:100%;min-height:44px;padding:11px 12px;border:0;background:none;text-align:left;color:var(--pl-text);font:inherit;cursor:pointer}
.nt-li-t{font-weight:600}
.nt-li-m{display:flex;gap:4px;flex-wrap:wrap}
.nt-li-s{font-size:12px;color:var(--pl-muted)}
.nt-overlay-host{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.nt-details{position:absolute;top:-46px;right:16px;width:min(440px,calc(100% - 32px));max-height:calc(100% + 30px);overflow:auto;z-index:5;background:var(--pl-surface);border:1px solid var(--pl-border);border-radius:var(--pl-radius);box-shadow:var(--t-box-shadow-intense,0 8px 30px rgba(0,0,0,0.2));padding:14px 16px;font-size:13px}
.nt-details-h{display:flex;justify-content:space-between;gap:10px;margin-bottom:10px}
.nt-details-h span{color:var(--pl-muted);font-size:12.5px}
.nt-details-dbs{list-style:none;margin:0;padding:0;display:grid;gap:12px}
.nt-details-dbs li{display:grid;gap:3px;padding-top:12px;border-top:1px solid var(--pl-hair)}
.nt-details-dbs p{margin:0}
.nt-d-name{display:flex;align-items:center;gap:6px;font-weight:600}
.nt-d-counts{color:var(--pl-muted);font-variant-numeric:tabular-nums}
.nt-d-counts b{color:var(--pl-text)}
.nt-d-skip{color:var(--pl-muted)}
.nt-d-skip span{color:var(--pl-text)}
.nt-d-warn{display:flex;gap:6px;align-items:flex-start;color:var(--pl-text)}
.nt-d-warn .ic{margin-top:3px;color:color-mix(in srgb,var(--pl-warn) 75%,var(--pl-text))}
.nt-tech{margin-top:10px;font-size:12px;color:var(--pl-muted)}
.nt-tech summary{cursor:pointer}
.nt-tech pre{margin:6px 0 0;padding:8px 10px;border-radius:6px;background:var(--pl-subtle);white-space:pre-wrap;font:11.5px/1.5 ui-monospace,Menlo,monospace}
.nt-peek.is-sheet{margin:0;border:0;border-radius:0;box-shadow:none;flex:1;padding:12px 16px 20px}
.nt-peek.is-sheet .nt-props{grid-template-columns:112px 1fr}
.nt-main{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.nt-content{position:relative;flex:1;min-height:0;display:flex;flex-direction:column}
.nt-peek.is-overlay{position:absolute;top:0;right:16px;bottom:16px;width:min(400px,90%);margin:0;z-index:4;border-radius:var(--pl-radius);box-shadow:var(--t-box-shadow-intense,0 8px 30px rgba(0,0,0,0.2))}
.nt-sheet{position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:var(--pl-surface);color:var(--pl-text);display:flex;flex-direction:column}
.nt-sheet::backdrop{background:transparent}
.nt-sheet .nt-peek{overflow:auto}
.nt-peek-bar .pl-spacer{flex:1}
.nt-table tbody tr:focus-visible{outline:2px solid var(--pl-accent);outline-offset:-2px}
.nt-table th[aria-sort] .nt-th{color:var(--pl-text)}
.nt-more{display:flex;justify-content:center;padding:10px}
.nt-flash td{transition:background 1.2s ease}
.nt-empty-row{padding:24px 16px;text-align:center;color:var(--pl-muted);font-size:13px}
.nt-bar.is-indeterminate span{width:35%;animation:nt-slide 1.4s ease-in-out infinite}
@keyframes nt-slide{from{transform:translateX(-100%)}to{transform:translateX(300%)}}
.nt-sortlabel select{height:26px;margin-left:2px;padding:0 4px;border:1px solid var(--pl-hair);border-radius:6px;background:var(--pl-surface);color:var(--pl-text);font:inherit;font-weight:600}
.nt-details{top:4px}
.nt-details-general{margin-top:12px;display:grid;gap:4px}
.nt-list .nt-dbname{font-size:12px}
.nt-li[aria-current='true']{background:var(--pl-accent-soft)}
.nt-card[aria-current='true']{border-color:var(--pl-accent)}
@container pl-app (max-width:639.98px){.nt-toolbar{padding:10px 12px}.nt-search{flex-basis:100%;max-width:none;order:3}.nt-tablewrap{margin:0 12px 12px}.nt-board{padding:0 12px 12px}.nt-sortlabel{display:none}.nt-seg button{height:36px}.nt-li{min-height:44px}}
@media (prefers-reduced-motion:reduce){.nt-flash td{background:inherit;transition:none}.nt-bar.is-indeterminate span{animation:none;width:100%;opacity:0.4}}
`;
