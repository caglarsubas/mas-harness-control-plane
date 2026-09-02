"use client";

import type { CSSProperties, KeyboardEvent } from "react";

import type { HarnessSummary } from "../../lib/harness-status/contracts";
import { HARNESSES, PLANES } from "../../lib/harness-status/taxonomy";
import styles from "./overview.module.css";

interface OnionStyle extends CSSProperties {
  readonly "--angle": string;
  readonly "--radius": string;
}

const RADII: Readonly<Record<string, string>> = {
  knowledge: "clamp(105px, 10vw, 130px)",
  execution: "clamp(150px, 15vw, 190px)",
  trust: "clamp(200px, 20vw, 250px)",
  runtime: "clamp(250px, 25vw, 310px)",
};

const RING_ORDER = ["runtime", "trust", "execution", "knowledge"] as const;

function move(event: KeyboardEvent<HTMLAnchorElement>, index: number): void {
  const delta = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1
    : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
  if (delta === 0 && event.key !== "Home" && event.key !== "End") return;
  event.preventDefault();
  const links = [...event.currentTarget.closest('[role="listbox"]')?.querySelectorAll<HTMLAnchorElement>("a[data-onion-node]") ?? []];
  const next = event.key === "Home" ? 0 : event.key === "End" ? links.length - 1 : (index + delta + links.length) % links.length;
  links.forEach((link, linkIndex) => { link.tabIndex = linkIndex === next ? 0 : -1; });
  links[next]?.focus();
}

export function HarnessOnion({ summaries, visibleIds }: { readonly summaries: readonly HarnessSummary[]; readonly visibleIds: ReadonlySet<string> }) {
  return (
    <section className={styles.onionPanel} aria-labelledby="system-map-title">
      <div className={styles.mapHeading}>
        <div><p className={styles.eyebrow}>System topology</p><h2 id="system-map-title">Harness onion</h2></div>
        <p>Arrow keys move clockwise. Every destination also appears in the semantic list.</p>
      </div>
      <div className={styles.onion} role="listbox" aria-label="Sixteen harnesses arranged by plane" aria-orientation="horizontal">
        {RING_ORDER.map((planeId) => <div className={styles.ring} data-plane={planeId} key={planeId} aria-hidden="true" />)}
        <div className={styles.core} aria-hidden="true"><span>Model core</span><strong>LLMs</strong><small>local · approved · swappable</small></div>
        {HARNESSES.map((definition, index) => {
          const summary = summaries.find((item) => item.harnessId === definition.id);
          const planeOffset = (definition.number - 1) % 4;
          const angle = `${-90 + planeOffset * 90 + (definition.planeId === "trust" || definition.planeId === "knowledge" ? 45 : 0)}deg`;
          const label = summary ? `${definition.name}: ${summary.aggregateState}; ${summary.freshnessState}; ${summary.blockerCount} blockers` : `${definition.name}: unavailable`;
          return (
            <a
              aria-label={label}
              aria-selected={visibleIds.has(definition.id)}
              className={styles.onionNode}
              data-onion-node
              data-state={summary?.aggregateState ?? "EMPTY"}
              href={`/harnesses/${definition.id}`}
              key={definition.id}
              onKeyDown={(event) => move(event, index)}
              role="option"
              style={{ "--angle": angle, "--radius": RADII[definition.planeId] } as OnionStyle}
              tabIndex={index === 0 ? 0 : -1}
              title={label}
            >
              <span>{definition.number}</span><b>{definition.name}</b><small>{summary?.aggregateState ?? "EMPTY"}</small>
            </a>
          );
        })}
      </div>
      <nav className={styles.planeLinks} aria-label="Plane detail pages">
        {PLANES.map((plane) => <a href={`/planes/${plane.id}`} key={plane.id}><span>Plane {plane.number}</span>{plane.name}</a>)}
      </nav>
    </section>
  );
}
