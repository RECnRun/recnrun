import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hostUnpackedOptions } from "./fixtures/host-chrome.ts";
import { test } from "./fixtures/host-chrome.ts";
import { evidence } from "./fixtures/host-env.ts";
import { hostEnvironment, hostFolder, removeFolder } from "./fixtures/e4-host.ts";
import {
  chromesOf,
  commandLineOf,
  keychainProblems,
  launcherEnv,
} from "./fixtures/launcher-host.ts";
import { extensionPath, loadUnpacked } from "../browser/fixtures/extension-loaders.ts";
import { requireBuild } from "../experiments/file-access.ts";
import { labelPaths } from "../experiments/host-paths.ts";
import type { PathLabel } from "../experiments/host-paths.ts";
import {
  OPEN_CELLS,
  openSample,
  preferencesOf,
  recordOpen,
  register,
} from "../experiments/fixtures/launcher-open.ts";
import type { Rig } from "../experiments/fixtures/launcher-open.ts";
import { expectEveryHypothesis } from "../experiments/outcome.ts";

/*
 * P4.3's host twin: open.sh on the installed Google Chrome of this Mac, on a throwaway root only.
 * The root pins its Downloads root inside itself, so discovery's first step finds it with plutil;
 * HOME is a folder of the root, so the bounded find never reads the owner's home. open.sh builds
 * the request as the launcher does (no offscreen flag); the Chrome it resolves is the wrapper of
 * launcherEnv, which adds --use-mock-keychain so the owner's keychain is never asked, and the run
 * stops only the pid it printed.
 */

const target = hostEnvironment.target;
const labels: PathLabel[] = [];

/** poc-d0 installed on a fresh throwaway root, reloaded so Chrome keeps it, and quit. */
async function hostRig(): Promise<Rig> {
  const root = await hostFolder("launcher-open");
  const downloads = join(root, "downloads");
  const home = join(root, "home");
  try {
    labels.push([home, "<home>"], [root, "<root>"], [evidence().directory, "<evidence>"]);
    await mkdir(downloads);
    await mkdir(home);
    await mkdir(join(root, "Default"), { recursive: true });
    await writeFile(join(root, "Default", "Preferences"), JSON.stringify(preferencesOf(downloads)));
    const extension = await loadUnpacked(extensionPath("poc-d0"), hostUnpackedOptions(root));
    try {
      const { product, userAgent } = await extension.chrome.cdp.send("Browser.getVersion");
      await evidence().versions({ version: extension.chrome.version, product, userAgent });
      const scene = await register(extension, root, downloads, join(root, "launcher.record"));
      return {
        scene,
        env: await launcherEnv(home),
        inspect: async (opened) => keychainProblems(await commandLineOf(opened.pid), home),
        survivors: () => chromesOf(root),
        dispose: () => removeFolder(root),
      };
    } finally {
      await extension.close();
    }
  } catch (error) {
    await removeFolder(root);
    throw error;
  }
}

test.describe("P4.3 on the host: open.sh opens a registered profile and gets its ack", () => {
  test.describe.configure({ timeout: 900_000 });

  test.beforeAll(async () => {
    await requireBuild(extensionPath("poc-d0"), "poc-d0");
  });

  test("P4.3.open.fresh: a closed profile starts and acks its token as its boot", async () => {
    await recordOpen("P4.3.open.fresh", target, async () =>
      labelPaths(await openSample(hostRig, false), labels),
    );
  });

  test("P4.3.open.running: a second open acks the running profile's own boot", async () => {
    await recordOpen("P4.3.open.running", target, async () =>
      labelPaths(await openSample(hostRig, true), labels),
    );
  });

  test("every P4.3 hypothesis left a verdict", async () => {
    await expectEveryHypothesis("P4.3", Object.keys(OPEN_CELLS), evidence().directory);
  });
});
