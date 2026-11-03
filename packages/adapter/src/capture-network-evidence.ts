import {
  MAX_HEADER_VALUE_LENGTH,
  REDACTED,
  ResourceTimingSchema,
  SENSITIVE_HEADERS,
  type BodyEncoding,
  type BodyRef,
  type CacheState,
  type ResourceTiming,
} from "@recnrun/protocol";

/** Where response bodies go instead of the journal; persistence's blob store is one. */
export interface BodySink {
  put(content: Uint8Array, meta: { mime: string; encoding: BodyEncoding }): Promise<BodyRef>;
}

/** The lowercase header names whose values never leave the adapter: the defaults and `extra`. */
export const sensitiveHeaders = (extra: readonly string[] = []): ReadonlySet<string> =>
  new Set([...SENSITIVE_HEADERS, ...extra.map((name) => name.toLowerCase())]);

export interface HeaderEntries {
  headers?: Record<string, string>;
  headersTruncated?: true;
}

/** Headers as they may be persisted: sensitive values `redacted`, long ones clipped and flagged. */
export function headerEntries(
  headers: Record<string, string> | undefined,
  sensitive: ReadonlySet<string>,
): HeaderEntries {
  if (!headers) return {};
  const entries = Object.entries(headers);
  const kept = entries.map(([name, value]): [string, string] =>
    sensitive.has(name.toLowerCase())
      ? [name, REDACTED]
      : [name, value.slice(0, MAX_HEADER_VALUE_LENGTH)],
  );
  const truncated = entries.some(
    ([name, value]) => !sensitive.has(name.toLowerCase()) && value.length > MAX_HEADER_VALUE_LENGTH,
  );
  return { headers: Object.fromEntries(kept), ...(truncated && { headersTruncated: true }) };
}

interface CacheFlags {
  fromDiskCache?: boolean | undefined;
  fromServiceWorker?: boolean | undefined;
  fromPrefetchCache?: boolean | undefined;
}

/** Where a response came from; `memory` is what `Network.requestServedFromCache` reported. */
export function cacheOf(flags: CacheFlags, memory: boolean): CacheState {
  if (flags.fromServiceWorker) return "service-worker";
  if (flags.fromPrefetchCache) return "prefetch";
  if (flags.fromDiskCache) return "disk";
  return memory ? "memory" : "network";
}

const TIMING_KEYS = Object.keys(ResourceTimingSchema.entries);

/** The resource timing fields the journal knows; newer ones Chrome adds are left out. */
export function timingOf(timing: Record<string, unknown> | undefined): ResourceTiming | undefined {
  if (!timing) return undefined;
  return Object.fromEntries(
    TIMING_KEYS.flatMap((key) => (typeof timing[key] === "number" ? [[key, timing[key]]] : [])),
  );
}

/** The body's bytes: UTF-8 for text Chrome returned as is, decoded for base64 bodies. */
export function bodyBytes(
  body: string,
  base64Encoded: boolean,
): { content: Uint8Array; encoding: BodyEncoding } {
  if (!base64Encoded) return { content: new TextEncoder().encode(body), encoding: "utf8" };
  return { content: Uint8Array.from(atob(body), (char) => char.charCodeAt(0)), encoding: "binary" };
}
