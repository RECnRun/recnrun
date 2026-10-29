import type { SessionLayout, SkippedOrigin } from "@recnrun/domain";
import { browser } from "wxt/browser";
import { restoreThroughAgent } from "@/background/workspace/agent-link";
import type { BarrierApi, BarrierOperation } from "@/background/workspace/barrier";
import { visitInTab } from "@/background/workspace/helper-tab";
import type { NavigationApi } from "@/background/workspace/navigation";
import { BLANK_BOUND_MS, loaded } from "@/background/workspace/windows";
import type { LayoutPlace, Visit, VisitedOrigins } from "@/ports/visited-origins";

/** The windows and tabs a start reopens beside the one it restored, each on a blank page first. */
export interface LayoutApi {
  /** Opens an unfocused Incognito window on a blank page; resolves once it loaded. */
  openWindow: () => Promise<{ windowId: number; tabId: number }>;
  /** Opens a background tab on a blank page at `index` of the window; resolves once it loaded. */
  openTab: (windowId: number, index: number) => Promise<number>;
  navigate: (tabId: number, url: string) => Promise<void>;
  activate: (tabId: number) => Promise<void>;
  focus: (windowId: number) => Promise<void>;
}

/** What writing a tab's own sessionStorage needs: the barrier, and where the tab's visits are noted. */
export interface TabSessionDeps {
  barrier: BarrierApi;
  navigation: NavigationApi;
  visits: Pick<VisitedOrigins, "noteTab">;
}

export interface LayoutDeps extends TabSessionDeps {
  layout: LayoutApi;
}

/** Where the start already restored the primary tab, and what it learns about the windows. */
export interface LayoutRun {
  primary: { windowId: number; tabId: number };
  operation: BarrierOperation;
  /** Called for each window opened, so a failed start closes it too. */
  opened: (windowId: number) => void;
}

type LaidTab = SessionLayout["windows"][number]["tabs"][number];

const RESTORE_BOUND_MS = 15_000;

/** Writes one origin's entries into the tab's sessionStorage behind the anonymous barrier. */
function restoreSession(
  { tabId, laid }: { tabId: number; laid: LaidTab },
  { origin, entries }: LaidTab["sessionStorage"][number],
  operation: BarrierOperation,
  deps: TabSessionDeps,
) {
  const page = new URL(laid.url).origin === origin ? laid.url : undefined;
  const payload = { localStorage: {}, sessionStorage: entries, indexedDB: [], caches: [] };
  const scope = { boundMs: RESTORE_BOUND_MS, scope: "session" as const };
  const visiting = { operation, work: "restore" as const };
  return visitInTab({ tabId, origin, url: page }, visiting, deps, (agent) =>
    restoreThroughAgent(agent, operation, payload, scope),
  );
}

/**
 * Writes the tab's sessionStorage of each origin, then notes the origins it holds as the tab's
 * visits, from its place in the layout: one that was not taken is carried, so the next capture
 * keeps its last saved entries, unless it is the page's own origin, which the page shows as it is.
 */
export async function restoreTabSessions(
  tab: { tabId: number; laid: LaidTab; from: LayoutPlace },
  operation: BarrierOperation,
  deps: TabSessionDeps,
): Promise<SkippedOrigin[]> {
  const skipped: SkippedOrigin[] = [];
  const visits: Visit[] = [];
  for (const session of tab.laid.sessionStorage) {
    if (Object.keys(session.entries).length === 0) continue;
    const { origin } = session;
    const outcome = await restoreSession(tab, session, operation, deps);
    const kept = !outcome.ok && origin !== new URL(tab.laid.url).origin;
    visits.push(kept ? { origin, carry: true } : { origin });
    if (!outcome.ok)
      skipped.push({ origin, work: "restore", step: outcome.step, reason: outcome.reason, kept });
  }
  if (visits.length > 0)
    await deps.visits.noteTab(operation.generation, tab.tabId, visits, tab.from);
  return skipped;
}

/** The tab ids of one window, its tabs opened in order around the one it already holds. */
async function openTabs(
  windowId: number,
  held: { tabId: number; index: number },
  count: number,
  deps: LayoutDeps,
): Promise<number[]> {
  const ids: number[] = [];
  for (let index = 0; index < count; index += 1) {
    ids.push(index === held.index ? held.tabId : await deps.layout.openTab(windowId, index));
  }
  return ids;
}

/** Opens one saved window, or fills the start's own, and reopens each of its tabs but the primary. */
async function reopenWindow(at: number, layout: SessionLayout, run: LayoutRun, deps: LayoutDeps) {
  const { tabs } = layout.windows[at] ?? { tabs: [] };
  const own = at === layout.primary.window;
  const opened = own ? run.primary : await deps.layout.openWindow();
  if (!own) run.opened(opened.windowId);
  const held = { tabId: opened.tabId, index: own ? layout.primary.tab : 0 };
  const ids = await openTabs(opened.windowId, held, tabs.length, deps);
  const skipped: SkippedOrigin[] = [];
  for (const [index, laid] of tabs.entries()) {
    const tabId = ids[index] ?? -1;
    if (!(own && index === held.index)) {
      const from = { window: at, tab: index };
      skipped.push(...(await restoreTabSessions({ tabId, laid, from }, run.operation, deps)));
      await deps.layout.navigate(tabId, laid.url);
    }
    if (laid.active) await deps.layout.activate(tabId);
  }
  return { windowId: opened.windowId, skipped };
}

/**
 * Reopens every saved window and tab beside the primary tab, in their order, each tab with its
 * own sessionStorage before its page runs, then activates and focuses them as they were. A tab
 * whose sessionStorage is not taken still opens, and is named.
 */
export async function restoreLayout(
  layout: SessionLayout,
  run: LayoutRun,
  deps: LayoutDeps,
): Promise<SkippedOrigin[]> {
  const skipped: SkippedOrigin[] = [];
  let focused: number | undefined;
  for (const [at, window] of layout.windows.entries()) {
    const reopened = await reopenWindow(at, layout, run, deps);
    skipped.push(...reopened.skipped);
    if (window.focused) focused = reopened.windowId;
  }
  if (focused !== undefined) await deps.layout.focus(focused);
  return skipped;
}

async function blankTabOf(tab: { id?: number } | undefined, what: string): Promise<number> {
  if (tab?.id === undefined) throw new Error(`Chrome did not open the ${what}.`);
  // A navigation started before the blank page commits can fail with net::ERR_ABORTED.
  await loaded(tab.id, BLANK_BOUND_MS);
  return tab.id;
}

/** Chrome's windows and tabs. */
export const chromeLayoutApi: LayoutApi = {
  openWindow: async () => {
    const window = await browser.windows.create({
      incognito: true,
      url: "about:blank",
      focused: false,
    });
    if (window?.id === undefined) throw new Error("Chrome did not open the window.");
    return { windowId: window.id, tabId: await blankTabOf(window.tabs?.[0], "window") };
  },
  openTab: async (windowId, index) => {
    const tab = await browser.tabs.create({ windowId, index, url: "about:blank", active: false });
    return blankTabOf(tab, "tab");
  },
  navigate: async (tabId, url) => {
    await browser.tabs.update(tabId, { url });
  },
  activate: async (tabId) => {
    await browser.tabs.update(tabId, { active: true });
  },
  focus: async (windowId) => {
    await browser.windows.update(windowId, { focused: true });
  },
};
