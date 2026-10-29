import type { OriginData } from "@recnrun/domain";

type Entry = OriginData["caches"][number]["entries"][number];

/** How long one entry's fetch may take before it comes back as captured instead. */
const REFETCH_BOUND_MS = 10_000;

const AS_CAPTURED = "so it comes back as captured, without its URL.";
export const UNREACHABLE = `The server did not answer, ${AS_CAPTURED}`;
export const OTHER_RESPONSE = `The server now sends another response, ${AS_CAPTURED}`;
export const OTHER_BODY = `The server now sends another body, ${AS_CAPTURED}`;

function sameBytes(fresh: ArrayBuffer, captured: ArrayBuffer | null): boolean {
  const left = new Uint8Array(fresh);
  const right = new Uint8Array(captured ?? new ArrayBuffer(0));
  return left.length === right.length && left.every((byte, at) => byte === right[at]);
}

function sameResponse(fresh: Response, captured: Entry["response"]): boolean {
  return (
    fresh.type === captured.type &&
    fresh.url === captured.url &&
    fresh.redirected === captured.redirected &&
    fresh.status === captured.status
  );
}

/**
 * A fetched entry fetched again, as only a fetch gives a response its URL list; kept only when the
 * server answers with the captured type, final URL, redirect, status, and body. It sends no cookie
 * and keeps none, so the identity's cookies neither shape the answer nor change.
 */
export async function refetch({ request, response }: Entry): Promise<Response | string> {
  let fresh: Response;
  try {
    fresh = await fetch(request.url, {
      method: request.method,
      headers: request.headers,
      credentials: "omit",
      cache: "no-store",
      signal: AbortSignal.timeout(REFETCH_BOUND_MS),
    });
  } catch {
    return UNREACHABLE;
  }
  if (!sameResponse(fresh, response)) return OTHER_RESPONSE;
  // The clone is read, so the response itself still has its body for the cache.
  const body = await fresh
    .clone()
    .arrayBuffer()
    .catch(() => undefined);
  if (body === undefined) return UNREACHABLE;
  return sameBytes(body, response.body) ? fresh : OTHER_BODY;
}
