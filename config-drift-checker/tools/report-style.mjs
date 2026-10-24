// report-style: the look shared by the public pages (the release report and the harness diff pages):
// one stylesheet with light and dark tokens, and the HTML escaper every page uses for text from outside.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const CSS = `
:root{--paper:#F3F5F8;--surface:#FFFFFF;--ink:#111827;--muted:#5F6B7A;--rule:#DCE1E8;--code:#EEF1F5;--pass:#1E7A4D;--pass-bg:#E3F3EA;--fail:#C1382C;--fail-bg:#FAE6E3;--warn:#A8701A;--warn-bg:#FBF0DC;--track:#2E5BD7;--track-bg:#E4EBFB;--shadow:0 1px 2px rgba(17,24,39,.05)}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}}
:root[data-theme="dark"]{--paper:#0E1319;--surface:#161C25;--ink:#E8EDF3;--muted:#97A3B2;--rule:#2A3441;--code:#0B0F14;--pass:#4CC286;--pass-bg:#173124;--fail:#EE7A6C;--fail-bg:#3B1E1B;--warn:#E0B052;--warn-bg:#3A2D14;--track:#7FA0F5;--track-bg:#1B2742;--shadow:none}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:15px/1.5 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;font-feature-settings:"tnum"}
code,.mono{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.88em}
a{color:var(--track);text-decoration:none}a:hover{text-decoration:underline}.wrap{max-width:1080px;margin:0 auto;padding:28px 28px 80px}
.pass{color:var(--pass)}.fail{color:var(--fail)}.warn{color:var(--warn)}.muted{color:var(--muted)}
.eyebrow{font-size:12px;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:0 0 10px}.eyebrow b{color:var(--track);font-weight:600}
h1{font-size:30px;line-height:1.15;letter-spacing:-.02em;margin:0 0 12px;font-weight:600;max-width:30ch}
.lede{font-size:16px;color:var(--muted);margin:0;max-width:70ch}
h2{font-size:12px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);margin:30px 0 10px}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:12px;margin:22px 0}
.tile{background:var(--surface);border:1px solid var(--rule);border-radius:8px;padding:12px 14px;box-shadow:var(--shadow)}
.tile .tl{font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted)}.tile .tb{font-size:26px;font-weight:600;line-height:1.25}
.hist{display:flex;gap:8px;flex-wrap:wrap}.hv{background:var(--surface);border:1px solid var(--rule);border-radius:6px;padding:6px 10px;font-size:12.5px;min-width:120px}.hv b{display:block;font-weight:600}.hv.cur{border-color:var(--track)}
.bar{display:flex;height:6px;border-radius:3px;overflow:hidden;background:var(--code);margin-top:5px}.bar i{display:block;height:100%}.bar .pass{background:var(--pass)}.bar .fail{background:var(--fail)}.bar .warn{background:var(--warn)}.bar .muted{background:var(--muted)}
.note{background:var(--track-bg);border-radius:8px;padding:12px 16px;font-size:14px;margin:18px 0}
.card{background:var(--surface);border:1px solid var(--rule);border-radius:8px;box-shadow:var(--shadow);margin:0 0 14px;overflow:hidden}
.ch{display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:12px 16px;border-bottom:1px solid var(--rule)}
.ch h3{margin:0;font-size:16px;font-weight:600;overflow-wrap:anywhere}.ch .meta{font-size:12.5px;color:var(--muted)}.ch .desc{font-size:13px;color:var(--muted);margin:2px 0 0;max-width:70ch}
.sum{font-size:13px;white-space:nowrap}.sum span{margin-left:10px}
.cases{width:100%;border-collapse:collapse;font-size:13.5px}.cases td{padding:8px 16px;border-top:1px solid var(--rule);vertical-align:top}.cases tr:first-child td{border-top:0}
.cases td.st{white-space:nowrap;width:1%}.cases td.nm{font-weight:500;overflow-wrap:anywhere;width:24%}
.pill{display:inline-block;font-size:11.5px;padding:1px 8px;border-radius:10px;background:var(--code);color:var(--muted)}.pill.pass{background:var(--pass-bg);color:var(--pass)}.pill.fail{background:var(--fail-bg);color:var(--fail)}.pill.warn{background:var(--warn-bg);color:var(--warn)}
.err{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow-wrap:anywhere}.fix{font-size:12.5px;color:var(--muted);margin-top:3px}
details>summary{cursor:pointer;padding:8px 16px;font-size:13px;color:var(--muted)}details[open]>summary{border-bottom:1px solid var(--rule)}
.skip{padding:12px 16px;font-size:13.5px;color:var(--muted)}
.foot{color:var(--muted);font-size:12.5px;margin-top:26px;max-width:80ch}
:focus-visible{outline:2px solid var(--track);outline-offset:2px}
.intro{font-size:14px;color:var(--muted);margin:0 0 12px;max-width:80ch}
.chl{list-style:none;margin:0;padding:0;font-size:13.5px}.chl li{padding:8px 16px;border-top:1px solid var(--rule);overflow-wrap:anywhere}.chl li:first-child{border-top:0}.chl .pill{margin-right:8px}
.chg{padding:10px 16px;border-top:1px solid var(--rule)}.chg:first-of-type{border-top:0}.chg .fl{font-size:13.5px;font-weight:500;margin-bottom:6px;overflow-wrap:anywhere}.chg .fl .muted{font-weight:400}
.ba{display:grid;grid-template-columns:1fr 1fr;gap:10px}.ba>div{background:var(--code);border-radius:6px;padding:8px 10px;font-size:13px;line-height:1.55;white-space:pre-wrap;overflow-wrap:anywhere}.ba .bl{display:block;font-size:11px;letter-spacing:.05em;text-transform:uppercase;color:var(--muted);margin-bottom:3px;white-space:normal}
.bdg{display:flex;gap:10px;align-items:center;flex-wrap:wrap;padding:8px 16px;border-top:1px solid var(--rule)}.bdg img{display:block}.bdg code{flex:1 1 300px;min-width:0;font-size:11.5px;color:var(--muted);overflow-wrap:anywhere;user-select:all}
ins{background:var(--pass-bg);color:var(--pass);text-decoration:none;border-radius:3px;padding:0 1px}del{background:var(--fail-bg);color:var(--fail);border-radius:3px;padding:0 1px}
@media (max-width:700px){.wrap{padding:20px 16px 60px}h1{font-size:24px}.cases td{padding:8px 12px}.cases td.nm{width:auto}.cases tr{display:grid;grid-template-columns:auto 1fr}.cases td.detail{grid-column:1/-1;padding-top:0}.sum span{margin:0 10px 0 0}.ba{grid-template-columns:1fr}.chl li,.chg{padding:8px 12px}}`;
