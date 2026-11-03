import { StopEngine } from "@/background/stop/engine";
import type { StopApis } from "@/background/stop/types";

/** What the harness reaches with `Runtime.evaluate` in this service worker (experiment E4). */
export const STOP_GLOBAL = "recnrunStop";

/** Installs the stop mechanisms on `globalThis`; the getter defers to the moment a call runs. */
export function exposeStop(apis: () => StopApis): void {
  Object.assign(globalThis, { [STOP_GLOBAL]: new StopEngine(apis) });
}
