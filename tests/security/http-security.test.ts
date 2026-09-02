import { describe, expect, it } from "vitest";

import { sessionCookie } from "../../apps/control-web/src/lib/foundation/session";
import { API_SECURITY_HEADERS, assertBrowserMutation, secureJsonResponse } from "../../apps/control-web/src/lib/security/http";

function mutation(headers: Record<string, string> = {}): Request {
  return new Request("https://control.local/api/v1alpha1/demands", {
    method: "POST",
    headers: { "content-type": "application/json", host: "control.local", ...headers },
    body: "{}",
  });
}

describe("shared control API security boundary", () => {
  it("emits the closed response-header policy", () => {
    const response = secureJsonResponse(200, { ok: true }, '"etag"');
    for (const [name, value] of Object.entries(API_SECURITY_HEADERS)) expect(response.headers.get(name)).toBe(value);
    expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
    expect(response.headers.get("etag")).toBe('"etag"');
  });

  it("accepts same-origin browser and authenticated non-browser mutation metadata", () => {
    expect(() => assertBrowserMutation(mutation({ origin: "https://control.local", "sec-fetch-site": "same-origin" }))).not.toThrow();
    expect(() => assertBrowserMutation(mutation())).not.toThrow();
  });

  it("rejects hostile origin, cross-site Fetch Metadata, invalid host, and content confusion", () => {
    const vectors = [
      mutation({ origin: "https://attacker.invalid", "sec-fetch-site": "cross-site" }),
      mutation({ origin: "https://control.local", "sec-fetch-site": "same-site" }),
      mutation({ origin: "https://control.local", host: "control.local, attacker.invalid" }),
      mutation({ "content-type": "text/plain" }),
    ];
    for (const request of vectors) expect(() => assertBrowserMutation(request)).toThrow();
  });

  it("preserves the host-only secure server-session cookie contract", () => {
    expect(sessionCookie("opaque", 60)).toBe("__Host-planeon_session=opaque; Max-Age=60; Path=/; Secure; HttpOnly; SameSite=Lax");
  });
});
