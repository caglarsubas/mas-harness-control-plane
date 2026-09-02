import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const SURFACES = Object.freeze([
  ["apps/control-web/src/lib/questionnaire/http.ts", 3],
  ["apps/control-web/src/lib/demands/http.ts", 4],
  ["apps/control-web/src/lib/operations/http.ts", 1],
  ["apps/control-web/src/lib/profiles/http.ts", 4],
] as const);

describe("cumulative HTTP hardening adoption", () => {
  it("routes every mutation through the shared browser-origin policy", () => {
    let guarded = 0;
    for (const [path, expected] of SURFACES) {
      const source = readFileSync(path, "utf8");
      const count = source.match(/assertBrowserMutation\(request\);/gu)?.length ?? 0;
      expect(count, path).toBe(expected);
      expect(source, path).toMatch(/\.\.\.API_SECURITY_HEADERS|secureJsonResponse/u);
      guarded += count;
    }
    const routeMutations = readFileSync("apps/control-web/src/app/api/v1alpha1/sessions/route.ts", "utf8").includes("POST")
      ? 1 + 2 + 4 + 1 + 4
      : 0;
    expect(guarded).toBe(routeMutations);
  });

  it("uses constant-time CSRF comparison while retaining existing server-side session authority", () => {
    const session = readFileSync("apps/control-web/src/lib/foundation/session.ts", "utf8");
    expect(session).toContain("timingSafeEqual(left, right)");
    expect(session).toContain("!digestEqual(sha256(csrfToken), current.csrfDigest)");
    expect(session).not.toContain("sha256(csrfToken) !== current.csrfDigest");
  });
});
