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

/** What a visit needs besides a tab: the barrier and the navigation behind it. */
type BarrierDeps = Pick<HelperDeps, "barrier" | "navigation">;

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

/** What one origin's visit came to: the work's result, or the step and reason it gave up at. */
export type VisitOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; origin: string; step: "navigate" | Work; reason: string };

/** A page's reason as a skipped origin keeps it: short, and never empty. */
const reasonOf = (error: unknown) => errorMessage(error).slice(0, 200) || "Unknown failure.";

/** The origin's root first, then the last page the window showed there, when it is another one. */
function pagesOf({ origin, url }: { origin: string; url?: string }): [string, ...string[]] {
  const root = `${origin}/`;
  return url === undefined || url === root ? [root] : [root, url];
}

/** Loads one page behind the barrier and hands its agent to `use`, then ends the link. */
async function attempt<T>(
  place: Place & { url: string },
  work: Work,
  deps: BarrierDeps,
  use: (agent: OriginPort) => Promise<T>,
): Promise<VisitOutcome<T>> {
  let agent: OriginPort;
  try {
    agent = await openBehindBarrier(deps.navigation, place, NAVIGATION_BOUND_MS);
  } catch (error) {
    return { ok: false, origin: place.origin, step: "navigate", reason: reasonOf(error) };
  }
  try {
    return { ok: true, value: await use(agent) };
  } catch (error) {
    return { ok: false, origin: place.origin, step: work, reason: reasonOf(error) };
  } finally {
    agent.disconnect();
  }
}

/**
 * Visits one origin behind an anonymous barrier, so neither its scripts nor its server touch the
 * identity, trying each of its pages until one works; the barrier is gone again when this resolves.
 * A page that does not load or whose work fails is an outcome; a barrier that fails is fatal.
 */
async function visit<T>(
  { pages: [root, ...others], ...place }: Place & { pages: readonly [string, ...string[]] },
  { operation, work }: Pick<Visit, "operation" | "work">,
  deps: BarrierDeps,
  use: (agent: OriginPort) => Promise<T>,
): Promise<VisitOutcome<T>> {
  const barrier = await installAnonymousBarrier(
    place.tabId,
    place.origin,
    operation,
    deps.barrier,
  ).catch((error: unknown) => {
    throw failed(place.origin, work, "barrier", error);
  });
  let outcome = await attempt({ ...place, url: root }, work, deps, use);
  for (const url of others) {
    if (outcome.ok) break;
    outcome = await attempt({ ...place, url }, work, deps, use);
  }
  await removeBarrier(barrier, deps.barrier).catch((error: unknown) => {
    throw failed(place.origin, work, "unbarrier", error);
  });
  return outcome;
}

/**
 * Runs `use` with the agent of each origin in turn, in one helper tab opened in the managed window
 * and closed after, and returns each origin's outcome: an origin that does not answer or whose
 * work fails is skipped, while a tab or barrier failure ends the visits and names its origin.
 */
export async function visitOrigins<I extends { origin: string; url?: string }, T>(
  items: readonly I[],
  visiting: Visit,
  deps: HelperDeps,
  use: (agent: OriginPort, item: I) => Promise<T>,
): Promise<VisitOutcome<T>[]> {
  const [first] = items;
  if (first === undefined) return [];
  const tabId = await deps.tabs.open(visiting.windowId).catch((error: unknown) => {
    throw failed(first.origin, visiting.work, "tab", error);
  });
  const outcomes: VisitOutcome<T>[] = [];
  try {
    for (const item of items) {
      const place = { tabId, origin: item.origin, pages: pagesOf(item) };
      outcomes.push(await visit(place, visiting, deps, (agent) => use(agent, item)));
    }
  } catch (error) {
    // The window's own cleanup, or the next status read, finds a tab this could not close.
    await deps.tabs.close(tabId).catch(() => undefined);
    throw error;
  }
  await deps.tabs.close(tabId);
  return outcomes;
}

/** The helper tabs open now, and the tabs a visit borrows, so the visit tracker leaves their pages out. */
const helperTabs = new Set<number>();

/**
 * Visits one origin behind an anonymous barrier in a tab the caller opened or unloaded, as the
 * helper tab does, so a tab's own sessionStorage there is written or read without its page running.
 * The caller notes what the tab holds after: the barrier's pages are not the user's visits.
 */
export async function visitInTab<T>(
  { tabId, ...item }: { tabId: number; origin: string; url?: string },
  visiting: Pick<Visit, "operation" | "work">,
  deps: BarrierDeps,
  use: (agent: OriginPort) => Promise<T>,
): Promise<VisitOutcome<T>> {
  const borrowed = !helperTabs.has(tabId);
  helperTabs.add(tabId);
  try {
    return await visit({ tabId, origin: item.origin, pages: pagesOf(item) }, visiting, deps, use);
  } finally {
    if (borrowed) helperTabs.delete(tabId);
  }
}

export const isHelperTab = (tabId: number): boolean => helperTabs.has(tabId);

/** Chrome's tabs; `tabs.remove` replies once the tab is destroyed (tabs_api.cc:3236-3345). */
export const chromeHelperTabApi: HelperTabApi = {
  open: async (windowId) => {
    const tab = await browser.tabs.create({ windowId, url: "about:blank", active: false });
    if (tab.id === undefined) throw new Error("Chrome did not open the helper tab.");
    helperTabs.add(tab.id);
    // A navigation started before the blank page commits can fail with net::ERR_ABORTED.
    await loaded(tab.id, BLANK_BOUND_MS);
    return tab.id;
  },
  close: async (tabId) => {
    try {
      await browser.tabs.remove(tabId);
    } finally {
      helperTabs.delete(tabId);
    }
  },
};
