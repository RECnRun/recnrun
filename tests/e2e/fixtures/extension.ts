import { chromium, test as base } from "@playwright/test";
import type { BrowserContext, Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../../packages/domain/src/index.ts";

const extensionPath = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-test", import.meta.url),
);

interface ChromeGlobal {
  chrome: { storage: { local: { set(items: object): Promise<void> } } };
}

interface ExtensionFixtures {
  serviceWorker: Worker;
  seedSnapshot: (snapshot: Snapshot) => Promise<void>;
}

/** A Chromium profile with the test build of the extension loaded. */
export const test = base.extend<ExtensionFixtures>({
  context: async ({ headless }, use) => {
    const context: BrowserContext = await chromium.launchPersistentContext("", {
      headless,
      args: [`--disable-extensions-except=${extensionPath}`, `--load-extension=${extensionPath}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const [running] = context.serviceWorkers();
    await use(running ?? (await context.waitForEvent("serviceworker")));
  },
  seedSnapshot: async ({ serviceWorker }, use) => {
    await use(async (snapshot) => {
      await serviceWorker.evaluate(
        (value) =>
          (globalThis as unknown as ChromeGlobal).chrome.storage.local.set({ snapshot: value }),
        snapshot,
      );
    });
  },
});

export { expect } from "@playwright/test";
