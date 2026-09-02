export const WHITE_GOODS_JOURNEY = Object.freeze([
  Object.freeze({ title: "Questionnaire reviewed", state: "READY FOR COMPILATION", detail: "Eight declaration stages are complete and readiness is explicit." }),
  Object.freeze({ title: "Demand approved", state: "APPROVED", detail: "Two distinct reviewers approved the immutable tenant demand." }),
  Object.freeze({ title: "Profile compilation", state: "SUCCEEDED", detail: "The local compiler produced six digest-bound outputs." }),
  Object.freeze({ title: "Profile reviewed", state: "PROPOSED", detail: "Named harnesses, providers, modules, and evidence limits are visible." }),
  Object.freeze({ title: "Profile approval", state: "APPROVED", detail: "The profile review reached its independent N-of-M quorum." }),
  Object.freeze({ title: "Canonical profile lock", state: "LOCKED", detail: "The lock binds demand, compiler, catalog, outputs, and approval digests." }),
  Object.freeze({ title: "Bundle handoff", state: "REQUESTED", detail: "One local build request exists; no artifact, deployment, or runtime is claimed." }),
]);

function escape(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function renderWhiteGoodsJourney(): string {
  const steps = WHITE_GOODS_JOURNEY.map((step, index) => `
    <li><button type="button" data-step="${index}" ${index === 0 ? 'aria-current="step"' : ""}>
      <span>${index + 1}</span>${escape(step.title)}
    </button></li>`).join("");
  const serialized = JSON.stringify(WHITE_GOODS_JOURNEY).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>White-goods harness journey</title>
<style>
  :root{font-family:ui-sans-serif,system-ui,sans-serif;color:#18272c;background:#f4f1e8}*{box-sizing:border-box}
  body{margin:0;line-height:1.5}.skip{position:absolute;left:.75rem;top:-5rem;padding:.75rem;background:#14262d;color:white}.skip:focus{top:.75rem}
  header,main{inline-size:min(70rem,100%);margin:auto;padding:1rem}header{display:flex;justify-content:space-between;gap:1rem;border-block-end:1px solid #a8b7b3}
  ol{display:grid;grid-template-columns:repeat(auto-fit,minmax(10rem,1fr));gap:.5rem;padding:0;list-style:none}
  button{min-block-size:44px;inline-size:100%;padding:.65rem;text-align:left;border:1px solid #78918a;background:#fff;color:inherit}
  button[aria-current=step]{border-width:3px;border-color:#0b6f67;font-weight:700}button:focus-visible,a:focus-visible{outline:3px solid #0b6f67;outline-offset:3px}
  .card{padding:clamp(1rem,4vw,2.5rem);background:#fff;border-inline-start:.5rem solid #0b6f67}.state{font-weight:800;letter-spacing:.05em}
  .controls{display:flex;gap:.75rem;margin-block:1rem}.boundary{padding:1rem;border:1px solid #a8b7b3;background:#eaf1ef}
  @media(max-width:30rem){header,.controls{align-items:stretch;flex-direction:column}ol{grid-template-columns:1fr}}
  @media(prefers-reduced-motion:reduce){*,*::before,*::after{animation-duration:.001ms!important;transition-duration:.001ms!important;scroll-behavior:auto!important}}
</style></head><body>
<a class="skip" href="#main-content">Skip to main content</a>
<header><strong>Planeon / White goods</strong><span>Offline acceptance view</span></header>
<main id="main-content" tabindex="-1">
  <p>Guided harness setup</p><h1>From business declaration to a bounded bundle request</h1>
  <nav aria-label="Journey states"><ol>${steps}</ol></nav>
  <section class="card" aria-labelledby="state-title"><p id="state-value" class="state">${escape(WHITE_GOODS_JOURNEY[0].state)}</p><h2 id="state-title">${escape(WHITE_GOODS_JOURNEY[0].title)}</h2><p id="state-detail">${escape(WHITE_GOODS_JOURNEY[0].detail)}</p></section>
  <div class="controls"><button id="previous" type="button" disabled>Previous state</button><button id="next" type="button">Next state</button></div>
  <p id="announcement" role="status" aria-live="polite">State 1 of ${WHITE_GOODS_JOURNEY.length}: ${escape(WHITE_GOODS_JOURNEY[0].state)}</p>
  <aside class="boundary" aria-labelledby="boundary-title"><h2 id="boundary-title">Evidence boundary</h2><p>Request status is not artifact proof, deployment, runtime health, assurance, or tenant acceptance.</p></aside>
</main><script>
  const states=${serialized}; let active=0;
  const buttons=[...document.querySelectorAll('[data-step]')];
  const show=index=>{active=index;const value=states[index];buttons.forEach((button,offset)=>offset===index?button.setAttribute('aria-current','step'):button.removeAttribute('aria-current'));document.querySelector('#state-value').textContent=value.state;document.querySelector('#state-title').textContent=value.title;document.querySelector('#state-detail').textContent=value.detail;document.querySelector('#announcement').textContent='State '+(index+1)+' of '+states.length+': '+value.state;document.querySelector('#previous').disabled=index===0;document.querySelector('#next').disabled=index===states.length-1};
  buttons.forEach((button,index)=>button.addEventListener('click',()=>show(index)));
  document.querySelector('#previous').addEventListener('click',()=>show(Math.max(0,active-1)));
  document.querySelector('#next').addEventListener('click',()=>show(Math.min(states.length-1,active+1)));
</script></body></html>`;
}
