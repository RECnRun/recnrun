import { browser } from "wxt/browser";
import type { Browser } from "wxt/browser";
import type { ToolbarPin } from "@/ports/toolbar";

/** Chrome's own answer to whether RECnRun's icon is on the toolbar. */
export const browserToolbarPin: ToolbarPin = {
  pinned: async () => (await browser.action.getUserSettings()).isOnToolbar,
  watch(onChange) {
    const listener = ({ isOnToolbar }: Browser.action.UserSettingsChange) => {
      if (isOnToolbar !== undefined) onChange(isOnToolbar);
    };
    browser.action.onUserSettingsChanged.addListener(listener);
    return () => browser.action.onUserSettingsChanged.removeListener(listener);
  },
};
