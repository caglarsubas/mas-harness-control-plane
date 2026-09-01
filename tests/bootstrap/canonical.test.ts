import { describe, expect, it } from "vitest";

import { canonicalJson, parseJsonNoDuplicates, sha256 } from "../../apps/control-web/src/lib/foundation/canonical";

describe("canonical foundation", () => {
  it("sorts objects and emits stable lowercase digests", () => {
    expect(canonicalJson({ z: 2, a: [true, { b: "x", a: 1 }] })).toBe('{"a":[true,{"a":1,"b":"x"}],"z":2}');
    expect(sha256("fixture")).toMatch(/^sha256:[0-9a-f]{64}$/u);
  });

  it("rejects duplicate members, invalid syntax, and oversized JSON", () => {
    expect(() => parseJsonNoDuplicates('{"a":1,"a":2}')).toThrow("JSON_DUPLICATE_MEMBER");
    expect(() => parseJsonNoDuplicates('{"a":}')).toThrow("JSON_VALUE_INVALID");
    expect(() => parseJsonNoDuplicates(`{"a":"${"x".repeat(100)}"}`, 16)).toThrow("JSON_TOO_LARGE");
  });
});
