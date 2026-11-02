import { createHash } from "node:crypto";

const byCodeUnit = ([a]: [string, unknown], [b]: [string, unknown]) => (a < b ? -1 : a > b ? 1 : 0);

/** Sorts object keys at every depth and drops undefined members; arrays keep their order. */
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value)
    .filter(([, item]) => item !== undefined)
    .toSorted(byCodeUnit);
  return Object.fromEntries(entries.map(([key, item]) => [key, canonicalize(item)]));
}

/** The canonical JSON text of a value: sorted keys, no whitespace, no undefined. */
export const canonicalJson = (value: unknown): string => JSON.stringify(canonicalize(value));

/** The sha256 hex digest of a text's UTF-8 bytes. */
export const sha256 = (text: string): string =>
  createHash("sha256").update(text, "utf8").digest("hex");
