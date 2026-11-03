import { RouteCEngine } from "@/background/route-c/engine";
import type { ScriptingApi } from "@/background/route-c/types";

/** What the harness reaches with `Runtime.evaluate` in this service worker (experiment E7). */
export const ROUTE_C_GLOBAL = "recnrunRouteC";

/** Installs Route C on `globalThis`; the getter defers to the moment a call runs. */
export function exposeRouteC(scripting: () => ScriptingApi): void {
  Object.assign(globalThis, { [ROUTE_C_GLOBAL]: new RouteCEngine(scripting) });
}
