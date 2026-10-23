import type { RecordingSession } from "@recnrun/domain";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";

type Tab = Browser.tabs.Tab;
type OpenTab = Tab & { id: number };

// browser.tabs.SPLIT_VIEW_ID_NONE, which Chrome before 140 and fakeBrowser lack.
const SPLIT_VIEW_ID_NONE = -1;

/** The session storage a trigger reads and writes; the background keeps one session. */
export interface SessionStore {
  read: () => Promise<RecordingSession | null>;
  write: (session: RecordingSession | null) => Promise<void>;
}

const hasId = (tab: Tab | undefined): tab is OpenTab => tab?.id !== undefined;
const splitOf = (tab: Tab) => tab.splitViewId ?? SPLIT_VIEW_ID_NONE;
const shows = (tab: Tab, url: string) => (tab.url || tab.pendingUrl)?.startsWith(url) ?? false;

/** A trigger starts recording the tab, or moves the session in progress there. */
export function nextSession(
  current: RecordingSession | null,
  tabId: number,
  now: number,
): RecordingSession {
  if (current === null) return { tabId, status: "recording", banked: 0, since: now };
  return { ...current, tabId };
}

async function moveSessionTo(tabId: number, store: SessionStore, now: number): Promise<void> {
  // A stored session that no longer matches the schema gives way to the new one.
  const current = await store.read().catch(() => null);
  await store.write(nextSession(current, tabId, now));
}

async function focus(tab: OpenTab): Promise<void> {
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
}

/** The session's pane; the extension sees its own pages' URLs. */
async function findPane(sessionUrl: string): Promise<OpenTab | undefined> {
  const tabs = await browser.tabs.query({});
  return tabs.filter(hasId).find((each) => shows(each, sessionUrl));
}

async function openPaneNextTo(tab: OpenTab, sessionUrl: string, split: boolean): Promise<void> {
  const placement = { url: sessionUrl, windowId: tab.windowId, index: tab.index + 1 };
  if (split) {
    try {
      await browser.tabs.create({ ...placement, splitWithTabId: tab.id });
      return;
    } catch {
      // Split View can still be off, for example through a flag or an enterprise policy.
    }
  }
  await browser.tabs.create(placement);
}

/** Moves the pane beside the page without reloading it, so its state stays. */
async function movePaneNextTo(pane: OpenTab, tab: OpenTab, split: boolean): Promise<void> {
  try {
    if (splitOf(pane) !== SPLIT_VIEW_ID_NONE) await browser.tabs.unsplit(splitOf(pane));
    // Moving the pane from before the page in its window shifts the page left by one.
    const before = pane.windowId === tab.windowId && pane.index < tab.index;
    await browser.tabs.move(pane.id, {
      windowId: tab.windowId,
      index: before ? tab.index : tab.index + 1,
    });
    if (split) await browser.tabs.createSplit([tab.id, pane.id]);
  } catch {
    // The page may have closed meanwhile; the pane is still focused below.
  }
  await focus({ ...pane, windowId: tab.windowId });
}

/** A Split View holds two tabs, so a page split with another one leaves it first. */
async function leaveSplit(tab: OpenTab): Promise<void> {
  try {
    await browser.tabs.unsplit(splitOf(tab));
  } catch {
    // Creating the pane's split then fails too, and the pane opens as a tab next to the page.
  }
}

/** Where the pane goes; Split View can be missing or off, and tests set the clock. */
export interface PaneOptions {
  split?: boolean;
  now?: number;
}

async function placePane(tab: OpenTab, sessionUrl: string, split: boolean): Promise<void> {
  const pane = await findPane(sessionUrl);
  if (pane && splitOf(pane) !== SPLIT_VIEW_ID_NONE && splitOf(pane) === splitOf(tab)) {
    return focus(pane);
  }
  if (split && splitOf(tab) !== SPLIT_VIEW_ID_NONE) await leaveSplit(tab);
  if (pane) return movePaneNextTo(pane, tab, split);
  return openPaneNextTo(tab, sessionUrl, split);
}

/** Records the tab a trigger came from, with the session's pane beside it in a Split View. */
export async function openSessionFrom(
  tab: Tab | undefined,
  sessionUrl: string,
  store: SessionStore,
  { split = "createSplit" in browser.tabs, now = Date.now() }: PaneOptions = {},
): Promise<void> {
  if (!hasId(tab) || shows(tab, sessionUrl)) return;
  await moveSessionTo(tab.id, store, now);
  await placePane(tab, sessionUrl, split);
}

/** Records a tab whose session floats in a PiP window a dashboard opened, and shows that tab. */
export async function floatSessionOn(
  tabId: number,
  store: SessionStore,
  now = Date.now(),
): Promise<void> {
  const tab = await browser.tabs.get(tabId);
  if (!hasId(tab)) return;
  await moveSessionTo(tab.id, store, now);
  await focus(tab);
}

/** Ends the session when the tab it records closes. */
export async function endSessionOf(tabId: number, store: SessionStore): Promise<void> {
  const current = await store.read().catch(() => null);
  if (current?.tabId === tabId) await store.write(null);
}
