import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { resolveChromePath, test as base } from "./chrome.ts";
import { forceInstallByPolicy, loadInChromium, loadUnpackedOverCdp } from "./extension-loaders.ts";
import type { LoadedExtension } from "./extension-loaders.ts";

export { expect } from "./chrome.ts";
export type { LoadedExtension } from "./extension-loaders.ts";

/** The isolator's test build, made by `vp run @recnrun/isolator#build:test`. */
export const ISOLATOR_PATH = fileURLToPath(
  new URL("../../../apps/isolator/.output/chrome-mv3-test", import.meta.url),
);

type Loader = (path: string) => Promise<LoadedExtension>;

/** E0's methods in order: (a) CDP `Extensions.loadUnpacked`, (b) managed policy, (c) Chromium. */
const LOADERS: readonly Loader[] = [
  (path) => loadUnpackedOverCdp(path),
  (path) => forceInstallByPolicy(path),
  (path) => loadInChromium(path),
];

async function chromeVersion(): Promise<string> {
  const run = promisify(execFile);
  try {
    return (await run(resolveChromePath(), ["--version"])).stdout.trim();
  } catch {
    return "Google Chrome (not found)";
  }
}

/** Loads the extension with the first method that works and fails with the remedy when none does. */
export async function loadExtension(
  path: string = ISOLATOR_PATH,
  loaders: readonly Loader[] = LOADERS,
): Promise<LoadedExtension> {
  if (!existsSync(path)) {
    throw new Error(`${path} does not exist; run \`vp run @recnrun/isolator#build:test\`.`);
  }
  const failures: string[] = [];
  for (const load of loaders) {
    try {
      return await load(path);
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error));
    }
  }
  throw new Error(
    `${await chromeVersion()} accepted no extension-loading method; see docs/poc/namespace-sessions/experiments/E0.md and MANUAL_VALIDATION.md M-P0.a.\n${failures.join("\n")}`,
  );
}

export const test = base.extend<{ extension: LoadedExtension }>({
  extension: async ({ headless }, use) => {
    if (headless) throw new Error("Browser tests run Chrome headed; set use.headless to false.");
    const extension = await loadExtension();
    try {
      await use(extension);
    } finally {
      await extension.close();
    }
  },
});
