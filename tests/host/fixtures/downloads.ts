import { execFile } from "node:child_process";
import { rmdir } from "node:fs/promises";
import { dirname } from "node:path";
import { promisify } from "node:util";
import { UnavailableError } from "../../browser/fixtures/policy-install.ts";
import { launchProbe } from "../../experiments/fixtures/downloads.ts";
import type { DownloadsEnvironment } from "../../experiments/fixtures/downloads-cells.ts";
import { CHROME_BINARY, evidence, hostRunId, requireHost } from "./host-env.ts";
import { openDefaultWorkspace } from "./default-downloads.ts";
import { launchOnRoot } from "./host-launch.ts";
import { chromeRoot, removeHostRoot } from "./roots.ts";

/** Keeps the diagnostic window off the owner's screen and away from the login Keychain. */
const HOST_ARGS = [
  "--no-default-browser-check",
  "--use-mock-keychain",
  "--window-position=-2000,0",
  "--window-size=800,600",
];
const DEFAULT_UNAVAILABLE = "the POC presence would write outside the allowed Downloads subtree";
let launches = 0;

async function removeRoot(root: string): Promise<void> {
  if (process.env.RECNRUN_HOST_KEEP_ROOTS === "1") return;
  await removeHostRoot(root, hostRunId());
  await rmdir(dirname(root)).catch(() => undefined);
}

const chromeVersion = async () =>
  (await promisify(execFile)(CHROME_BINARY, ["--version"])).stdout.trim();

/** E2 on the installed Google Chrome of this Mac, one fresh throwaway root per sample. */
export const host: DownloadsEnvironment = {
  target: { environment: "host", chrome: chromeVersion, directory: () => evidence().directory },
  launch: async (preferences) => {
    // Chrome's real default would get the P2.2 presence under ~/Downloads/RECnRun/poc/; M-P2.a covers it.
    if (preferences.location === "default") throw new UnavailableError(DEFAULT_UNAVAILABLE);
    const root = await chromeRoot(requireHost(), hostRunId(), `e2-${++launches}`);
    const options = { executable: CHROME_BINARY, args: HOST_ARGS };
    const probe = await launchOnRoot({
      launch: () => launchProbe(root, preferences, options),
      after: async ({ loaded }) => {
        const { product, userAgent } = await loaded.chrome.cdp.send("Browser.getVersion");
        await evidence().versions({ version: loaded.chrome.version, product, userAgent });
      },
      stop: ({ loaded }) => loaded.close(),
      removeRoot: () => removeRoot(root),
    });
    const close = async () => {
      try {
        await probe.loaded.close();
      } finally {
        await removeRoot(root);
      }
    };
    return { ...probe, root, close };
  },
  defaultWorkspace: async (namespace) => {
    const workspace = await openDefaultWorkspace(hostRunId());
    return { relative: workspace.relative(`probe-${namespace}.json`), clean: workspace.clean };
  },
  noDisplay:
    "macOS has no xdotool or scrot: native dialogs and windows are not observable; M-P1 manual not scheduled",
};
