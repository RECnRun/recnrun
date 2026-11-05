import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import type { TestInfo } from "@playwright/test";
import {
  EXTENSION_ID_FILE,
  preferencesOf,
  readJson,
  register,
} from "../../experiments/fixtures/launcher-open.ts";
import type { Rig } from "../../experiments/fixtures/launcher-open.ts";
import { expect, resolveChromePath } from "./chrome.ts";
import { POC_EXTENSION_ID } from "./downloads-profiles.ts";
import { extensionPath, loadUnpacked } from "./extension-loaders.ts";
import { keepDisplayOnFailure } from "./x-display.ts";

/*
 * The root the launcher specs open (POC PLAN.md P4.3 and later): poc-d0 installed by
 * Extensions.loadUnpacked, reloaded once so Chrome keeps it (CHROMIUM.md group 9), then quit, with
 * the environment the launcher scripts run under.
 */

/** The pids whose command line names `root` as the user data directory (Linux /proc only). */
async function chromesOf(root: string): Promise<number[]> {
  const found: number[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    const line = await readFile(`/proc/${name}/cmdline`, "utf8").catch(() => "");
    if (line.includes(`--user-data-dir=${root}`)) found.push(Number(name));
  }
  return found;
}

/** A wrapper first on PATH, so the launcher finds `google-chrome` and the container's Chrome gets its flag. */
async function wrapper(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const sandbox = process.env.RECNRUN_TEST_CONTAINER === "1" ? " --no-sandbox" : "";
  const script = `#!/bin/sh\nexec "${resolveChromePath()}"${sandbox} "$@" 2>>"${dir}/chrome.log"\n`;
  // profiles.sh tries google-chrome-stable first, and the image has one in /usr/bin.
  for (const name of ["google-chrome-stable", "google-chrome"]) {
    await writeFile(join(bin, name), script);
    await chmod(join(bin, name), 0o755);
  }
  return bin;
}

/** What a failed run leaves to read: the display, Chrome's stderr, the settings, and the Downloads tree. */
async function keepEvidence(dir: string, rig: Rig, testInfo: TestInfo) {
  const status = { status: "failed", expectedStatus: "passed" } as const;
  await keepDisplayOnFailure({ ...status, outputPath: (name) => testInfo.outputPath(name) });
  await copyFile(join(dir, "chrome.log"), testInfo.outputPath("chrome.log")).catch(() => undefined);
  const { downloads, root } = rig.scene;
  const tree = (await readdir(downloads, { recursive: true })).join("\n");
  await writeFile(testInfo.outputPath("downloads-tree.txt"), tree);
  const prefs = await readJson(join(root, "Default/Preferences")).catch(
    (): Record<string, unknown> => ({}),
  );
  await writeFile(testInfo.outputPath("extensions.json"), JSON.stringify(prefs.extensions ?? {}));
  await copyFile(
    join(root, "Default/Secure Preferences"),
    testInfo.outputPath("secure.json"),
  ).catch(() => undefined);
}

/** poc-d0 installed on a fresh root, reloaded so Chrome keeps it, and quit; the launcher opens it. */
export async function labRig(testInfo: TestInfo): Promise<Rig> {
  expect((await readFile(EXTENSION_ID_FILE, "utf8")).trim()).toBe(POC_EXTENSION_ID);
  const dir = await mkdtemp(join(tmpdir(), "recnrun-launcher-"));
  const home = join(dir, "home");
  const root = join(dir, "Chrome");
  const downloads = join(home, "Downloads");
  await mkdir(join(root, "Default"), { recursive: true });
  await mkdir(downloads, { recursive: true });
  await writeFile(join(root, "Default", "Preferences"), JSON.stringify(preferencesOf(downloads)));
  const env = {
    PATH: [await wrapper(dir), process.env.PATH].join(delimiter),
    HOME: home,
    DISPLAY: process.env.DISPLAY ?? "",
    // HOME moves, so the display's authority file must be named, or Chrome finds no X server.
    XAUTHORITY: process.env.XAUTHORITY ?? join(homedir(), ".Xauthority"),
    RECNRUN_TEST_CONTAINER: process.env.RECNRUN_TEST_CONTAINER ?? "",
  };
  const dispose = () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  const extension = await loadUnpacked(extensionPath("poc-d0"), { userDataDir: root });
  try {
    const scene = await register(extension, root, downloads, join(dir, "launcher.record"));
    const rig: Rig = {
      scene,
      env,
      survivors: () => chromesOf(root),
      keep: () => keepEvidence(dir, rig, testInfo),
      dispose,
    };
    return rig;
  } catch (error) {
    await dispose();
    throw error;
  } finally {
    await extension.close();
  }
}
