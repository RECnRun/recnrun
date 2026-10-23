import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";

type Tab = Browser.tabs.Tab;
// browser.tabs.SPLIT_VIEW_ID_NONE, which fakeBrowser lacks.
const SPLIT_VIEW_ID_NONE = -1;

/** What the session's pane does with its own tab; Chrome may still keep focus elsewhere. */
export interface SessionTab {
  /** Leaves the Split View so the recorded page fills the window while the session floats. */
  leaveSplit: () => Promise<void>;
  /** Brings the pane back, beside that page again if it left the Split View. */
  focus: () => Promise<void>;
  /** Closes the pane, once its session has ended. */
  close: () => Promise<void>;
}

async function splitAgain(partnerId: number | undefined, tabId: number): Promise<void> {
  if (partnerId === undefined) return;
  try {
    await browser.tabs.createSplit([partnerId, tabId]);
  } catch {
    // The page may have closed, moved to another window, or joined another Split View.
  }
}

export function sessionTab(
  currentTab: () => Promise<Tab | undefined> = () => browser.tabs.getCurrent(),
): SessionTab {
  let partnerId: number | undefined;
  return {
    leaveSplit: async () => {
      const tab = await currentTab();
      const splitViewId = tab?.splitViewId ?? SPLIT_VIEW_ID_NONE;
      if (tab?.id === undefined || splitViewId === SPLIT_VIEW_ID_NONE) return;
      const tabs = await browser.tabs.query({ splitViewId });
      const partner = tabs.find((each) => each.id !== tab.id);
      // The pane stays open in the background, since closing it would close the PiP window too.
      await browser.tabs.unsplit(splitViewId);
      if (partner?.id === undefined) return;
      partnerId = partner.id;
      await browser.tabs.update(partner.id, { active: true });
    },
    focus: async () => {
      const tab = await currentTab();
      if (tab?.id === undefined) return;
      // The background may have moved the pane beside another page meanwhile.
      if ((tab.splitViewId ?? SPLIT_VIEW_ID_NONE) === SPLIT_VIEW_ID_NONE) {
        await splitAgain(partnerId, tab.id);
      }
      partnerId = undefined;
      await browser.tabs.update(tab.id, { active: true });
      await browser.windows.update(tab.windowId, { focused: true });
    },
    close: async () => {
      const tab = await currentTab();
      if (tab?.id !== undefined) await browser.tabs.remove(tab.id);
    },
  };
}
