import type { DebuggerApi } from "@/background/probes/types";
import { RouteAEngine } from "@/background/route-a/engine";

/** What the harness reaches with `Runtime.evaluate` in this service worker (experiment E2). */
export const ROUTE_A_GLOBAL = "recnrunRouteA";

/** Installs Route A on `globalThis`; the getter defers to the moment a call runs. */
export function exposeRouteA(debuggerApi: () => DebuggerApi): void {
  Object.assign(globalThis, { [ROUTE_A_GLOBAL]: new RouteAEngine(debuggerApi) });
}
