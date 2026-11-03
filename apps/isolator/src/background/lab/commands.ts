import { messageOf } from "@/background/probes/helpers";
import type { DebuggerApi } from "@/background/probes/types";
import { command } from "@/background/route-a/attached";
import type { RouteAEngine } from "@/background/route-a/engine";
import type { CloseReport } from "@/background/route-a/types";
import type { RouteBEngine } from "@/background/route-b/engine";
import type { LabConfig } from "@/background/lab/schema";
import type { ArmedTab } from "@/background/lab/types";

/** What arming clears, as Route A's `clearOrigin` does between E3's samples. */
const CLEARED_STORAGE = "service_workers,indexeddb,cache_storage";
// chrome.debugger lists service and shared workers as `worker` (E1).
const WORKER_TYPES = new Set(["worker", "service_worker"]);

export interface Engines {
  api: DebuggerApi;
  routeA: RouteAEngine;
  routeB: RouteBEngine;
  now: () => number;
}

export type ArmConfig = NonNullable<LabConfig["arm"]>;

export const originOf = (url: string): string => (URL.canParse(url) ? new URL(url).origin : "null");

async function armRoute(engines: Engines, arm: ArmConfig, tabId: number, marker: string) {
  if (arm.route === "b") {
    const selection = arm.selection === undefined ? {} : { selection: arm.selection };
    await engines.routeB.arm({ tabId, marker, urlPattern: arm.urlPattern, ...selection });
    return;
  }
  engines.routeA.setMarker(marker);
  await engines.routeA.arm({ tabId, pauseBeforeScript: arm.pauseBeforeScript });
}

/** Arms the tab on its route with `<prefix>-t<tabId>`, then clears the origin when asked. */
export async function armTab(
  engines: Engines,
  arm: ArmConfig,
  tab: { tabId: number; url: string; prefix: string },
): Promise<ArmedTab> {
  const { tabId, url } = tab;
  const marker = `${tab.prefix}-t${tabId}`;
  const record: ArmedTab = { tabId, url, marker, route: arm.route, at: engines.now() };
  try {
    await armRoute(engines, arm, tabId, marker);
    if (arm.clear) {
      // The arm's own session sends it, so no second attach to the tab is needed.
      await command(engines.api, { tabId }, "Storage.clearDataForOrigin", {
        origin: arm.origin,
        storageTypes: CLEARED_STORAGE,
      });
      record.cleared = arm.origin;
    }
  } catch (error) {
    record.error = messageOf(error);
  }
  return record;
}

/** Closes every worker target of `origin` through Route A's `closeTarget` (E3's stop). */
export async function stopWorkers(engines: Engines, origin: string): Promise<CloseReport[]> {
  const targets = await engines.api.getTargets();
  const workers = targets.filter((t) => WORKER_TYPES.has(t.type) && originOf(t.url) === origin);
  const reports: CloseReport[] = [];
  for (const { id } of workers) reports.push(await engines.routeA.closeTarget({ targetId: id }));
  return reports;
}
