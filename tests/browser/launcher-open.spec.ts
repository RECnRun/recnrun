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
import { labEnvironment } from "../experiments/fixtures/e4-lab.ts";
import {
  EXTENSION_ID_FILE,
  OPEN_CELLS,
  openSample,
  preferencesOf,
  readJson,
  recordOpen,
  register,
} from "../experiments/fixtures/launcher-open.ts";
import type { Rig } from "../experiments/fixtures/launcher-open.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";
import { expect, resolveChromePath, test } from "./fixtures/chrome.ts";
import { POC_EXTENSION_ID } from "./fixtures/downloads-profiles.ts";
import { extensionPath, loadUnpacked } from "./fixtures/extension-loaders.ts";
import { keepDisplayOnFailure } from "./fixtures/x-display.ts";

/*
 * POC PLAN.md P4.3 on Google Chrome Stable: the launcher's open.sh starts a second root's Chrome
 * with the bootstrap URL on its command line and waits for the ack the extension writes under that
 * profile's Downloads root. The root is prepared the lab's way (poc-d0 by Extensions.loadUnpacked,
 * reloaded once so it outlives the process, see CHROMIUM.md group 9), then quit with SIGTERM.
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

/** A wrapper first on PATH, so open.sh finds `google-chrome` and the container's Chrome gets its flag. */
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

/** poc-d0 installed on a fresh root, reloaded so Chrome keeps it, and quit; the rig opens it. */
async function labRig(testInfo: TestInfo): Promise<Rig> {
  expect((await readFile(EXTENSION_ID_FILE, "utf8")).trim()).toBe(POC_EXTENSION_ID);
  const dir = await mkdtemp(join(tmpdir(), "recnrun-open-"));
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

test.describe("open.sh opens a second root's profile and gets the ack of its token", () => {
  test.describe.configure({ timeout: 600_000 });

  test("P4.3.open.fresh: a closed profile starts and acks its token as its boot", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordOpen("P4.3.open.fresh", labEnvironment.target, () =>
      openSample(() => labRig(testInfo), false),
    );
  });

  test("P4.3.open.running: a second open acks the running profile's own boot", async ({
    browserName,
  }, testInfo) => {
    expect(browserName).toBeDefined();
    await recordOpen("P4.3.open.running", labEnvironment.target, () =>
      openSample(() => labRig(testInfo), true),
    );
  });

  test("every P4.3 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("P4.3", Object.keys(OPEN_CELLS));
  });
});
