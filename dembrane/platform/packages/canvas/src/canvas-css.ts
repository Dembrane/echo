/** The tabbed canvas stylesheet, byte for byte what the Python renderer inlined. */
export const CANVAS_CSS = `
:root{--parchment:#F6F4F1;--card:#FFFFFF;--ink:#2D2D2C;--ink-soft:#6E6B66;--royal:#4169E1;--hairline:#E6E3DF;--amber:#FFD166}
.tabbed-canvas{font-family:"DM Sans",system-ui,sans-serif;color:var(--ink);background:var(--parchment)}
.tabbed-canvas-frame{padding:14px 26px 80px}
.tabbed-canvas-kicker{margin:0 0 10px;font-size:11px;font-weight:600;letter-spacing:.09em;text-transform:uppercase;color:var(--royal)}
.tabbed-canvas-notice{border:1px solid var(--amber);background:rgba(255,209,102,.35);padding:12px 13px;margin:0 0 14px}
.tabbed-canvas-radio{position:absolute;opacity:0;pointer-events:none}
.tabbed-canvas-tabbar{display:flex;align-items:end;border-bottom:1px solid var(--hairline);gap:26px;margin:0 0 26px}
.tabbed-canvas-tab{font-size:14.5px;font-weight:500;color:var(--ink-soft);border-bottom:2px solid transparent;padding:10px 2px;cursor:pointer;text-decoration:none}
.tabbed-canvas-tab-link{display:none}
.tabbed-canvas-add{margin-left:auto;color:var(--royal);font-size:22px;line-height:1.6;text-decoration:none}
.tabbed-canvas-panel{display:none}
#canvas-tab-crux:checked~.tabbed-canvas-tabbar label[for=canvas-tab-crux],
#canvas-tab-concept_cloud:checked~.tabbed-canvas-tabbar label[for=canvas-tab-concept_cloud],
#canvas-tab-story:checked~.tabbed-canvas-tabbar label[for=canvas-tab-story],
#canvas-tab-host_guide:checked~.tabbed-canvas-tabbar label[for=canvas-tab-host_guide],
#canvas-tab-trace:checked~.tabbed-canvas-tabbar label[for=canvas-tab-trace],
#canvas-tab-audit:checked~.tabbed-canvas-tabbar label[for=canvas-tab-audit],
#canvas-tab-board_person:checked~.tabbed-canvas-tabbar label[for=canvas-tab-board_person]{color:var(--ink);border-bottom-color:var(--royal)}
#canvas-tab-crux:checked~[data-tab-panel=crux],
#canvas-tab-concept_cloud:checked~[data-tab-panel=concept_cloud],
#canvas-tab-story:checked~[data-tab-panel=story],
#canvas-tab-host_guide:checked~[data-tab-panel=host_guide],
#canvas-tab-trace:checked~[data-tab-panel=trace],
#canvas-tab-audit:checked~[data-tab-panel=audit],
#canvas-tab-board_person:checked~[data-tab-panel=board_person]{display:block}
@supports selector(:has(*)){
.tabbed-canvas-tab-fallback{display:none}
.tabbed-canvas-tab-link{display:inline-block}
.tabbed-canvas:has(.tabbed-canvas-panel:target) .tabbed-canvas-panel{display:none}
.tabbed-canvas:has(.tabbed-trace-entry:target) .tabbed-canvas-panel{display:none}
.tabbed-canvas .tabbed-canvas-panel:target{display:block}
.tabbed-canvas:has(.tabbed-trace-entry:target) [data-tab-panel=trace]{display:block}
.tabbed-canvas:has(#tab-crux:target) .tabbed-canvas-tab-link[href="#tab-crux"],
.tabbed-canvas:has(#tab-concept_cloud:target) .tabbed-canvas-tab-link[href="#tab-concept_cloud"],
.tabbed-canvas:has(#tab-story:target) .tabbed-canvas-tab-link[href="#tab-story"],
.tabbed-canvas:has(#tab-host_guide:target) .tabbed-canvas-tab-link[href="#tab-host_guide"],
.tabbed-canvas:has(#tab-trace:target) .tabbed-canvas-tab-link[href="#tab-trace"],
.tabbed-canvas:has(.tabbed-trace-entry:target) .tabbed-canvas-tab-link[href="#tab-trace"],
.tabbed-canvas:has(#tab-audit:target) .tabbed-canvas-tab-link[href="#tab-audit"],
.tabbed-canvas:has(#tab-board_person:target) .tabbed-canvas-tab-link[href="#tab-board_person"]{color:var(--ink);border-bottom-color:var(--royal)}
}
.tabbed-crux{max-width:1000px;min-height:70vh;margin:0 auto;display:flex;flex-direction:column;justify-content:center}
.tabbed-story{max-width:1000px;margin:0 auto}
.tabbed-story-stack{display:grid;gap:30px}
.tabbed-story-slide{min-height:80vh;display:flex;flex-direction:column;justify-content:center;gap:24px}
.tabbed-story-slide h3{max-width:900px;margin:0;font-size:clamp(32px,4.6vw,48px);font-weight:500;letter-spacing:-.015em;line-height:1.12;text-wrap:balance}
.tabbed-story-evidence,.tabbed-story-slide .tabbed-slide-trace{max-width:620px}
.tabbed-host-guide{max-width:840px;min-height:70vh;margin:0 auto;display:flex;flex-direction:column;justify-content:center;gap:16px}
.tabbed-crux h1,.tabbed-story h2{max-width:900px;margin:0;font-weight:500;line-height:1.14;text-wrap:balance}
.tabbed-crux h1{font-size:clamp(32px,4.6vw,48px)}
.tabbed-story h2{font-size:clamp(24px,3.4vw,36px);letter-spacing:-.01em}
.tabbed-canvas-lede{max-width:620px;font-size:16px;line-height:1.45;color:var(--ink-soft)}
.tabbed-canvas-lede b{color:var(--ink);font-weight:500}
.tabbed-cloud{max-width:1060px;margin:0 auto;display:flex;flex-wrap:wrap;gap:12px;align-items:center;justify-content:center;padding:30px 0}
.tabbed-concept{background:var(--card);border:1px solid var(--hairline);padding:12px 13px;animation:tabbedFloat 7s ease-in-out infinite}
.tabbed-concept summary{list-style:none;cursor:pointer}
.tabbed-concept summary::-webkit-details-marker{display:none}
.tabbed-concept-xl{font-size:clamp(24px,2.8vw,34px);font-weight:600}
.tabbed-concept-l{font-size:22px;font-weight:500}
.tabbed-concept-m{font-size:16px;font-weight:500}
.tabbed-concept-s{font-size:12px;font-weight:400}
.tabbed-tilt-neg{transform:rotate(-1.2deg)}
.tabbed-tilt-pos{transform:rotate(1.2deg)}
.tabbed-traceable{border-bottom:1px dotted var(--royal)}
.tabbed-trace{margin-top:12px;max-width:520px}
.tabbed-quote{margin:12px 0;padding:15px 18px;border:1px solid var(--hairline);border-left:3px solid var(--royal);background:var(--card)}
.tabbed-quote p{margin:0;font-size:14px;line-height:1.45}
.tabbed-quote footer,.tabbed-host-item footer{margin-top:8px;font-size:11px;color:var(--ink-soft);font-variant-numeric:tabular-nums}
.tabbed-host-items{margin-top:22px;display:grid;gap:12px}
.tabbed-host-item{border:1px solid var(--hairline);border-left:3px solid var(--royal);background:var(--card);padding:15px 18px}
.tabbed-host-item p{margin:0;white-space:pre-wrap}
.tabbed-guide-block{border:1px solid var(--hairline);background:var(--card);padding:16px 18px}
.tabbed-guide-block h3{margin:0 0 10px;font-size:16px;font-weight:600}
.tabbed-guide-block p{margin:0;color:var(--ink-soft);line-height:1.45}
.tabbed-guide-block ol,.tabbed-guide-block ul{margin:0;padding-left:20px;color:var(--ink-soft);line-height:1.45}
.tabbed-guide-block li+li{margin-top:8px}
.tabbed-open-orient{margin:0;color:var(--ink-soft);font-size:16px;line-height:1.45;max-width:620px}
.tabbed-board{display:grid;grid-template-columns:repeat(5,minmax(0,1fr));gap:9px;align-items:stretch}
.tabbed-board-card{background:var(--card);border:1px solid var(--hairline);padding:12px 13px;min-height:150px;display:flex;flex-direction:column;gap:8px}
.tabbed-board-card h3{margin:0;font-size:14px;font-weight:700;line-height:1.2;color:var(--ink)}
.tabbed-board-card p{margin:0;font-size:13px;line-height:1.35;color:var(--ink-soft)}
.tabbed-board-trace{margin-top:auto}
.tabbed-board-trace summary{list-style:none;cursor:pointer;font-size:12px}
.tabbed-board-trace summary::-webkit-details-marker{display:none}
.tabbed-trace-room{max-width:780px;margin:0 auto;display:grid;gap:24px}
.tabbed-trace-entry{scroll-margin-top:24px}
.tabbed-trace-entry:target{outline:2px solid var(--royal);outline-offset:12px}
.tabbed-trace-entry h2{margin:0;font-size:clamp(28px,4vw,44px);font-weight:500;line-height:1.12;text-wrap:balance}
.tabbed-trace-cards{margin-top:18px}
.tabbed-audit{max-width:900px;margin:0 auto;display:grid;gap:12px}
.tabbed-audit-entry{background:var(--card);border:1px solid var(--hairline);padding:13px 15px}
.tabbed-audit-entry[open]{border-color:var(--royal)}
.tabbed-audit-entry summary{cursor:pointer;font-variant-numeric:tabular-nums;color:var(--ink)}
.tabbed-audit-body{margin-top:12px;color:var(--ink-soft);line-height:1.45}
.tabbed-audit-body p{margin:8px 0}
.tabbed-audit-body ul{margin:6px 0 0;padding-left:20px}
.tabbed-audit-link{color:var(--royal)}
.tabbed-canvas-empty{color:var(--ink-soft)}
@keyframes tabbedFloat{0%,100%{translate:0 0}50%{translate:0 -5px}}
@media (prefers-reduced-motion:reduce){.tabbed-concept{animation:none}}
@media (max-width:1100px){.tabbed-board{grid-template-columns:repeat(3,minmax(0,1fr))}}
@media (max-width:720px){.tabbed-canvas-frame{padding:14px 14px 60px}.tabbed-canvas-tabbar{gap:16px}.tabbed-crux,.tabbed-story-slide,.tabbed-host-guide{min-height:58vh}.tabbed-board{grid-template-columns:1fr}}
`;
