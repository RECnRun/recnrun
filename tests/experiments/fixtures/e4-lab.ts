import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { resolveChromePath } from "../../browser/fixtures/chrome.ts";
import { launchForUnpacked } from "../../browser/fixtures/extension-loaders.ts";
import { namespaceFolder } from "./e4-launcher.ts";
import { createSession } from "./e4-profiles.ts";
import type { E4Environment } from "./e4-profiles.ts";

/*
 * E4 in the lab: Google Chrome Stable in Docker, with roots and folders under the temporary folder
 * and the container user's own default Downloads folder as the OS default candidate.
 */

// Chrome's default on Linux without an XDG user-dirs entry (CHROMIUM.md group 11).
const DEFAULT_DOWNLOADS = join(homedir(), "Downloads");

const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

// The default is shared by every sample, so each starts and ends with no presence in it.
const clearDefault = () => removeTree(namespaceFolder(DEFAULT_DOWNLOADS));

export const labEnvironment: E4Environment = {
  target: {
    environment: "lab",
    chrome: async () =>
      (await promisify(execFile)(resolveChromePath(), ["--version"])).stdout.trim(),
  },
  session: async () => {
    await clearDefault();
    return createSession({
      defaultDownloads: DEFAULT_DOWNLOADS,
      realDefault: true,
      makeFolder: (name) => mkdtemp(join(tmpdir(), `recnrun-e4-${name}-`)),
      removeFolder: removeTree,
      launch: (root) => launchForUnpacked({ userDataDir: root }),
      binary: resolveChromePath(),
      // Chrome runs as root in the test container, where its sandbox cannot start.
      openArgs: process.env.RECNRUN_TEST_CONTAINER === "1" ? ["--no-sandbox"] : [],
      cleanup: clearDefault,
    });
  },
};
