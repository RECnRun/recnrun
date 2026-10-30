import type { BarrierOperation } from "@/background/workspace/barrier";
import { connectAgent } from "@/background/workspace/capture-api";
import type { CaptureApi } from "@/background/workspace/capture-api";
import { WorkspaceError } from "@/background/workspace/errors";
import { visitInTab } from "@/background/workspace/helper-tab";
import type { HelperDeps } from "@/background/workspace/helper-tab";
import { isLoadedTab } from "@/background/workspace/session-tabs";
import type { SessionTab, UnloadedTab } from "@/background/workspace/session-tabs";
import type { MovedTab } from "@/background/workspace/tab-origins";
import type { OriginPort } from "@/messaging/origin-protocol";

/** The agent a capture reads the primary tab's origin through, for as long as it holds it. */
export interface PrimaryAccess {
  read: <T>(use: (port: OriginPort) => Promise<T>) => Promise<T>;
  release: () => void;
}

interface PrimaryDeps {
  api: Pick<CaptureApi, "inject" | "onConnect" | "topFrame">;
  helper: Pick<HelperDeps, "barrier" | "navigation">;
}

interface PrimaryRun {
  operation: BarrierOperation;
  boundMs: number;
  /** Where the read notes an unloaded tab it loaded its origin in, so its page comes back. */
  moved: MovedTab[];
}

/** Loads the tab's origin behind the anonymous barrier and reads it there, as no page runs. */
function unloadedAccess(tab: UnloadedTab, run: PrimaryRun, deps: PrimaryDeps): PrimaryAccess {
  return {
    read: async (use) => {
      run.moved.push({ tabId: tab.tabId, url: tab.url });
      const visiting = { operation: run.operation, work: "save" as const };
      const place = { tabId: tab.tabId, origin: tab.origin };
      const outcome = await visitInTab(place, visiting, deps.helper, use);
      if (outcome.ok) return outcome.value;
      const message = `Could not save the site data of ${tab.origin} at its ${outcome.step} step: ${outcome.reason}`;
      throw new WorkspaceError("VisitedOriginFailed", message);
    },
    release: () => undefined,
  };
}

/** Whether another document than the one found now runs in the tab, which is still open. */
async function left(tab: SessionTab, deps: PrimaryDeps) {
  const now = await deps.api.topFrame(tab.tabId).catch(() => null);
  return now !== null && now.documentId !== tab.documentId;
}

/**
 * Reads through the page's own agent; a page that left before or during the read, as one still
 * loading at the settle bound does, is read behind the barrier instead, as an unloaded tab is.
 */
async function loadedAccess(
  tab: SessionTab,
  run: PrimaryRun,
  deps: PrimaryDeps,
): Promise<PrimaryAccess> {
  const behind = async (error: unknown) => {
    if (await left(tab, deps)) return unloadedAccess(tab, run, deps);
    throw error;
  };
  let port: OriginPort;
  try {
    port = await connectAgent(deps.api, tab, run.boundMs);
  } catch (error) {
    return behind(error);
  }
  return {
    read: async (use) => {
      try {
        return await use(port);
      } catch (error) {
        return (await behind(error)).read(use);
      }
    },
    release: () => port.disconnect(),
  };
}

/** The primary tab's page agent, or for a tab Chrome unloaded, its origin read behind the barrier. */
export async function openPrimary(
  tab: SessionTab | UnloadedTab,
  run: PrimaryRun,
  deps: PrimaryDeps,
): Promise<PrimaryAccess> {
  if (!isLoadedTab(tab)) return unloadedAccess(tab, run, deps);
  return loadedAccess(tab, run, deps);
}
