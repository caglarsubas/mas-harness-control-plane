import { ControlError } from "../foundation/contracts";

export const API_SECURITY_HEADERS = Object.freeze({
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
  "permissions-policy": "camera=(), geolocation=(), microphone=(), payment=(), usb=()",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
});

function host(request: Request): string {
  const value = request.headers.get("host") ?? new URL(request.url).host;
  if (!value || value.includes(",") || /[\s\\/]/u.test(value)) throw new ControlError("REQUEST_ORIGIN_REFUSED", 403);
  return value.toLowerCase();
}

export function assertBrowserMutation(request: Request): void {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new ControlError("CONTENT_TYPE_REFUSED", 415);
  const fetchSite = request.headers.get("sec-fetch-site");
  if (fetchSite !== null && fetchSite !== "same-origin") throw new ControlError("REQUEST_ORIGIN_REFUSED", 403);
  const origin = request.headers.get("origin");
  if (origin === null) return;
  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new ControlError("REQUEST_ORIGIN_REFUSED", 403);
  }
  const requestUrl = new URL(request.url);
  const localHttp = requestUrl.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname);
  if (parsed.origin !== requestUrl.origin || parsed.host.toLowerCase() !== host(request) || (parsed.protocol !== "https:" && !localHttp)) {
    throw new ControlError("REQUEST_ORIGIN_REFUSED", 403);
  }
}

export function secureJsonResponse(status: number, body: unknown, etag?: string): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...API_SECURITY_HEADERS, "content-type": "application/json; charset=utf-8", ...(etag ? { etag } : {}) },
  });
}

export function secureTextResponse(status: number, body: string, contentType: string): Response {
  return new Response(body, { status, headers: { ...API_SECURITY_HEADERS, "content-type": contentType } });
}
