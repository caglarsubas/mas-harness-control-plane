import type { FreshnessState } from "../../lib/harness-status/contracts";
import { createFixtureProjectionSet } from "../../lib/harness-status/fixtures";
import { HARNESSES, PLANES } from "../../lib/harness-status/taxonomy";

export type HarnessDocumentState = "READY" | "LOADING" | "EMPTY" | "UNAUTHORIZED";

function escapeHtml(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function shortDigest(value: string): string {
  return `${value.slice(0, 15)}…${value.slice(-8)}`;
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
    return `<a data-onion-node data-route="/harnesses/${definition.id}" href="#/harnesses/${definition.id}" aria-label="${escapeHtml(definition.name)}: ${summary.aggregateState}; ${summary.freshnessState}; ${summary.blockerCount} blockers; matches current filters"><span>${definition.number}</span>${escapeHtml(definition.name)}<small>${summary.aggregateState}</small></a>`;
  }).join("");
  const planeList = PLANES.map((plane) => `<section><h2><a data-route="/planes/${plane.id}" href="#/planes/${plane.id}">${escapeHtml(plane.name)}</a></h2><ul>${plane.harnesses.map((definition) => {
    const summary = fixture.overview.spec.harnesses.find((item) => item.harnessId === definition.id)!;
    return `<li data-state="${summary.aggregateState}" data-selection="${summary.selectionState}"><a data-route="/harnesses/${definition.id}" href="#/harnesses/${definition.id}">${definition.number}. ${escapeHtml(definition.name)} <strong>${summary.aggregateState}</strong><small>${summary.selectionState}; ${summary.installationState}; ${summary.blockerCount} blockers</small></a></li>`;
  }).join("")}</ul></section>`).join("");
  const readyBody = view === "portfolio"
    ? `<p role="note">Synthetic portfolio preview. Production reads require an audited organization:portfolio:view decision.</p><ol><li><a data-route="/organizations/${fixture.overview.spec.organizationId}" href="#/organizations/${fixture.overview.spec.organizationId}">${fixture.overview.spec.displayName} <strong>${fixture.overview.spec.aggregateState}</strong></a></li></ol>`
    : `${statusNotice}<section class="bindings" aria-label="Immutable projection bindings"><code aria-label="Full profile digest: ${fixture.overview.binding!.profileDigest}">${shortDigest(fixture.overview.binding!.profileDigest)}</code><code aria-label="Full bundle digest: ${fixture.overview.binding!.bundleDigest}">${shortDigest(fixture.overview.binding!.bundleDigest)}</code><code aria-label="Full release digest: ${fixture.overview.binding!.releaseDigest}">${shortDigest(fixture.overview.binding!.releaseDigest)}</code></section><form aria-label="Filter harness status"><label>Aggregate state<select name="state"><option>ALL</option><option>BLOCKED</option><option>READY</option><option>DEGRADED</option></select></label><button type="submit">Apply filters</button><p role="status">Showing 16 of 16 harnesses.</p></form><div class="layout"><nav aria-label="Sixteen harnesses arranged by plane" data-onion-navigation="true">${harnessNodes}</nav><div aria-label="Accessible equivalent">${planeList}</div></div>`;
  const body = state === "READY" ? readyBody : state === "LOADING" ? `<div aria-busy="true" role="status">Status structure reserved; no prior health shown.</div>` : state === "EMPTY" ? `<p>Start with business context and data readiness.</p><a href="#/questionnaires">Begin guided setup</a>` : `<p>No organization existence is disclosed.</p><a href="#/organizations">Return to organizations</a>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Harness status acceptance</title><style>
  *{box-sizing:border-box}:root{color-scheme:light dark;--ink:oklch(25% .018 190);--paper:oklch(97% .008 180);--surface:oklch(99% .005 180);--line:oklch(84% .014 180);--accent:oklch(47% .09 182);--accent-surface:oklch(92% .025 180);--muted:oklch(48% .018 190)}body{margin:0;color:var(--ink);background:var(--paper);font:16px/1.5 "Avenir Next",Avenir,"Segoe UI Variable",sans-serif}a{color:var(--accent)}a:focus-visible,button:focus-visible,select:focus-visible{outline:3px solid var(--accent);outline-offset:3px}header,main{width:min(1180px,100%);margin:auto;padding:24px}header{border-bottom:1px solid var(--line)}h1{max-width:16ch;font-size:clamp(2.2rem,7vw,4.8rem);line-height:1;margin:42px 0 26px}.layout{display:grid;grid-template-columns:1fr 1fr;gap:40px}[data-onion-navigation]{display:grid;grid-template-columns:repeat(2,1fr);gap:6px}[data-onion-node]{min-height:52px;padding:8px;display:grid;grid-template-columns:26px 1fr;background:var(--surface);border:1px solid var(--line);text-decoration:none}[data-onion-node] span{grid-row:span 2}[data-onion-node] small,li small{display:block;color:var(--muted)}li[data-hidden=true]{display:none}aside,[role=note]{padding:12px;border:1px solid var(--accent);background:var(--accent-surface)}.bindings{display:flex;flex-wrap:wrap;gap:12px}.bindings code{padding:6px 8px;border:1px solid var(--line);background:var(--surface)}form{display:flex;gap:12px;align-items:end;margin:28px 0}label{display:grid;gap:4px}select,button{min-height:44px;padding:8px}ul{padding-left:22px}li{padding:7px 0}@media(prefers-color-scheme:dark){:root{--ink:oklch(91% .015 180);--paper:oklch(18% .014 190);--surface:oklch(23% .016 190);--line:oklch(39% .018 185);--accent:oklch(76% .09 180);--accent-surface:oklch(29% .035 183);--muted:oklch(72% .02 185)}}@media(max-width:720px){header,main{padding:16px}.layout{grid-template-columns:1fr}[data-onion-navigation]{display:none}form{align-items:stretch;flex-direction:column}}@media(prefers-reduced-motion:reduce){*{animation:none!important;transition:none!important}}
  </style></head><body><header><strong>Planeon · Harness control</strong></header><main id="main-content"><p>Organization harness status</p><h1>${escapeHtml(title)}</h1>${body}</main><script>
  const nodes=[...document.querySelectorAll('[data-onion-node]')];nodes.forEach((node,index)=>node.addEventListener('keydown',event=>{let next=index;if(event.key==='ArrowRight'||event.key==='ArrowDown')next=(index+1)%nodes.length;else if(event.key==='ArrowLeft'||event.key==='ArrowUp')next=(index-1+nodes.length)%nodes.length;else if(event.key==='Home')next=0;else if(event.key==='End')next=nodes.length-1;else return;event.preventDefault();nodes[next].focus()}));
  const form=document.querySelector('form');if(form)form.addEventListener('submit',event=>{event.preventDefault();const value=form.elements.state.value;const items=[...document.querySelectorAll('li[data-state]')];items.forEach(item=>item.dataset.hidden=value!=='ALL'&&item.dataset.state!==value?'true':'false');const count=items.filter(item=>item.dataset.hidden!=='true').length;form.querySelector('[role=status]').textContent='Showing '+count+' of 16 harnesses.';location.hash='/overview?state='+encodeURIComponent(value)});
  </script></body></html>`;
}
