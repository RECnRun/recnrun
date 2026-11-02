import { createHash, timingSafeEqual } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";

/** What a request must match: the port the service listens on and its bearer token. */
export interface Guard {
  port: number;
  readonly token: string;
}

export type Verdict =
  | { ok: true }
  | { ok: false; status: 401 | 403; code: "unauthorized" | "forbidden"; message: string };

// The service binds 127.0.0.1 only; `localhost` is the same socket under the name a browser shows.
const LOOPBACK_NAMES = ["127.0.0.1", "localhost"];

/** `Host` must name the loopback socket, so a DNS-rebound name never reaches the API. */
export function isAllowedHost(host: string | undefined, port: number): boolean {
  const value = host?.toLowerCase();
  return LOOPBACK_NAMES.some((name) => value === `${name}:${port}`);
}

/** No `Origin` is a non-browser client; a browser must come from the service's own page. */
export function isAllowedOrigin(origin: string | undefined, port: number): boolean {
  if (origin === undefined) return true;
  return LOOPBACK_NAMES.some((name) => origin.toLowerCase() === `http://${name}:${port}`);
}

/** The token a request presents: `Authorization: Bearer`, or `?token=` where headers cannot be set. */
export function presentedToken(
  headers: IncomingHttpHeaders,
  url: string | undefined,
  allowQuery: boolean,
): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(headers.authorization ?? "")?.[1];
  if (bearer !== undefined || !allowQuery) return bearer;
  return new URL(url ?? "/", "http://127.0.0.1").searchParams.get("token") ?? undefined;
}

const digest = (value: string) => createHash("sha256").update(value).digest();

/** Compares digests in constant time, so neither the length nor a prefix of the token leaks. */
export function tokenMatches(candidate: string | undefined, token: string): boolean {
  return candidate !== undefined && timingSafeEqual(digest(candidate), digest(token));
}

/** Checks `Host` and `Origin` (403) before the token (401), so a foreign page learns nothing. */
export function checkSource(headers: IncomingHttpHeaders, guard: Guard): Verdict {
  if (!isAllowedHost(headers.host, guard.port))
    return { ok: false, status: 403, code: "forbidden", message: "Host is not this service." };
  if (!isAllowedOrigin(headers.origin, guard.port))
    return { ok: false, status: 403, code: "forbidden", message: "Origin is not allowed." };
  return { ok: true };
}

/** The full check of an HTTP request: source, then `Authorization: Bearer <token>`. */
export function authorize(
  request: { headers: IncomingHttpHeaders; url?: string },
  guard: Guard,
  allowQueryToken: boolean,
): Verdict {
  const source = checkSource(request.headers, guard);
  if (!source.ok) return source;
  if (tokenMatches(presentedToken(request.headers, request.url, allowQueryToken), guard.token))
    return { ok: true };
  return {
    ok: false,
    status: 401,
    code: "unauthorized",
    message: "A valid bearer token is required.",
  };
}
