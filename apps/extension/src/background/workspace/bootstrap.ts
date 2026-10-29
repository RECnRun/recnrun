import { errorMessage } from "@recnrun/domain";
import type {
  IdentityData,
  LifecycleStep,
  ManagedWindowState,
  SkippedOrigin,
  WorkspaceOperation,
} from "@recnrun/domain";
import { restoreThroughAgent } from "@/background/workspace/agent-link";
import { installBarrier, removeBarrier } from "@/background/workspace/barrier";
import type { Barrier, BarrierApi } from "@/background/workspace/barrier";
import {
  noteIncognitoStores,
  resolveTabStore,
  restoreCookies,
  waitForIncognitoGone,
} from "@/background/workspace/cookie-stores";
import type { CookieApi } from "@/background/workspace/cookie-stores";
import { collectFailures } from "@/background/workspace/errors";
import { gate, handledLater } from "@/background/workspace/gate";
import type { Gate } from "@/background/workspace/gate";
import { visitOrigins } from "@/background/workspace/helper-tab";
import type { HelperTabApi } from "@/background/workspace/helper-tab";
import { restoreLayout, restoreTabSessions } from "@/background/workspace/layout-restore";
import type { LayoutApi } from "@/background/workspace/layout-restore";
import { openBehindBarrier, reloadAndCommit } from "@/background/workspace/navigation";
import type { NavigationApi } from "@/background/workspace/navigation";
import {
  exposeResponseUrls,
  responseUrlsOf,
  withdrawResponseUrls,
} from "@/background/workspace/response-urls";
import type { OriginPort } from "@/messaging/origin-protocol";
import type { IncognitoStoreMemory } from "@/ports/incognito-stores";
import type { ResponseUrlStore } from "@/ports/response-urls";
import type { VisitedOrigins } from "@/ports/visited-origins";

/** The steps of a start with an identity, in order; the journal and the timings name them. */
export const BOOTSTRAP_STEPS = [
  "store-gone",
  "window",
  "cookie-store",
  "cookies",
  "origins",
  "barrier",
  "navigate",
  "restore",
  "unbarrier",
  "reload",
  "layout",
] as const;

type BootstrapStep = (typeof BOOTSTRAP_STEPS)[number];

/** How long one step took, in milliseconds; no payload, so timings can be logged and reported. */
export interface StepTiming {
  step: BootstrapStep;
  ms: number;
}

/** A step a test build can delay or fail: one of a start's, or one of a lifecycle command's. */
export type HookStep = BootstrapStep | LifecycleStep;

/** Runs before each step; test builds delay or fail a step through it, product builds do nothing. */
export interface BootstrapHooks {
  beforeStep: (step: HookStep) => Promise<void>;
}

/** Chrome, behind ports, plus the test hook. */
export interface BootstrapPorts {
  cookies: CookieApi;
  /** Every Incognito store id Chrome listed, probed until Chrome no longer knows any of them. */
  stores: IncognitoStoreMemory;
  navigation: NavigationApi;
  barrier: BarrierApi;
  /** The hidden tab the other visited origins are restored in. */
  helperTabs: HelperTabApi;
  /** The session's other windows and tabs, reopened as the identity left them. */
  layout: LayoutApi;
  visits: VisitedOrigins;
  /** The URLs the restored cache entries were fetched from, which their pages show. */
  responseUrls: ResponseUrlStore;
  hooks: BootstrapHooks;
}

export interface BootstrapDeps extends BootstrapPorts {
  windows: {
    create: () => Promise<ManagedWindowState>;
    close: (ids: readonly number[]) => Promise<void>;
  };
  /** Receives the operation at each step and at its end. */
  record: (operation: WorkspaceOperation) => Promise<void>;
  storeBoundMs?: number;
}

const NAVIGATION_BOUND_MS = 15_000;
const RESTORE_BOUND_MS = 15_000;

/** What the steps learn as they run. */
interface Run {
  url: string;
  origin: string;
  data: IdentityData;
  deps: BootstrapDeps;
  operation: WorkspaceOperation;
  window?: ManagedWindowState;
  storeId?: string;
  barrier?: Barrier;
  agent?: OriginPort;
  /** Set once the page script that shows restored responses' URLs may be registered. */
  exposed?: boolean;
  /** The windows the layout opened beside the start's own. */
  opened: number[];
  /** The identity's other tabs and windows, reopening while the primary tab restores. */
  layout?: Promise<void>;
  /** Settles once the primary's storage is back, or the start failed first. */
  released: Gate;
}

function known<T>(value: T | undefined, what: string): T {
  if (value === undefined) throw new Error(`The start lost its ${what}.`);
  return value;
}

const tabOf = (run: Run) => known(run.window, "window").tabId;
const barrierOperation = (run: Run) => ({
  id: run.operation.id,
  generation: known(run.window, "window").generation,
});

/**
 * Restores the other visited origins in the helper tab. One that does not answer or whose page
 * fails is skipped, and the next capture keeps its last saved storage, since the window lacks it.
 */
async function restoreOthers(run: Run): Promise<void> {
  const { generation, windowId } = known(run.window, "window");
  const others = run.data.origins;
  // Noted first, so the next capture keeps them even when the app never loads them again.
  await run.deps.visits.note(
    generation,
    [run, ...others].map(({ origin }) => ({ origin })),
  );
  const operation = barrierOperation(run);
  const { helperTabs: tabs, barrier, navigation } = run.deps;
  const visiting = { windowId, operation, work: "restore" as const };
  const outcomes = await visitOrigins(
    others,
    visiting,
    { tabs, barrier, navigation },
    (agent, other) => {
      const { origin: _origin, ...site } = other;
      return restoreThroughAgent(agent, operation, site, { boundMs: RESTORE_BOUND_MS });
    },
  );
  const skipped = outcomes.flatMap((outcome) =>
    outcome.ok
      ? []
      : [
          {
            origin: outcome.origin,
            work: "restore" as const,
            step: outcome.step,
            reason: outcome.reason,
            kept: true,
          },
        ],
  );
  if (skipped.length === 0) return;
  await run.deps.visits.note(
    generation,
    skipped.map(({ origin }) => ({ origin, carry: true })),
  );
  run.operation = { ...run.operation, skipped };
}

const skippedAlso = (run: Run, skipped: readonly SkippedOrigin[]) => {
  if (skipped.length > 0) {
    run.operation = { ...run.operation, skipped: [...(run.operation.skipped ?? []), ...skipped] };
  }
};

/** Writes the primary tab's sessionStorage of the other origins it visited, which is its own. */
async function restorePrimarySessions(run: Run): Promise<void> {
  const { layout } = run.data;
  const laid = layout?.windows[layout.primary.window]?.tabs[layout.primary.tab];
  if (layout === undefined || laid === undefined) return;
  const tab = { tabId: tabOf(run), laid, from: layout.primary };
  skippedAlso(run, await restoreTabSessions(tab, barrierOperation(run), run.deps));
}

/** Reopens the identity's other tabs and windows; one whose sessionStorage is not taken is named. */
async function reopenLayout(run: Run): Promise<void> {
  const { layout } = run.data;
  if (layout === undefined) return;
  const { windowId, tabId } = known(run.window, "window");
  const opened = (id: number) => run.opened.push(id);
  // Its own barrier lane, so its tabs' barriers stand beside the primary tab's.
  const operation = { ...barrierOperation(run), lane: 1 };
  const reopening = {
    primary: { windowId, tabId },
    origin: run.origin,
    released: run.released.promise,
    operation,
    opened,
  };
  skippedAlso(run, await restoreLayout(layout, reopening, run.deps));
}

const STEP_RUNS: Record<BootstrapStep, (run: Run) => Promise<unknown>> = {
  "store-gone": (run) =>
    waitForIncognitoGone(run.deps.cookies, run.deps.stores, run.deps.storeBoundMs),
  window: async (run) => {
    run.window = await run.deps.windows.create();
    const { generation, windowId } = run.window;
    run.operation = { ...run.operation, generation, windowId };
    // Journaled at once, so a restart from here on finds the window to close.
    await run.deps.record(run.operation);
  },
  "cookie-store": async (run) => {
    run.storeId = await resolveTabStore(run.deps.cookies, tabOf(run));
    await noteIncognitoStores(run.deps.cookies, run.deps.stores);
  },
  cookies: (run) =>
    restoreCookies(
      run.deps.cookies,
      known(run.storeId, "cookie store"),
      run.origin,
      run.data.cookies,
    ),
  origins: async (run) => {
    await restoreOthers(run);
    await restorePrimarySessions(run);
  },
  barrier: async (run) => {
    // Registered before the layout's tabs and the reloaded page run, since they read them.
    run.exposed = true;
    const urls = responseUrlsOf(run.origin, run.data);
    await exposeResponseUrls(known(run.window, "window").generation, urls, run.deps);
    const operation = barrierOperation(run);
    run.barrier = await installBarrier(tabOf(run), run.origin, operation, run.deps.barrier);
    run.layout = handledLater(reopenLayout(run));
  },
  navigate: async (run) => {
    const target = { tabId: tabOf(run), url: run.url, origin: run.origin };
    run.agent = await openBehindBarrier(run.deps.navigation, target, NAVIGATION_BOUND_MS);
  },
  restore: async (run) => {
    const agent = known(run.agent, "page link");
    await restoreThroughAgent(agent, barrierOperation(run), run.data.site, {
      boundMs: RESTORE_BOUND_MS,
    });
    agent.disconnect();
  },
  unbarrier: async (run) => {
    await removeBarrier(known(run.barrier, "barrier"), run.deps.barrier);
    run.barrier = undefined;
    run.released.open();
  },
  reload: (run) => {
    const documentId = known(run.agent?.sender?.documentId, "document");
    const released = { tabId: tabOf(run), documentId };
    return reloadAndCommit(run.deps.navigation, released, NAVIGATION_BOUND_MS);
  },
  layout: (run) => run.layout ?? Promise.resolve(),
};

/** Undoes what the failed start left: the page link, the windows, then the barrier. */
async function cleanUp(run: Run): Promise<string[]> {
  const { failures, attempt } = collectFailures();
  run.agent?.disconnect();
  // The layout settles first, so every window it opened is known to close.
  await run.layout?.catch(() => undefined);
  const { window, barrier } = run;
  if (window) await attempt(() => run.deps.windows.close([window.windowId, ...run.opened]));
  if (barrier) await attempt(() => removeBarrier(barrier, run.deps.barrier));
  if (run.exposed === true) await attempt(() => withdrawResponseUrls(run.deps.barrier));
  return failures;
}

/** Records the failure before cleaning up, so whoever watches the window closing sees why. */
async function fail(run: Run, error: unknown): Promise<never> {
  const message = errorMessage(error);
  // A journal that cannot be written must not keep the window open; the caller still gets the error.
  const record = () => run.deps.record(run.operation).catch(() => undefined);
  run.operation = { ...run.operation, status: "failed", error: message };
  await record();
  run.released.shut(error);
  const failures = await cleanUp(run);
  if (failures.length > 0) {
    run.operation = {
      ...run.operation,
      error: `${message} Cleanup also failed: ${failures.join(" ")}`,
    };
    await record();
  }
  throw error;
}

/**
 * Opens a fresh managed window and restores `data` into it before the app at `url` runs: cookies
 * into the tab's own store, the other visited origins' site data in a helper tab, then the target's
 * behind the barrier, then a reload of the same tab releases the app. The identity's other tabs
 * and windows reopen meanwhile, a page of the target's origin only once its storage is back. Any failure closes every window the start opened, so no partly
 * restored app is ever released.
 */
export async function bootstrapIdentity(
  url: string,
  data: IdentityData,
  deps: BootstrapDeps,
  operationId: string,
): Promise<StepTiming[]> {
  const operation: WorkspaceOperation = {
    id: operationId,
    kind: "start-with-identity",
    step: "store-gone",
    status: "running",
    started: Date.now(),
  };
  const run: Run = {
    url,
    origin: new URL(url).origin,
    data,
    deps,
    operation,
    opened: [],
    released: gate(),
  };
  const timings: StepTiming[] = [];
  try {
    for (const step of BOOTSTRAP_STEPS) {
      run.operation = { ...run.operation, step };
      await deps.record(run.operation);
      await deps.hooks.beforeStep(step);
      const started = performance.now();
      await STEP_RUNS[step](run);
      timings.push({ step, ms: performance.now() - started });
    }
  } catch (error) {
    return fail(run, error);
  }
  run.operation = { ...run.operation, status: "done" };
  await deps.record(run.operation);
  return timings;
}
