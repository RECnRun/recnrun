import { chromium, test as base } from "@playwright/test";
import type { BrowserContext, Worker } from "@playwright/test";
import { cp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Snapshot } from "../../../packages/domain/src/index.ts";

const extensionPath = fileURLToPath(
  new URL("../../../apps/extension/.output/chrome-mv3-test", import.meta.url),
);

interface ChromeGlobal {
  chrome: { storage: { local: { set(items: object): Promise<void> } } };
}

export type Manifest = Record<string, unknown>;
export type ManifestPatch = (manifest: Manifest) => void;

interface ExtensionOptions {
  /** Loads a copy of the test build with this change to its manifest. */
  manifestPatch: { patch: ManifestPatch } | undefined;
}

interface ExtensionFixtures {
  serviceWorker: Worker;
  extensionId: string;
  seedSnapshot: (snapshot: Snapshot) => Promise<void>;
}

async function patchedCopy(patch: ManifestPatch, target: string): Promise<string> {
  await cp(extensionPath, target, { recursive: true });
  const manifestFile = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as Manifest;
  patch(manifest);
  await writeFile(manifestFile, JSON.stringify(manifest, null, 2));
  return target;
}

/** A Chromium profile with the test build of the extension loaded. */
export const test = base.extend<ExtensionFixtures & ExtensionOptions>({
  manifestPatch: [undefined, { option: true }],
  context: async ({ headless, manifestPatch }, use, testInfo) => {
    const path = manifestPatch
      ? await patchedCopy(manifestPatch.patch, testInfo.outputPath("extension"))
      : extensionPath;
    const context: BrowserContext = await chromium.launchPersistentContext("", {
      headless,
      args: [`--disable-extensions-except=${path}`, `--load-extension=${path}`],
    });
    await use(context);
    await context.close();
  },
  serviceWorker: async ({ context }, use) => {
    const [running] = context.serviceWorkers();
    await use(running ?? (await context.waitForEvent("serviceworker")));
  },
  extensionId: async ({ serviceWorker }, use) => {
    await use(new URL(serviceWorker.url()).host);
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
