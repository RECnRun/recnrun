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
 * session's filter. A scope a bootstrap already patched keeps its mode: a marked re-run only
 * answers per patch what `installMarker` had installed, and every other repeat changes nothing.
 */
export function installBootstrap(scope: object, options: unknown): BootstrapDiagnostics {
  const existing = installedDiagnostics(scope);
  if (existing && !("marker" in existing)) return existing;
  const mode = v.parse(BootstrapModeSchema, options);
  if ("marker" in mode) return installMarker(scope, mode);
  return existing ?? installOriginalFilter(scope);
}
