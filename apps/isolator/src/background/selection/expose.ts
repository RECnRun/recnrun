import { SelectionEngine } from "@/background/selection/engine";
import type { SelectionApis } from "@/background/selection/types";

/** What the harness reaches with `Runtime.evaluate` in this service worker (experiment E6). */
export const SELECTION_GLOBAL = "recnrunSelection";

interface WakeEvent {
  addListener(listener: () => void): void;
}

/** Installs the selection on `globalThis`; the getter defers to the moment a call runs. */
export function exposeSelection(apis: () => SelectionApis, tabCreated: WakeEvent): void {
  const engine = new SelectionEngine(apis);
  // A listener added at start lets a new tab wake a suspended background (E6's suspension).
  tabCreated.addListener(() => engine.woke("tabs.onCreated"));
  Object.assign(globalThis, { [SELECTION_GLOBAL]: engine });
}
