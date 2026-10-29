import { browser } from "wxt/browser";
import type { IncognitoAccess } from "@/ports/tabs";

/** Chrome's "Allow in Incognito" toggle, where to turn it on, and window and Site access events. */
export const browserIncognito: IncognitoAccess = {
  allowed: () => browser.extension.isAllowedIncognitoAccess(),
  // Only Chrome may flip the toggle, on RECnRun's details page; the id works for dev and store builds.
  openSettings: async () => {
    await browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
  },
  watchWindows: (onChange) => {
    const listener = () => onChange();
    browser.windows.onCreated.addListener(listener);
    browser.windows.onRemoved.addListener(listener);
    return () => {
      browser.windows.onCreated.removeListener(listener);
      browser.windows.onRemoved.removeListener(listener);
    };
  },
  // Chrome reports Site access withheld or granted as host permissions removed or added.
  watchSiteAccess: (onChange) => {
    const listener = () => onChange();
    browser.permissions.onAdded.addListener(listener);
    browser.permissions.onRemoved.addListener(listener);
    return () => {
      browser.permissions.onAdded.removeListener(listener);
      browser.permissions.onRemoved.removeListener(listener);
    };
  },
};
