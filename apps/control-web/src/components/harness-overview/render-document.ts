import type { FreshnessState } from "../../lib/harness-status/contracts";
import { createFixtureProjectionSet } from "../../lib/harness-status/fixtures";
import { HARNESSES, PLANES } from "../../lib/harness-status/taxonomy";

export type HarnessDocumentState = "READY" | "LOADING" | "EMPTY" | "UNAUTHORIZED";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderHarnessOverviewDocument(options: {
  readonly view?: "overview" | "portfolio";
  readonly state?: HarnessDocumentState;
  readonly freshness?: FreshnessState;
} = {}): string {
  const view = options.view ?? "overview";
  const state = options.state ?? "READY";
  const freshness = options.freshness ?? "CURRENT";
  const fixture = createFixtureProjectionSet();
  const title = state === "LOADING" ? "Loading the verified harness projection"
    : state === "EMPTY" ? "No harness demand exists yet."
    : state === "UNAUTHORIZED" ? "The organization view is unavailable."
    : view === "portfolio" ? "Organization harness posture" : fixture.overview.spec.displayName;
  const statusNotice = freshness === "CURRENT" ? "" : `<aside role="alert"><strong>Current health is withheld.</strong> Last verified projection retained. Source state: ${freshness.replaceAll("_", " ")}.</aside>`;
  const harnessNodes = HARNESSES.map((definition, index) => {
    const summary = fixture.overview.spec.harnesses[index]!;
    return `<a role="option" data-onion-node data-route="/harnesses/${definition.id}" href="#/harnesses/${definition.id}" tabindex="${index === 0 ? 0 : -1}" aria-label="${escapeHtml(definition.name)}: ${summary.aggregateState}; ${summary.freshnessState}; ${summary.blockerCount} blockers"><span>${definition.number}</span>${escapeHtml(definition.name)}<small>${summary.aggregateState}</small></a>`;
  }).join("");
  const planeList = PLANES.map((plane) => `<section><h2><a data-route="/planes/${plane.id}" href="#/planes/${plane.id}">${escapeHtml(plane.name)}</a></h2><ul>${plane.harnesses.map((definition) => {
    const summary = fixture.overview.spec.harnesses.find((item) => item.harnessId === definition.id)!;
    return `<li data-state="${summary.aggregateState}" data-selection="${summary.selectionState}"><a data-route="/harnesses/${definition.id}" href="#/harnesses/${definition.id}">${definition.number}. ${escapeHtml(definition.name)} <strong>${summary.aggregateState}</strong><small>${summary.selectionState}; ${summary.installationState}; ${summary.blockerCount} blockers</small></a></li>`;
  }).join("")}</ul></section>`).join("");
  const readyBody = view === "portfolio"
    ? `<p role="note">Synthetic portfolio preview. Production reads require an audited organization:portfolio:view decision.</p><ol><li><a data-route="/organizations/${fixture.overview.spec.organizationId}" href="#/organizations/${fixture.overview.spec.organizationId}">${fixture.overview.spec.displayName} <strong>${fixture.overview.spec.aggregateState}</strong></a></li></ol>`
    : `${statusNotice}<form aria-label="Filter harness status"><label>Aggregate state<select name="state"><option>ALL</option><option>BLOCKED</option><option>READY</option><option>DEGRADED</option></select></label><button type="submit">Apply filters</button><p role="status">Showing 16 of 16 harnesses.</p></form><div class="layout"><div aria-label="Sixteen harnesses arranged by plane" role="listbox">${harnessNodes}</div><div aria-label="Accessible equivalent">${planeList}</div></div>`;
  const body = state === "READY" ? readyBody : state === "LOADING" ? `<div aria-busy="true" role="status">Status structure reserved; no prior health shown.</div>` : state === "EMPTY" ? `<p>Start with business context and data readiness.</p><a href="#/questionnaires">Begin guided setup</a>` : `<p>No organization existence is disclosed.</p><a href="#/organizations">Return to organizations</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness status acceptance</title><style>
  *{box-sizing:border-box}body{margin:0;color:#172126;background:#f4f7f6;font:16px/1.5 system-ui,sans-serif}a{color:#155c55}a:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid #196f68;outline-offset:3px}header,main{width:min(1180px,100%);margin:auto;padding:24px}header{border-bottom:1px solid #cad4d1}h1{max-width:16ch;font-size:clamp(2.2rem,7vw,4.8rem);line-height:1;margin:42px 0 26px}.layout{display:grid;grid-template-columns:1fr 1fr;gap:40px}[role=listbox]{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}[role=option]{min-height:52px;padding:8px;display:grid;grid-template-columns:26px 1fr;background:#fff;border:1px solid #b7c3bf;text-decoration:none}[role=option] span{grid-row:span 2}[role=option] small,li small{display:block;color:#5d6a6f}li[data-hidden=true]{display:none}aside,[role=note]{padding:12px;border-left:4px solid #196f68;background:#e7efed}form{display:flex;gap:12px;align-items:end;margin:28px 0}label{display:grid;gap:4px}select,button{min-height:44px;padding:8px}ul{padding-left:22px}li{padding:7px 0}@media(max-width:720px){header,main{padding:16px}.layout{grid-template-columns:1fr}[role=listbox]{display:none}form{align-items:stretch;flex-direction:column}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style></head><body><header><strong>Planeon · Harness control</strong></header><main id="main-content"><p>Organization harness status</p><h1>${escapeHtml(title)}</h1>${body}</main><script>
  const nodes=[...document.querySelectorAll('[data-onion-node]')];nodes.forEach((node,index)=>node.addEventListener('keydown',event=>{let next=index;if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%nodes.length;else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index-1+nodes.length)%nodes.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=nodes.length-1;else return;event.preventDefault();nodes.forEach((item,itemIndex)=>item.tabIndex=itemIndex===next?0:-1);nodes[next].focus()}));
  const form=document.querySelector('form');if(form)form.addEventListener('submit',event=>{event.preventDefault();const value=form.elements.state.value;const items=[...document.querySelectorAll('li[data-state]')];items.forEach(item=>item.dataset.hidden=value!=='ALL'&&item.dataset.state!==value?'true':'false');const count=items.filter(item=>item.dataset.hidden!=='true').length;form.querySelector('[role=status]').textContent='Showing '+count+' of 16 harnesses.';location.hash='/overview?state='+encodeURIComponent(value)});
  </script></body></html>`;
}
