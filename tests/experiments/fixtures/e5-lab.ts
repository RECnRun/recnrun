import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { launchForUnpacked } from "../../browser/fixtures/extension-loaders.ts";
import { clearLabDefault, currentHost, labEnvironment } from "./e4-lab.ts";
import type { E5Environment } from "./e5-run.ts";

/*
 * E5 in the lab: Google Chrome Stable in Docker on roots under the temporary folder, each
 * downloading to Chrome's own default, the container user's Downloads folder (CHROMIUM.md group
 * 11), which every sample clears of the namespace before and after.
 */

const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

export const labE5: E5Environment = {
  target: labEnvironment.target,
  platform: () => ({
    makeFolder: (name) => mkdtemp(join(tmpdir(), `recnrun-e5-${name}-`)),
    removeFolder: removeTree,
    launch: (root) => launchForUnpacked({ userDataDir: root }),
    // Nothing written in Preferences: Chrome's default is the shared root, as for a real user.
    shared: async () => ({ downloads: await clearLabDefault(currentHost), written: false }),
    cleanup: async () => void (await clearLabDefault(currentHost)),
  }),
};
