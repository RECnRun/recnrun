import { errorMessage, isAllowedTarget, isPlainPage } from "@recnrun/domain";
import type { IdentityCapture, SessionLayout } from "@recnrun/domain";
import { captureThroughAgent } from "@/background/workspace/agent-link";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { connectAgent } from "@/background/workspace/capture-api";
import type { SessionWindow, TabReadApi } from "@/background/workspace/capture-api";
import { WorkspaceError } from "@/background/workspace/errors";
import type { OriginPort } from "@/messaging/origin-protocol";

type Unsupported = IdentityCapture["unsupported"][number];
type Entries = Record<string, string>;

/** One web tab of the session: where it sits, and the top document Chrome committed in it. */
export interface SessionTab {
  tabId: number;
  windowId: number;
  active: boolean;
  url: string;
  origin: string;
  documentId: string;
  /** Where the user sees it, as a capture names a tab it left out. */
  place: string;
}

/** A web tab Chrome unloaded: no document runs in it, so a capture reads it behind the barrier. */
export interface UnloadedTab {
  tabId: number;
  windowId: number;
  active: boolean;
  url: string;
  origin: string;
  place: string;
}

/** A blank tab or the New Tab page: a start reopens it at its place. */
interface PlainTab {
  tabId: number;
  windowId: number;
  active: boolean;
  url: "about:blank" | "chrome://newtab/";
  place: string;
}

export type FoundTab = SessionTab | UnloadedTab | PlainTab;

/** Whether the tab holds a web page, loaded or not, which a capture reads. */
export const isWebTab = (tab: FoundTab): tab is SessionTab | UnloadedTab => "origin" in tab;

/** Whether the tab's page runs, so its own agent can hand its sessionStorage over. */
export const isLoadedTab = (tab: FoundTab): tab is SessionTab => "documentId" in tab;

/** The session's tabs by window, the tab a capture reads in full, and the tabs left out. */
export interface SessionTabs {
  windows: { focused: boolean; tabs: FoundTab[] }[];
  primary: SessionTab | UnloadedTab;
  unsupported: Unsupported[];
  /** Every tab of the session, web or not, so the close can tell one opened since. */
  seen: number[];
}

const UNREAD = "RECnRun could not read the tab's page.";

/** Why a tab of another scheme stays out, by its scheme alone, never its address. */
const leftOut = (url: string) =>
  `RECnRun reopens web pages, blank tabs, and New Tab pages, not ${URL.parse(url)?.protocol ?? "these"} pages.`;

/** A tab's place, never its URL, which stays out of what a capture names. */
const placeOf = (window: number, tab: number) => `window ${window + 1}, tab ${tab + 1}`;

/** The tab as a capture keeps it, or why it stays out; a page without a document is unloaded. */
function foundTab(
  page: { url: string; documentId?: string } | null,
  at: { tabId: number; windowId: number; active: boolean; place: string },
): FoundTab | string {
  if (page === null) return UNREAD;
  const { url, documentId } = page;
  if (isPlainPage(url)) return { ...at, url };
  if (!isAllowedTarget(url)) return leftOut(url);
  const origin = new URL(url).origin;
  return documentId === undefined ? { ...at, url, origin } : { ...at, url, origin, documentId };
}

/** The tab's top document, or for a tab Chrome unloaded only the address it shows. */
async function pageOf(api: TabReadApi, tab: SessionWindow["tabs"][number]) {
  if (tab.discarded !== true) return api.topFrame(tab.id);
  return tab.url === undefined ? null : { url: tab.url };
}

async function tabsOf(api: TabReadApi, window: SessionWindow, at: number, left: Unsupported[]) {
  const tabs: FoundTab[] = [];
  for (const [index, each] of window.tabs.entries()) {
    const place = placeOf(at, index);
    const { id: tabId, active } = each;
    const tab = foundTab(await pageOf(api, each), { tabId, windowId: window.id, active, place });
    if (typeof tab === "string") left.push({ adapter: "tabs", item: place, reason: tab });
    else tabs.push(tab);
  }
  return tabs;
}

/** The window Chrome reports focused, else the one noted focused last while it is still open. */
function focusedOf(all: readonly SessionWindow[], lastFocused: number | undefined) {
  return all.find(({ focused }) => focused)?.id ?? lastFocused;
}

/** The tab to read in full among `tabs`: the managed one, else the focused window's active one, else the first. */
function primaryOf(
  windows: SessionTabs["windows"],
  accepts: (tab: FoundTab) => boolean,
  managed: number,
) {
  const web = windows.flatMap((window) => window.tabs.filter(isWebTab).filter(accepts));
  const focused = windows
    .find(({ focused: has }) => has)
    ?.tabs.filter(isWebTab)
    .find((tab) => tab.active && accepts(tab));
  return web.find(({ tabId }) => tabId === managed) ?? focused ?? web[0];
}

/**
 * Every web, blank, and New Tab page of the session in order, and the one a capture reads in full:
 * among the loaded web tabs, else among those Chrome unloaded, the managed tab while it is open,
 * else the focused window's active tab, else the first. `lastFocused` is the Incognito window that
 * had the focus last, since the dashboard holds it when the user asks to save.
 */
export async function findSessionTabs(
  api: TabReadApi,
  managedTabId: number,
  lastFocused?: number,
): Promise<SessionTabs> {
  const unsupported: Unsupported[] = [];
  const windows: SessionTabs["windows"] = [];
  const all = await api.windows();
  const focusedId = focusedOf(all, lastFocused);
  for (const [at, window] of all.entries()) {
    const tabs = await tabsOf(api, window, at, unsupported);
    if (tabs.length > 0) windows.push({ focused: window.id === focusedId, tabs });
  }
  const primary =
    primaryOf(windows, isLoadedTab, managedTabId) ?? primaryOf(windows, isWebTab, managedTabId);
  if (primary === undefined) {
    throw new WorkspaceError("TargetNotAllowed", "Only http and https pages can be captured.");
  }
  const seen = all.flatMap(({ tabs }) => tabs.map(({ id }) => id));
  return { windows, primary, unsupported, seen };
}

const ignore = () => undefined;

/** Reads the sessionStorage of the document behind `port`, checked against the agent's count. */
export async function sessionThrough(
  port: OriginPort,
  operation: BarrierOperation,
  boundMs: number,
): Promise<Entries> {
  let entries: Entries = {};
  const storage = ({ sessionStorage }: { sessionStorage: Entries }) => {
    entries = sessionStorage;
  };
  const receiver = { storage, database: ignore, records: ignore, cache: ignore };
  const scope = { idleMs: boundMs, scope: "session" as const };
  const { counts } = await captureThroughAgent(port, operation, receiver, scope);
  if (Object.keys(entries).length !== counts.sessionStorage) {
    throw new Error("The tab's sessionStorage arrived incomplete.");
  }
  return entries;
}

/** Reads one tab's own sessionStorage through an agent injected into its document. */
async function readTabSession(
  api: TabReadApi,
  tab: SessionTab,
  operation: BarrierOperation,
  boundMs: number,
): Promise<Entries> {
  const port = await connectAgent(api, tab, boundMs);
  try {
    return await sessionThrough(port, operation, boundMs);
  } finally {
    port.disconnect();
  }
}

/** What the layout came to: the windows and tabs to reopen, and the tabs whose storage stayed out. */
export interface LayoutRead {
  layout: SessionLayout;
  unsupported: Unsupported[];
  /** The sessionStorage entries the other tabs held. */
  entries: number;
}

type TabSessions = SessionLayout["windows"][number]["tabs"][number]["sessionStorage"];

interface Reader {
  api: TabReadApi;
  operation: BarrierOperation;
  boundMs: number;
}

/** A tab's own sessionStorage, or none when its page does not hand it over; that tab is named. */
async function sessionOf(tab: SessionTab, read: LayoutRead, reader: Reader) {
  try {
    const entries = await readTabSession(reader.api, tab, reader.operation, reader.boundMs);
    read.entries += Object.keys(entries).length;
    return [{ origin: tab.origin, entries }] satisfies TabSessions;
  } catch (error) {
    const reason = errorMessage(error).slice(0, 200) || "Unknown failure.";
    read.unsupported.push({ adapter: "tabs", item: tab.place, reason });
    return [];
  }
}

/**
 * Lays the session out as it is: each tab's address and, for every loaded web tab but the primary
 * one, whose origin the capture reads in full, its own sessionStorage. A tab whose read fails
 * reopens without it, and is named; an unloaded tab's comes with its other origins.
 */
export async function readLayout(found: SessionTabs, reader: Reader): Promise<LayoutRead> {
  const layout: SessionLayout = { windows: [], primary: { window: 0, tab: 0 } };
  const read: LayoutRead = { layout, unsupported: [], entries: 0 };
  for (const [at, { focused, tabs }] of found.windows.entries()) {
    const laid: SessionLayout["windows"][number]["tabs"] = [];
    for (const [index, tab] of tabs.entries()) {
      const primary = tab === found.primary;
      if (primary) layout.primary = { window: at, tab: index };
      const own = !primary && isLoadedTab(tab);
      const sessionStorage = own ? await sessionOf(tab, read, reader) : [];
      laid.push({ url: tab.url, active: tab.active, sessionStorage });
    }
    layout.windows.push({ focused, tabs: laid });
  }
  return read;
}
