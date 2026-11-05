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
import { realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import type { TestInfo } from "@playwright/test";
import {
  EXTENSION_ID_FILE,
  preferencesOf,
  readJson,
  registerIn,
} from "../../experiments/fixtures/launcher-open.ts";
import type { Rig, Scene } from "../../experiments/fixtures/launcher-open.ts";
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

/** The Chrome executable itself: Google's google-chrome script sits next to it and would reset argv[0]. */
function chromeExecutable(): string {
  const resolved = realpathSync(resolveChromePath());
  return basename(resolved) === "google-chrome" ? join(dirname(resolved), "chrome") : resolved;
}

/**
 * A wrapper first on PATH, so the launcher finds `google-chrome` and the container's Chrome gets its flag.
 * Like Google's own google-chrome script, it keeps its path as argv[0] (`exec -a`, a bashism), so the
 * Chrome process names the binary the launcher resolved and lifecycle.sh signals it.
 */
async function wrapper(dir: string): Promise<string> {
  const bin = join(dir, "bin");
  await mkdir(bin);
  const sandbox = process.env.RECNRUN_TEST_CONTAINER === "1" ? " --no-sandbox" : "";
  const script = `#!/bin/bash\nexec -a "$0" "${chromeExecutable()}"${sandbox} "$@" 2>>"${dir}/chrome.log"\n`;
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

/** poc-d0 installed in one profile of `root` and kept by one reload; the profile is registered in `record`. */
async function installProfile(
  root: string,
  downloads: string,
  record: string,
  profileDirectory: string,
): Promise<Scene> {
  await mkdir(join(root, profileDirectory), { recursive: true });
  await mkdir(downloads, { recursive: true });
  const preferences = JSON.stringify(preferencesOf(downloads));
  await writeFile(join(root, profileDirectory, "Preferences"), preferences);
  const args = [`--profile-directory=${profileDirectory}`];
  const extension = await loadUnpacked(extensionPath("poc-d0"), { userDataDir: root, args });
  try {
    return await registerIn(extension, { root, downloads, record, profileDirectory });
  } finally {
    await extension.close();
  }
}

/** The directory of a rig, the environment the launcher scripts run under, and how to remove them. */
async function skeleton(rootBelowHome?: string) {
  expect((await readFile(EXTENSION_ID_FILE, "utf8")).trim()).toBe(POC_EXTENSION_ID);
  const dir = await mkdtemp(join(tmpdir(), "recnrun-launcher-"));
  const home = join(dir, "home");
  await mkdir(home);
  const env = {
    PATH: [await wrapper(dir), process.env.PATH].join(delimiter),
    HOME: home,
    DISPLAY: process.env.DISPLAY ?? "",
    // HOME moves, so the display's authority file must be named, or Chrome finds no X server.
    XAUTHORITY: process.env.XAUTHORITY ?? join(homedir(), ".Xauthority"),
    RECNRUN_TEST_CONTAINER: process.env.RECNRUN_TEST_CONTAINER ?? "",
  };
  const dispose = () => rm(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  return {
    dir,
    home,
    root: rootBelowHome === undefined ? join(dir, "Chrome") : join(home, rootBelowHome),
    record: join(dir, "launcher.record"),
    env,
    dispose,
  };
}

/** poc-d0 installed on a fresh root, reloaded so Chrome keeps it, and quit; the launcher opens it. */
export async function labRig(testInfo: TestInfo): Promise<Rig> {
  const { dir, home, root, record, env, dispose } = await skeleton();
  try {
    const scene = await installProfile(root, join(home, "Downloads"), record, "Default");
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
  }
}

/** A root of two profiles, `Default` (the rig's scene) and `Profile 1` (`second`), each with poc-d0 installed. */
export interface SharedRig extends Rig {
  second: Scene;
}

/** Both profiles share one user data dir and each downloads to a folder of its own; Chrome is quit. */
export async function sharedRig(testInfo: TestInfo): Promise<SharedRig> {
  const { dir, home, root, record, env, dispose } = await skeleton();
  try {
    const scene = await installProfile(root, join(home, "Downloads"), record, "Default");
    const second = await installProfile(root, join(home, "Downloads-1"), record, "Profile 1");
    const rig: SharedRig = {
      scene,
      second,
      env,
      survivors: () => chromesOf(root),
      keep: () => keepEvidence(dir, rig, testInfo),
      dispose,
    };
    return rig;
  } catch (error) {
    await dispose();
    throw error;
  }
}

/**
 * The usual layout of a first run: the OS default Chrome root below HOME holds Default and Profile 1,
 * each with poc-d0 installed and both downloading to ~/Downloads, and the record is empty. Chrome is quit.
 */
export async function firstRunRig(testInfo: TestInfo): Promise<SharedRig> {
  const { dir, home, root, record, env, dispose } = await skeleton(".config/google-chrome");
  try {
    const downloads = join(home, "Downloads");
    const scene = await installProfile(root, downloads, record, "Default");
    const second = await installProfile(root, downloads, record, "Profile 1");
    await rm(record);
    const rig: SharedRig = {
      scene,
      second,
      env,
      survivors: () => chromesOf(root),
      keep: () => keepEvidence(dir, rig, testInfo),
      dispose,
    };
    return rig;
  } catch (error) {
    await dispose();
    throw error;
  }
}
