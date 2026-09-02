import { liveness } from "../../../lib/foundation/health";

export const dynamic = "force-dynamic";

export function GET(): Response {
  return Response.json(liveness(), {
    status: 200,
    headers: { "cache-control": "no-store" },
  });
}
