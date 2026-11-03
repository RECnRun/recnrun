import * as v from "valibot";
import { installMarker } from "./install-marker.ts";
import { installOriginalFilter, installedDiagnostics } from "./install-original.ts";
import type { BootstrapDiagnostics } from "./install-original.ts";
import { BootstrapOptionsSchema } from "./marker.ts";

// A namespaced session's marker, or the original session, which carries none.
const BootstrapModeSchema = v.union([
  BootstrapOptionsSchema,
  v.object({ original: v.literal(true) }),
]);

/**
 * The bootstrap's entry: `{ marker }` installs the marker, `{ original: true }` the original
 * session's filter. A scope a bootstrap already patched keeps its mode and changes nothing.
 */
export function installBootstrap(scope: object, options: unknown): BootstrapDiagnostics {
  const existing = installedDiagnostics(scope);
  if (existing) return existing;
  const mode = v.parse(BootstrapModeSchema, options);
  return "marker" in mode ? installMarker(scope, mode) : installOriginalFilter(scope);
}
