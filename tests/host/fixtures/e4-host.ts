import { execFile } from "node:child_process";
import { rmdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { launchForUnpacked } from "../../browser/fixtures/extension-loaders.ts";
import { createSession } from "../../experiments/fixtures/e4-profiles.ts";
import type { E4Environment } from "../../experiments/fixtures/e4-profiles.ts";
import { host } from "./downloads.ts";
import { HOST_ARGS, hostUnpackedOptions } from "./host-chrome.ts";
import { CHROME_BINARY, evidence, hostRunId, requireHost } from "./host-env.ts";
import { removeHostRoot, rootFor } from "./roots.ts";

/*
 * E4 on the installed Google Chrome of this Mac. Every root and folder is a throwaway root of this
 * run; ~/Downloads is never written or scanned, so the OS default candidate is a stand-in folder
 * written into each root's Preferences, a limit of the host measurement.
 */

let folders = 0;

const makeFolder = (name: string) => rootFor(requireHost(), hostRunId(), `e4-${name}-${++folders}`);

async function removeFolder(path: string): Promise<void> {
  if (process.env.RECNRUN_HOST_KEEP_ROOTS === "1") return;
  await removeHostRoot(path, hostRunId());
  await rmdir(dirname(path)).catch(() => undefined);
}

/** Launches Chrome for Extensions.loadUnpacked on a root and records its versions for the run. */
async function launch(root: string) {
  const chrome = await launchForUnpacked(hostUnpackedOptions(root));
  try {
    const { product, userAgent } = await chrome.cdp.send("Browser.getVersion");
    await evidence().versions({ version: chrome.version, product, userAgent });
    return chrome;
  } catch (error) {
    await chrome.close();
    throw error;
  }
}

export const hostEnvironment: E4Environment = {
  target: host.target,
  session: async () => {
    const standIn = await makeFolder("default");
    return createSession({
      defaultDownloads: standIn,
      realDefault: false,
      makeFolder,
      removeFolder,
      launch,
      binary: CHROME_BINARY,
      openArgs: HOST_ARGS,
      cleanup: () => removeFolder(standIn),
    });
  },
};

type Run = (file: string, args: string[]) => Promise<{ stdout: string }>;

/**
 * The launcher's native reader on macOS: plutil on a throwaway root's Preferences, nothing else.
 * A missing key is a value (null); any other failure, starting plutil included, is the harness's.
 */
export async function plutilPreference(
  root: string,
  run: Run = promisify(execFile),
): Promise<string | null> {
  const preferences = join(root, "Default", "Preferences");
  const args = ["-extract", "download.default_directory", "raw", "-o", "-", preferences];
  try {
    return (await run("plutil", args)).stdout.trim() || null;
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    if (code === 1 && String(stderr).includes("No value at that key path")) return null;
    throw error;
  }
}
