import { browser } from "wxt/browser";
import type { IncognitoAccess } from "@/ports/tabs";

/** Chrome's "Allow in Incognito" toggle, as the dashboard reads it and leads to it. */
export const browserIncognito: IncognitoAccess = {
  allowed: () => browser.extension.isAllowedIncognitoAccess(),
  // Only Chrome may flip the toggle, on RECnRun's details page; the id works for dev and store builds.
  openSettings: async () => {
    await browser.tabs.create({ url: `chrome://extensions/?id=${browser.runtime.id}` });
  },
  openWindow: async () => {
    await browser.windows.create({ incognito: true });
  },
};
