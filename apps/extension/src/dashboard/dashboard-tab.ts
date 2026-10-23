import * as v from "valibot";
import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import { ShowWorkspaceMessageSchema } from "@/messaging/dashboard-protocol";

type OpenTab = Browser.tabs.Tab & { id: number };

const hasId = (tab: Browser.tabs.Tab | undefined): tab is OpenTab => tab?.id !== undefined;

/** The top-level dashboard's own browser tab, of which the browser keeps one. */
export interface DashboardTab {
  /** Closes this tab when an earlier dashboard tab is open, which takes over this tab's route. */
  yieldToEarlier: (address: URL) => Promise<void>;
  /** Calls back with the workspace of the page the background moved this tab beside. */
  onShowWorkspace: (listener: (workspace?: string) => void) => () => void;
}

async function earlierDashboard(me: OpenTab, page: string): Promise<OpenTab | undefined> {
  const tabs = await browser.tabs.query({});
  const earlier = tabs
    .filter(hasId)
    .filter((each) => each.id < me.id && each.url?.startsWith(page));
  return earlier.sort((a, b) => a.id - b.id)[0];
}

export function dashboardTab(
  currentTab: () => Promise<Browser.tabs.Tab | undefined> = () => browser.tabs.getCurrent(),
): DashboardTab {
  return {
    yieldToEarlier: async (address) => {
      const me = await currentTab();
      if (!hasId(me)) return;
      const { protocol, host, pathname } = address;
      const earlier = await earlierDashboard(me, `${protocol}//${host}${pathname}`);
      if (earlier?.url === undefined) return;
      // A hash-only change does not reload the earlier tab, so its PiP panel stays open.
      const [base = earlier.url] = earlier.url.split("#");
      if (address.hash) await browser.tabs.update(earlier.id, { url: base + address.hash });
      await browser.tabs.update(earlier.id, { active: true });
      await browser.windows.update(earlier.windowId, { focused: true });
      await browser.tabs.remove(me.id);
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
