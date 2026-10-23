import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";

/** Brings the dashboard's tab and window to the front; Chrome may still keep focus elsewhere. */
export async function focusCurrentTab(
  currentTab: () => Promise<Browser.tabs.Tab | undefined> = () => browser.tabs.getCurrent(),
): Promise<void> {
  const tab = await currentTab();
  if (tab?.id === undefined) return;
  await browser.tabs.update(tab.id, { active: true });
  await browser.windows.update(tab.windowId, { focused: true });
}
