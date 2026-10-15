import { isRouteErrorResponse } from "react-router";

// First URL segment of every route in app/routes/ (US-49). The drift guard in
// route-miss.server.test.ts rebuilds this from app/routes.ts and fails on any mismatch.
export const ROUTE_PREFIXES: readonly string[] = [
  ".well-known", "api", "app", "auth", "healthz", "mcp", "reminders-v2", "roadmap", "webhooks",
];

// A scanner probe: a GET/HEAD that matched no route, on a path outside every route
// prefix (/.env, /id_rsa, /.git/credentials). Route misses under our own prefixes,
// the "/" index, other methods and every other error stay reported.
export function isUnservedProbe(error: unknown, request: Request): boolean {
  if (!isRouteErrorResponse(error) || error.status !== 404) return false;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  // Router matching is case-insensitive, so /API/x is a miss under our "api" prefix.
  const first = new URL(request.url).pathname.split("/")[1].toLowerCase();
  return first !== "" && !ROUTE_PREFIXES.includes(first);
}
