import * as v from "valibot";

/** Physical storage names that start with this prefix belong to RECnRun. */
export const RESERVED_PREFIX = "__rec:";

/** The query parameter a patched scope appends to the URL of every request it makes. */
export const MARKER_PARAM = "__rec";

// Letters, digits, "_" and "-" only: the marker goes unescaped into URLs, storage names, and scripts.
export const MarkerSchema = v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/));

export const BootstrapOptionsSchema = v.object({ marker: MarkerSchema });

export type BootstrapOptions = v.InferOutput<typeof BootstrapOptionsSchema>;

export function parseMarker(value: unknown): string {
  return v.parse(MarkerSchema, value);
}

/** The name a patched scope uses for its logical database or cache `name`. */
export function physicalName(marker: string, name: string): string {
  return `${RESERVED_PREFIX}${marker}:${name}`;
}

/** The logical name behind `physical`, or `undefined` when another marker (or none) owns it. */
export function logicalName(marker: string, physical: string): string | undefined {
  const prefix = physicalName(marker, "");
  return physical.startsWith(prefix) ? physical.slice(prefix.length) : undefined;
}

/** `url` resolved against `base` with the marker appended, for http(s) URLs not marked yet. */
export function markUrl(url: string, marker: string, base?: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return url;
  }
  if (!/^https?:$/.test(parsed.protocol) || parsed.searchParams.has(MARKER_PARAM)) return url;
  const pair = `${MARKER_PARAM}=${marker}`;
  parsed.search = parsed.search ? `${parsed.search}&${pair}` : `?${pair}`;
  return parsed.href;
}
