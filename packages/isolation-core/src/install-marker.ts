import * as v from "valibot";
import { BootstrapOptionsSchema } from "./marker.ts";
import { patchCaches, patchFetch, patchIndexedDb } from "./marker-patches.ts";

/** The property a patched scope exposes so a debugger can tell which marker it carries. */
export const DIAGNOSTICS_KEY = "__recnrun";

export interface MarkerDiagnostics {
  readonly marker: string;
  readonly installedAt: number;
}

export const MarkerDiagnosticsSchema = v.object({ marker: v.string(), installedAt: v.number() });

/**
 * Patches `fetch`, `indexedDB`, and `caches` of `scope` so every request, database, and cache it
 * makes carries `options.marker`. A second call on the same scope changes nothing.
 */
export function installMarker(scope: object, options: unknown): MarkerDiagnostics {
  const existing: unknown = Reflect.get(scope, DIAGNOSTICS_KEY);
  if (v.is(MarkerDiagnosticsSchema, existing)) return existing;
  const { marker } = v.parse(BootstrapOptionsSchema, options);
  patchFetch(scope, marker);
  patchIndexedDb(scope, marker);
  patchCaches(scope, marker);
  const diagnostics: MarkerDiagnostics = Object.freeze({ marker, installedAt: Date.now() });
  // Read-only and non-enumerable: page code cannot overwrite it, and it stays out of key listings.
  Object.defineProperty(scope, DIAGNOSTICS_KEY, { value: diagnostics });
  return diagnostics;
}
