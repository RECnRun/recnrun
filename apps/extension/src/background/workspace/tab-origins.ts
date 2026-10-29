import type { IdentityCapture, SessionLayout } from "@recnrun/domain";
import type { BarrierApi, BarrierOperation } from "@/background/workspace/barrier";
import type { CaptureApi } from "@/background/workspace/capture-api";
import { visitInTab } from "@/background/workspace/helper-tab";
import type { NavigationApi } from "@/background/workspace/navigation";
import { isWebTab, sessionThrough } from "@/background/workspace/session-tabs";
import type { LayoutRead, SessionTab, SessionTabs } from "@/background/workspace/session-tabs";
import type { LayoutPlace, Visit, VisitedOrigins } from "@/ports/visited-origins";

type Unsupported = IdentityCapture["unsupported"][number];
type TabSessions = SessionLayout["windows"][number]["tabs"][number]["sessionStorage"];

/** A tab a capture moved off its page to read another origin; its page comes back unless it closes. */
export interface MovedTab {
  tabId: number;
  url: string;
}

/** What reading each tab's other origins needs from Chrome and the visit lists. */
export interface TabOriginDeps {
  api: Pick<CaptureApi, "discard">;
  barrier: BarrierApi;
  navigation: NavigationApi;
  visits: Pick<VisitedOrigins, "tabVisits">;
}

/** One capture's reading of the other origins: where it notes each moved tab and what it read. */
export interface TabOriginRun {
  operation: BarrierOperation;
  boundMs: number;
  /** Set when the windows close next: only then may a tab leave its page to read another origin. */
  live: boolean;
  /** The identity's last capture's layout, read once a carried origin needs it. */
  previous: () => Promise<SessionLayout | undefined>;
  moved: MovedTab[];
}

interface Reading {
  run: TabOriginRun;
  deps: TabOriginDeps;
  found: SessionTabs;
  read: LayoutRead;
}

const NOT_UNLOADED = "Chrome did not unload the tab, so its other origins stayed unread.";
const NOT_CLOSING =
  "A tab's other origins are read only when its identity closes, so the page stays.";

/** The entries the last capture kept for `origin` in the tab a start reopened from `from`. */
async function previousEntries(run: TabOriginRun, from: LayoutPlace | undefined, origin: string) {
  if (from === undefined) return undefined;
  const tab = (await run.previous())?.windows[from.window]?.tabs[from.tab];
  return tab?.sessionStorage.find((each) => each.origin === origin)?.entries;
}

/** Unloads the tab without its page's `beforeunload`, under the id Chrome gives it then. */
async function moveOff(tab: SessionTab, reading: Reading): Promise<number | undefined> {
  const tabId = await reading.deps.api.discard(tab.tabId).catch(() => undefined);
  if (tabId === undefined) return undefined;
  const { seen } = reading.found;
  seen.splice(seen.indexOf(tab.tabId), 1, tabId);
  reading.run.moved.push({ tabId, url: tab.url });
  return tabId;
}

/** The origin's sessionStorage in the tab, read behind the anonymous barrier, or the reason not. */
async function readIn(tabId: number | undefined, visit: Visit, reading: Reading) {
  if (tabId === undefined) {
    return { ok: false as const, reason: reading.run.live ? NOT_UNLOADED : NOT_CLOSING };
  }
  const { run, deps } = reading;
  const visiting = { operation: run.operation, work: "save" as const };
  return visitInTab({ tabId, ...visit }, visiting, deps, (agent) =>
    sessionThrough(agent, run.operation, run.boundMs),
  );
}

/** One origin the tab did not hand over, by place and origin, never by address. */
function unread(tab: SessionTab, origin: string, reason: string, kept: boolean): Unsupported {
  const suffix = kept ? " The last saved copy is kept." : "";
  return {
    adapter: "tabs",
    item: `${tab.place}, ${origin}`,
    reason: `${reason.slice(0, 160)}${suffix}`,
  };
}

/** The origins to read in the tab: each one visited live, and each carried one the last capture lacks. */
async function liveOf(visits: readonly Visit[], keep: (origin: string) => Promise<boolean>) {
  const live: Visit[] = [];
  for (const visit of visits) {
    if (visit.carry !== true || !(await keep(visit.origin))) live.push(visit);
  }
  return live;
}

/**
 * The sessionStorage of every other origin `tab` visited: a carried one as the last capture kept
 * it, each other one read in the tab, and one that is not read kept as last saved, and named.
 */
async function tabOrigins(
  tab: SessionTab,
  others: { from?: LayoutPlace; visits: Visit[] },
  reading: Reading,
): Promise<TabSessions> {
  const sessions: TabSessions = [];
  const keep = async (origin: string) => {
    const entries = await previousEntries(reading.run, others.from, origin);
    if (entries !== undefined) sessions.push({ origin, entries });
    return entries !== undefined;
  };
  const { live: closing } = reading.run;
  const live = closing ? await liveOf(others.visits, keep) : others.visits;
  const tabId = closing && live.length > 0 ? await moveOff(tab, reading) : undefined;
  for (const visit of live) {
    const outcome = await readIn(tabId, visit, reading);
    if (outcome.ok) {
      sessions.push({ origin: visit.origin, entries: outcome.value });
      reading.read.entries += Object.keys(outcome.value).length;
    } else {
      const kept = await keep(visit.origin);
      reading.read.unsupported.push(unread(tab, visit.origin, outcome.reason, kept));
    }
  }
  return sessions;
}

/**
 * Adds to the layout, for each web tab, the sessionStorage of every other origin it visited, which
 * belongs to that tab alone: the tab is unloaded first, so no page can ask to stay, then loads
 * each origin behind the anonymous barrier and hands its entries over. The caller brings back
 * every tab in `run.moved` unless its window closes.
 */
export async function readTabOrigins(
  found: SessionTabs,
  read: LayoutRead,
  run: TabOriginRun,
  deps: TabOriginDeps,
): Promise<void> {
  const lists = await deps.visits.tabVisits(run.operation.generation);
  const reading = { run, deps, found, read };
  for (const [at, window] of found.windows.entries()) {
    for (const [index, tab] of window.tabs.entries()) {
      // A blank or New Tab page reopens empty, so what it visited before is not read.
      if (!isWebTab(tab)) continue;
      const list = lists.find(({ tabId }) => tabId === tab.tabId);
      const visits = (list?.visits ?? []).filter(({ origin }) => origin !== tab.origin);
      const laid = read.layout.windows[at]?.tabs[index];
      if (visits.length === 0 || laid === undefined) continue;
      laid.sessionStorage.push(...(await tabOrigins(tab, { from: list?.from, visits }, reading)));
    }
  }
}

/** Brings each moved tab back to its page; one that cannot load it stays as it is. */
export async function returnTabs(
  api: Pick<CaptureApi, "navigate">,
  moved: readonly MovedTab[],
): Promise<void> {
  await Promise.all(moved.map(({ tabId, url }) => api.navigate(tabId, url).catch(() => undefined)));
}
