import { errorMessage, isAllowedTarget } from "@recnrun/domain";
import type { IdentityCapture, SessionLayout } from "@recnrun/domain";
import { captureThroughAgent } from "@/background/workspace/agent-link";
import type { BarrierOperation } from "@/background/workspace/barrier";
import { connectAgent } from "@/background/workspace/capture-api";
import type { CaptureApi, SessionWindow } from "@/background/workspace/capture-api";
import { WorkspaceError } from "@/background/workspace/errors";

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

/** The session's web tabs by window, the tab a capture reads in full, and the tabs left out. */
export interface SessionTabs {
  windows: { focused: boolean; tabs: SessionTab[] }[];
  primary: SessionTab;
  unsupported: Unsupported[];
  /** Every tab of the session, web or not, so the close can tell one opened since. */
  seen: number[];
}

const LEFT_OUT = "RECnRun reopens only http and https pages.";

/** A tab's place, never its URL, which stays out of what a capture names. */
const placeOf = (window: number, tab: number) => `window ${window + 1}, tab ${tab + 1}`;

async function webTabsOf(api: CaptureApi, window: SessionWindow, at: number, left: Unsupported[]) {
  const tabs: SessionTab[] = [];
  for (const [index, { id: tabId, active }] of window.tabs.entries()) {
    const frame = await api.topFrame(tabId);
    const place = placeOf(at, index);
    if (frame && isAllowedTarget(frame.url)) {
      const { url, documentId } = frame;
      const { origin } = new URL(url);
      tabs.push({ tabId, windowId: window.id, active, url, origin, documentId, place });
    } else left.push({ adapter: "tabs", item: place, reason: LEFT_OUT });
  }
  return tabs;
}

/**
 * Every web tab of the session in order, and the one a capture reads in full: the managed tab while
 * it is open, else the focused window's active tab, else the first.
 */
export async function findSessionTabs(api: CaptureApi, managedTabId: number): Promise<SessionTabs> {
  const unsupported: Unsupported[] = [];
  const windows: SessionTabs["windows"] = [];
  const all = await api.windows();
  for (const [at, window] of all.entries()) {
    const tabs = await webTabsOf(api, window, at, unsupported);
    if (tabs.length > 0) windows.push({ focused: window.focused, tabs });
  }
  const web = windows.flatMap(({ tabs }) => tabs);
  const focused = windows.find(({ focused: has }) => has)?.tabs.find(({ active }) => active);
  const primary = web.find(({ tabId }) => tabId === managedTabId) ?? focused ?? web[0];
  if (primary === undefined) {
    throw new WorkspaceError("TargetNotAllowed", "Only http and https pages can be captured.");
  }
  const seen = all.flatMap(({ tabs }) => tabs.map(({ id }) => id));
  return { windows, primary, unsupported, seen };
}

const ignore = () => undefined;

/** Reads one tab's own sessionStorage through an agent injected into its document. */
async function readTabSession(
  api: CaptureApi,
  tab: SessionTab,
  operation: BarrierOperation,
  boundMs: number,
): Promise<Entries> {
  const port = await connectAgent(api, tab, boundMs);
  try {
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
  api: CaptureApi;
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
 * Lays the session out as it is: each web tab's address and, for every tab but the primary one,
 * whose origin the capture reads in full, its own sessionStorage. A tab whose read fails reopens
 * without it, and is named.
 */
export async function readLayout(found: SessionTabs, reader: Reader): Promise<LayoutRead> {
  const layout: SessionLayout = { windows: [], primary: { window: 0, tab: 0 } };
  const read: LayoutRead = { layout, unsupported: [], entries: 0 };
  for (const [at, { focused, tabs }] of found.windows.entries()) {
    const laid: SessionLayout["windows"][number]["tabs"] = [];
    for (const [index, tab] of tabs.entries()) {
      const primary = tab === found.primary;
      if (primary) layout.primary = { window: at, tab: index };
      const sessionStorage = primary ? [] : await sessionOf(tab, read, reader);
      laid.push({ url: tab.url, active: tab.active, sessionStorage });
    }
    layout.windows.push({ focused, tabs: laid });
  }
  return read;
}
