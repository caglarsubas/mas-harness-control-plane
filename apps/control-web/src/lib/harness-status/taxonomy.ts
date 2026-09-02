import type { PlaneId } from "./contracts";

export interface HarnessDefinition {
  readonly id: string;
  readonly planeId: PlaneId;
  readonly number: number;
  readonly name: string;
  readonly purpose: string;
}

export interface PlaneDefinition {
  readonly id: PlaneId;
  readonly number: number;
  readonly name: string;
  readonly description: string;
  readonly harnesses: readonly HarnessDefinition[];
}

export const PLANES: readonly PlaneDefinition[] = Object.freeze([
  {
    id: "runtime", number: 4, name: "Runtime plane",
    description: "The infrastructure, model serving, gateway, and user-facing runtime boundary.",
    harnesses: [
      { id: "runtime.infrastructure", planeId: "runtime", number: 1, name: "Infrastructure & Runtime", purpose: "Provide the verified substrate and reconciliation boundary." },
      { id: "runtime.model-inference", planeId: "runtime", number: 2, name: "Model & Inference", purpose: "Serve approved models through bounded local inference interfaces." },
      { id: "runtime.ai-gateway", planeId: "runtime", number: 3, name: "AI Gateway", purpose: "Mediate governed access to model and agent capabilities." },
      { id: "runtime.experience", planeId: "runtime", number: 4, name: "Experience & Interaction", purpose: "Expose tenant-approved human and application interactions." },
    ],
  },
  {
    id: "knowledge", number: 1, name: "Knowledge plane",
    description: "The domain, source, retrieval, provenance, memory, and state boundary.",
    harnesses: [
      { id: "knowledge.domain-semantic", planeId: "knowledge", number: 5, name: "Domain & Semantic", purpose: "Capture governed domain meaning and validation rules." },
      { id: "knowledge.data-integration", planeId: "knowledge", number: 6, name: "Data Integration & Provenance", purpose: "Admit, normalize, and trace tenant-approved data sources." },
      { id: "knowledge.retrieval-context", planeId: "knowledge", number: 7, name: "Retrieval & Context Engineering", purpose: "Assemble cited, policy-bounded context." },
      { id: "knowledge.memory-state", planeId: "knowledge", number: 8, name: "Memory & State", purpose: "Persist scoped agent memory and durable state." },
    ],
  },
  {
    id: "execution", number: 2, name: "Execution plane",
    description: "The protocol, orchestration, tool, sandbox, and decision execution boundary.",
    harnesses: [
      { id: "execution.protocol-interoperability", planeId: "execution", number: 9, name: "Protocol & Interoperability", purpose: "Normalize authenticated agent and tool protocols." },
      { id: "execution.orchestration", planeId: "execution", number: 10, name: "Orchestration & Durable Execution", purpose: "Coordinate replayable, governed agent workflows." },
      { id: "execution.tool-skill-sandbox", planeId: "execution", number: 11, name: "Tool, Skill & Sandbox", purpose: "Broker least-privilege skills and isolated execution." },
      { id: "execution.ml-decision", planeId: "execution", number: 12, name: "ML & Decision Intelligence", purpose: "Execute approved predictive and decision artifacts." },
    ],
  },
  {
    id: "trust", number: 3, name: "Trust & lifecycle plane",
    description: "The security, governance, observability, cost, and assurance boundary.",
    harnesses: [
      { id: "trust.security-safety", planeId: "trust", number: 13, name: "Security, Safety & Guardrails", purpose: "Enforce identity, authorization, supply-chain, and guardrail controls." },
      { id: "trust.governance-agentops", planeId: "trust", number: 14, name: "Governance, Oversight & AgentOps", purpose: "Govern agent registration, promotion, exceptions, and oversight." },
      { id: "trust.observability-finops", planeId: "trust", number: 15, name: "Observability & FinOps", purpose: "Collect tenant-neutral telemetry and bounded cost evidence." },
      { id: "trust.evaluation-assurance", planeId: "trust", number: 16, name: "Evaluation & Assurance", purpose: "Run immutable evaluation campaigns and record evidence." },
    ],
  },
]);

export const HARNESSES = Object.freeze(PLANES.flatMap((plane) => plane.harnesses).sort((left, right) => left.number - right.number));
export const PLANE_IDS = Object.freeze(PLANES.map((plane) => plane.id));
export const HARNESS_IDS = Object.freeze(HARNESSES.map((harness) => harness.id));

export function planeDefinition(id: string): PlaneDefinition | undefined {
  return PLANES.find((plane) => plane.id === id);
}

export function harnessDefinition(id: string): HarnessDefinition | undefined {
  return HARNESSES.find((harness) => harness.id === id);
}
