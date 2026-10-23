import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { ShowWorkspaceMessageSchema } from "@/messaging/dashboard-protocol";

type OpenTab = Browser.tabs.Tab & { id: number };

const hasId = (tab: Browser.tabs.Tab | undefined): tab is OpenTab => tab?.id !== undefined;

/** The top-level dashboard's own browser tab, of which the browser keeps one. */
export interface DashboardTab {
  /** Brings this tab and its window to the front. */
  focus: () => Promise<void>;
  /** Closes this tab, which leaves the open dashboard tab the only one. */
  close: () => Promise<void>;
  /** Calls back with the workspace of the page the background moved this tab beside. */
  onShowWorkspace: (listener: (workspace?: string) => void) => () => void;
}

export function dashboardTab(
  currentTab: () => Promise<Browser.tabs.Tab | undefined> = () => browser.tabs.getCurrent(),
): DashboardTab {
  return {
    focus: async () => {
      const me = await currentTab();
      if (!hasId(me)) return;
      await browser.tabs.update(me.id, { active: true });
      await browser.windows.update(me.windowId, { focused: true });
    },
    close: async () => {
      const me = await currentTab();
      if (hasId(me)) await browser.tabs.remove(me.id);
    },
    onShowWorkspace: (listener) => {
      const onMessage = (message: unknown, sender: { id?: string }) => {
        const parsed = v.safeParse(ShowWorkspaceMessageSchema, message);
        if (sender.id !== browser.runtime.id || !parsed.success) return;
        const { tabId, workspace } = parsed.output;
        void currentTab().then((me) => me?.id === tabId && listener(workspace));
      };
      browser.runtime.onMessage.addListener(onMessage);
      return () => browser.runtime.onMessage.removeListener(onMessage);
    },
  };
}
