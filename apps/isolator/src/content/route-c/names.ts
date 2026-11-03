// Names the background registers and the page bootstrap reads; public/ns holds the files.

/** The global each slot file sets before the bootstrap runs. */
export const MARKER_GLOBAL = "__recnrunMarker";

/** The global a strategy file sets; the bootstrap reads it once and deletes it. */
export const STRATEGY_GLOBAL = "__recnrunWorkers";

/** Prebuilt slot files `ns/slot-0.js` to `ns/slot-9.js`, one marker each. */
export const SLOT_COUNT = 10;

/** The built page bootstrap (src/entrypoints/route-c.ts). */
export const BOOTSTRAP_FILE = "route-c.js";

/** How the bootstrap treats `new Worker()` and `new SharedWorker()` (E7 variants). */
export const WORKER_STRATEGIES = ["fail-closed", "blob", "data"] as const;

export type WorkerStrategy = (typeof WORKER_STRATEGIES)[number];

export function slotMarker(slot: number): string {
  return `slot-${slot}`;
}

/** The file that sets `marker`, which is always a slot marker. */
export function slotFile(marker: string): string {
  return `ns/${marker}.js`;
}

/** The file that selects `strategy`; failing closed needs none. */
export function strategyFile(strategy: WorkerStrategy): string | undefined {
  return strategy === "fail-closed" ? undefined : `ns/workers-${strategy}.js`;
}
