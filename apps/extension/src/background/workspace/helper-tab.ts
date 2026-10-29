import { errorMessage } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { installAnonymousBarrier, removeBarrier } from "@/background/workspace/barrier";
import type { BarrierApi, BarrierOperation } from "@/background/workspace/barrier";
import { WorkspaceError } from "@/background/workspace/errors";
import { openBehindBarrier } from "@/background/workspace/navigation";
import type { NavigationApi } from "@/background/workspace/navigation";
import { BLANK_BOUND_MS, loaded } from "@/background/workspace/windows";
import type { OriginPort } from "@/messaging/origin-protocol";

/** The hidden tab other origins load in, beside the managed tab in its window. */
export interface HelperTabApi {
  /** Opens a background tab on a blank page in `windowId` and resolves once it loaded. */
  open: (windowId: number) => Promise<number>;
  /** Resolves once Chrome destroyed the tab. */
  close: (tabId: number) => Promise<void>;
}

export interface HelperDeps {
  tabs: HelperTabApi;
  barrier: BarrierApi;
  navigation: NavigationApi;
}

/** What the helper does with each origin's agent; it names the step in the errors. */
type Work = "save" | "restore";

interface Visit {
  windowId: number;
  operation: BarrierOperation;
  work: Work;
}

const NAVIGATION_BOUND_MS = 15_000;

function failed(origin: string, work: Work, step: string, error: unknown): WorkspaceError {
  const message = `Could not ${work} the site data of ${origin} at its ${step} step: ${errorMessage(error)}`;
  return new WorkspaceError("VisitedOriginFailed", message);
}

interface Place {
  tabId: number;
  origin: string;
}

/** Loads the origin's root behind the barrier and hands its agent to `use`, then ends the link. */
async function withAgent<T>(
  place: Place,
  step: { name: string; work: Work },
  deps: HelperDeps,
  use: (agent: OriginPort) => Promise<T>,
): Promise<T> {
  step.name = "navigate";
  const target = { ...place, url: `${place.origin}/` };
  const agent = await openBehindBarrier(deps.navigation, target, NAVIGATION_BOUND_MS);
  step.name = step.work;
  try {
    return await use(agent);
  } finally {
    agent.disconnect();
  }
}

/**
 * Visits one origin behind an anonymous barrier, so neither its scripts nor its server touch the
 * identity; the barrier is gone again when this resolves.
 */
async function visit<T>(
  place: Place,
  { operation, work }: Visit,
  deps: HelperDeps,
  use: (agent: OriginPort) => Promise<T>,
): Promise<T> {
  const step = { name: "barrier", work };
  try {
    const barrier = await installAnonymousBarrier(
      place.tabId,
      place.origin,
      operation,
      deps.barrier,
    );
    const result = await withAgent(place, step, deps, use).catch(async (error: unknown) => {
      await removeBarrier(barrier, deps.barrier).catch(() => undefined);
      throw error;
    });
    step.name = "unbarrier";
    await removeBarrier(barrier, deps.barrier);
    return result;
  } catch (error) {
    throw failed(place.origin, work, step.name, error);
  }
}

/**
 * Runs `use` with the agent of each origin in turn, in one helper tab opened in the managed window
 * and closed after; the first failure ends the visits and names its origin and step.
 */
export async function visitOrigins<I extends { origin: string }, T>(
  items: readonly I[],
  visiting: Visit,
  deps: HelperDeps,
  use: (agent: OriginPort, item: I) => Promise<T>,
): Promise<T[]> {
  const [first] = items;
  if (first === undefined) return [];
  const tabId = await deps.tabs.open(visiting.windowId).catch((error: unknown) => {
    throw failed(first.origin, visiting.work, "tab", error);
  });
  const results: T[] = [];
  try {
    for (const item of items) {
      const place = { tabId, origin: item.origin };
      results.push(await visit(place, visiting, deps, (agent) => use(agent, item)));
    }
  } catch (error) {
    // The window's own cleanup, or the next status read, finds a tab this could not close.
    await deps.tabs.close(tabId).catch(() => undefined);
    throw error;
  }
  await deps.tabs.close(tabId);
  return results;
}

/** Chrome's tabs; `tabs.remove` replies once the tab is destroyed (tabs_api.cc:3236-3345). */
export const chromeHelperTabApi: HelperTabApi = {
  open: async (windowId) => {
    const tab = await browser.tabs.create({ windowId, url: "about:blank", active: false });
    if (tab.id === undefined) throw new Error("Chrome did not open the helper tab.");
    // A navigation started before the blank page commits can fail with net::ERR_ABORTED.
    await loaded(tab.id, BLANK_BOUND_MS);
    return tab.id;
  },
  close: (tabId) => browser.tabs.remove(tabId),
};
