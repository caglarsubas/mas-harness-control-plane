import { canonicalJson, sha256 } from "../foundation/canonical";
import type { DemandProjection } from "../demands/contracts";
import type { CompileInputResolution, CompileInputResolver, ResolvedCompileInput } from "./contracts";

function immutableJson<T>(value: T): T {
  const clone = JSON.parse(canonicalJson(value)) as T;
  const freeze = (member: unknown): unknown => {
    if (member !== null && typeof member === "object") {
      for (const child of Object.values(member)) freeze(child);
      Object.freeze(member);
    }
    return member;
  };
  return freeze(clone) as T;
}

export class InMemoryCompileInputResolver implements CompileInputResolver {
  private readonly inputs = new Map<string, ResolvedCompileInput>();
  private unavailable = false;

  register(input: Omit<ResolvedCompileInput, "inputDigest">): ResolvedCompileInput {
    const compileRequest = immutableJson(input.compileRequest);
    const catalogResources = immutableJson(input.catalogResources);
    const resolved = Object.freeze({
      ...input,
      compileRequest,
      catalogResources,
      inputDigest: sha256(canonicalJson({
        compileRequest,
        catalogResources,
        catalogDigest: input.catalogDigest,
      })),
    });
    this.inputs.set(`${resolved.organizationId}:${resolved.demandId}`, resolved);
    return resolved;
  }

  setUnavailable(unavailable: boolean): void {
    this.unavailable = unavailable;
  }

  resolve(organizationId: string, demand: DemandProjection): CompileInputResolution {
    if (this.unavailable) return Object.freeze({ availability: "UNAVAILABLE" });
    const input = this.inputs.get(`${organizationId}:${demand.id}`);
    return input
      ? Object.freeze({ availability: "AVAILABLE", input })
      : Object.freeze({ availability: "NOT_FOUND" });
  }
}

export class UnavailableCompileInputResolver implements CompileInputResolver {
  resolve(_organizationId: string, _demand: DemandProjection): CompileInputResolution {
    return Object.freeze({ availability: "UNAVAILABLE" });
  }
}
