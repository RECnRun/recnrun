import { test as base } from "@playwright/test";
import { launchChrome, type ChromeInstance } from "./launch-chrome.ts";

export { expect } from "@playwright/test";
export { launchChrome, type ChromeInstance, type LaunchedChrome } from "./launch-chrome.ts";

export const test = base.extend<{ chrome: ChromeInstance }>({
  chrome: async ({ headless }, use) => {
    // The browser layer validates headed Chrome only (PLAN.md decision 5).
    if (headless) throw new Error("Browser tests run Chrome headed; set use.headless to false.");
    const chrome = await launchChrome();
    try {
      await use(chrome);
    } finally {
      await chrome.close();
    }
  },
});
