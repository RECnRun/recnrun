import { chromium, test as base } from "@playwright/test";
import type { Browser, BrowserContext, Page, Worker } from "@playwright/test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "@recnrun/domain";

const extensionPath = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-test", import.meta.url),
);

interface ChromeGlobal {
  chrome: { storage: { local: { set(items: object): Promise<void> } } };
}

interface ExtensionOptions {
  /** Opens a DevTools port so `clickToolbarIcon` can reach browser-level CDP. */
  remoteDebuggingPort: number | undefined;
  /** Turns on "Allow in Incognito" for the extension, as the user would in its details. */
  incognitoAccess: boolean;
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

/** Chrome's id for an unpacked extension: the path's SHA-256, its first 32 hex digits as a–p. */
const unpackedId = (path: string) =>
  createHash("sha256")
    .update(path)
    .digest("hex")
    .slice(0, 32)
    .replaceAll(/./g, (digit) => String.fromCharCode(97 + Number.parseInt(digit, 16)));

/**
 * A profile that already allows the extension in Incognito. Toggling it in chrome://extensions
 * reloads the extension, which Chromium disables as an unpacked one while Developer mode is off.
 */
function incognitoProfile(): string {
  const dir = mkdtempSync(join(tmpdir(), "recnrun-incognito-"));
  mkdirSync(join(dir, "Default"));
  const settings = {
    extensions: { settings: { [unpackedId(extensionPath)]: { incognito: true } } },
  };
  writeFileSync(join(dir, "Default", "Preferences"), JSON.stringify(settings));
  return dir;
}

/** Chromium on `profile` (a fresh one when empty) with the test build of the extension loaded. */
export const launchWithExtension = (profile: string, headless: boolean, args: string[] = []) =>
  chromium.launchPersistentContext(profile, {
    headless,
    args: [
      `--disable-extensions-except=${extensionPath}`,
      `--load-extension=${extensionPath}`,
      ...args,
    ],
  });

/** A Chromium profile with the test build of the extension loaded. */
export const test = base.extend<ExtensionFixtures & ExtensionOptions>({
  remoteDebuggingPort: [undefined, { option: true }],
  incognitoAccess: [false, { option: true }],
  context: async ({ headless, remoteDebuggingPort, incognitoAccess }, use) => {
    const port =
      remoteDebuggingPort === undefined ? [] : [`--remote-debugging-port=${remoteDebuggingPort}`];
    const profile = incognitoAccess ? incognitoProfile() : "";
    const context: BrowserContext = await launchWithExtension(profile, headless, port);
    await use(context);
    await context.close();
    if (profile) rmSync(profile, { recursive: true, force: true });
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

/** Keeps the console lines that report a blocked load or a CSP violation. */
export function blockedLoads(page: Page): string[] {
  const blocked: string[] = [];
  page.on("console", (message) => {
    if (/Content Security Policy|Denying load|ERR_BLOCKED/i.test(message.text())) {
      blocked.push(message.text());
    }
  });
  return blocked;
}
