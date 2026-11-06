import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { installWith } from "../../browser/fixtures/launcher-rig.ts";
import type { LabRig } from "../../headless/fixtures/e13-lab.ts";
import { LAB } from "../../headless/fixtures/e13-cells.ts";
import type { Where } from "../../headless/fixtures/e13-cells.ts";
import { hostEnvironment, hostFolder, launch, removeFolder } from "./e4-host.ts";
import { HOST_ARGS, hostUnpackedOptions } from "./host-chrome.ts";
import { evidence } from "./host-env.ts";
import { chromesOf, commandLineOf, launcherEnv } from "./launcher-host.ts";

/*
 * The rig of E13 on the Mac (POC PLAN.md P7.4): a throwaway headed master root and throwaway worker
 * roots below RECNRUN_HOST_ROOTS, workers opened by open.sh through the mock-keychain wrapper of
 * launcherEnv, never the personal Default. macOS has no X server, so headless is judged by the
 * command line alone; the run says so in its observations.
 */

let launchers = 0;

export const hostRig: LabRig = {
  probe: {
    commandLines: async (root) =>
      Promise.all((await chromesOf(root)).map((pid) => commandLineOf(pid))),
    survivors: chromesOf,
  },
  platform: () => {
    const made: string[] = [];
    return {
      makeFolder: (name) => hostFolder(`e13-${name}`),
      removeFolder,
      launch,
      shared: async () => {
        const downloads = await hostFolder("e13-shared");
        made.push(downloads);
        return { downloads, written: true };
      },
      cleanup: async () => {
        for (const path of made) await removeFolder(path).catch(() => undefined);
      },
    };
  },
  frame: async (flags) => {
    const dir = await hostFolder(`e13-launcher-${++launchers}`);
    const home = join(dir, "home");
    await mkdir(home);
    // The wrapper keeps every Chrome the launcher starts off the owner's screen and keychain.
    const env = await launcherEnv(home, [...HOST_ARGS, ...flags]);
    return { dir, env, record: join(dir, "launcher.record"), dispose: () => removeFolder(dir) };
  },
  install: (input) => installWith({ ...input, chrome: hostUnpackedOptions(input.root) }),
};

/** Where the host twin records: this Mac's Chrome and its evidence folder; call it inside a test. */
export const hostWhere = (): Where => ({
  ...LAB,
  environment: "host",
  chrome: hostEnvironment.target.chrome,
  master:
    "the master is a throwaway headed root of this run and stands in for the personal Default",
  directory: evidence().directory,
});
