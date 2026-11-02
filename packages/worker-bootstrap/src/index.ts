import { parseMarker } from "@recnrun/isolation-core";
// Built by `vp run @recnrun/worker-bootstrap#build`; see vite.config.ts.
import { hash, source, version } from "../dist/bootstrap.js";

/** A function expression, valid as a classic script, that patches its global when called with `{ marker }`. */
export const BOOTSTRAP_SOURCE: string = source;

/** SHA-256 (hex) of BOOTSTRAP_SOURCE. */
export const BOOTSTRAP_HASH: string = hash;

/** The package version the bootstrap was built from. */
export const BOOTSTRAP_VERSION: string = version;

/** An expression that installs `marker` in the global it is evaluated in and returns its diagnostics. */
export function withMarker(marker: string): string {
  return `${BOOTSTRAP_SOURCE}(${JSON.stringify({ marker: parseMarker(marker) })})`;
}
