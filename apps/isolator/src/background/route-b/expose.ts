import type { DebuggerApi } from "@/background/probes/types";
import { RouteBEngine } from "@/background/route-b/engine";

/** What the harness reaches with `Runtime.evaluate` in this service worker (experiment E5). */
export const ROUTE_B_GLOBAL = "recnrunRouteB";

/** Installs Route B on `globalThis`; both getters defer to the moment a call runs. */
export function exposeRouteB(debuggerApi: () => DebuggerApi, extensionOrigin: () => string): void {
  Object.assign(globalThis, { [ROUTE_B_GLOBAL]: new RouteBEngine(debuggerApi, extensionOrigin) });
}
