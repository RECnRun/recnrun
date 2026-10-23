import { chromium, test as base } from "@playwright/test";
import type { Browser, BrowserContext, Page, Worker } from "@playwright/test";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../../packages/domain/src/index.ts";

const extensionPath = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-test", import.meta.url),
);

interface ChromeGlobal {
  chrome: { storage: { local: { set(items: object): Promise<void> } } };
}

interface ExtensionOptions {
  /** Opens a DevTools port so `clickToolbarIcon` can reach browser-level CDP. */
  remoteDebuggingPort: number | undefined;
}

interface ExtensionFixtures {
  serviceWorker: Worker;
  seedSnapshot: (snapshot: Snapshot) => Promise<void>;
  clickToolbarIcon: (page: Page) => Promise<void>;
}

interface TargetInfo {
  targetId: string;
  url: string;
}

/** A Chromium profile with the test build of the extension loaded. */
export const test = base.extend<ExtensionFixtures & ExtensionOptions>({
  remoteDebuggingPort: [undefined, { option: true }],
  context: async ({ headless, remoteDebuggingPort }, use) => {
    const port =
      remoteDebuggingPort === undefined ? [] : [`--remote-debugging-port=${remoteDebuggingPort}`];
    const context: BrowserContext = await chromium.launchPersistentContext("", {
      headless,
      args: [
        `--disable-extensions-except=${extensionPath}`,
        `--load-extension=${extensionPath}`,
        ...port,
      ],
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
  // Fires the real action, user gesture included; Playwright cannot click browser UI.
  clickToolbarIcon: async ({ serviceWorker, remoteDebuggingPort }, use) => {
    let remote: Browser | undefined;
    await use(async (page) => {
      if (remoteDebuggingPort === undefined) throw new Error("Set remoteDebuggingPort first.");
      remote ??= await chromium.connectOverCDP(`http://127.0.0.1:${remoteDebuggingPort}`);
      const cdp = await remote.newBrowserCDPSession();
      const { targetInfos } = (await cdp.send("Target.getTargets", {
        filter: [{ type: "tab" }],
      })) as { targetInfos: TargetInfo[] };
      const tab = targetInfos.find(({ url }) => url === page.url());
      if (!tab) throw new Error(`No tab shows ${page.url()}.`);
      await cdp.send("Extensions.triggerAction", {
        id: new URL(serviceWorker.url()).host,
        targetId: tab.targetId,
      });
      await cdp.detach();
    });
    await remote?.close();
  },
});

export { expect } from "@playwright/test";
