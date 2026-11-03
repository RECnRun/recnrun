import * as v from "valibot";
import { DIAGNOSTICS_KEY, MarkerDiagnosticsSchema } from "./install-marker.ts";
import type { MarkerDiagnostics } from "./install-marker.ts";
import { patchCachesOriginal, patchIndexedDbOriginal } from "./original-patches.ts";
import { patchLocalStorageOriginal } from "./original-storage.ts";

export interface OriginalDiagnostics {
  readonly original: true;
  readonly installedAt: number;
}

export type BootstrapDiagnostics = MarkerDiagnostics | OriginalDiagnostics;

const OriginalDiagnosticsSchema = v.object({
  original: v.literal(true),
  installedAt: v.number(),
});

/** The diagnostics a bootstrap already left on `scope`, in either mode. */
function installedDiagnostics(scope: object): BootstrapDiagnostics | undefined {
  const existing: unknown = Reflect.get(scope, DIAGNOSTICS_KEY);
  if (v.is(MarkerDiagnosticsSchema, existing)) return existing;
  return v.is(OriginalDiagnosticsSchema, existing) ? existing : undefined;
}

/**
 * The original session's bootstrap (PLAN.md P1.7): `indexedDB`, `caches`, and `localStorage` of
 * `scope` keep their names but never list, read, clear, or create a name with the reserved prefix.
 * A scope a bootstrap already patched, in either mode, changes nothing.
 */
export function installOriginalFilter(scope: object): BootstrapDiagnostics {
  const existing = installedDiagnostics(scope);
  if (existing) return existing;
  patchIndexedDbOriginal(scope);
  patchCachesOriginal(scope);
  patchLocalStorageOriginal(scope);
  const diagnostics: OriginalDiagnostics = Object.freeze({
    original: true as const,
    installedAt: Date.now(),
  });
  // Read-only and non-enumerable, like the marked bootstrap's diagnostics.
  Object.defineProperty(scope, DIAGNOSTICS_KEY, { value: diagnostics });
  return diagnostics;
}
