import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { lstat, mkdtemp, rm } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { resolveChromePath } from "../../browser/fixtures/chrome.ts";
import { launchForUnpacked } from "../../browser/fixtures/extension-loaders.ts";
import { insideTestContainer } from "../../browser/fixtures/policy-install.ts";
import { namespaceFolder } from "./e4-launcher.ts";
import { createSession } from "./e4-profiles.ts";
import type { E4Environment } from "./e4-profiles.ts";

/*
 * E4 in the lab: Google Chrome Stable in Docker, with roots and folders under the temporary folder
 * and the container user's own default Downloads folder as the OS default candidate.
 */

/** Where the lab runs and the one removal outside its temporary folders; tests pass their own. */
export interface LabHost {
  env: NodeJS.ProcessEnv;
  dockerenv(): boolean;
  /** The user's home in the password database, which $HOME must name. */
  home(): string;
  lstat(path: string): Promise<{ isSymbolicLink(): boolean; isDirectory(): boolean }>;
  rm(path: string): Promise<void>;
}

const removeTree = (path: string) =>
  rm(path, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });

export const currentHost: LabHost = {
  env: process.env,
  dockerenv: () => existsSync("/.dockerenv"),
  home: () => userInfo().homedir,
  lstat,
  rm: removeTree,
};

/** The container user's Downloads folder; throws outside the test container, before any other call. */
async function labDownloads(host: LabHost): Promise<string> {
  if (!insideTestContainer(host.env, () => host.dockerenv())) {
    throw new Error(
      "E4's lab clears a Downloads folder only inside the test container (RECNRUN_TEST_CONTAINER=1 and /.dockerenv).",
    );
  }
  const home = host.home();
  if (!isAbsolute(home) || host.env.HOME !== home) {
    throw new Error("$HOME is not the container user's home; E4 clears no Downloads folder.");
  }
  // Chrome's default on Linux without an XDG user-dirs entry (CHROMIUM.md group 11).
  const downloads = join(home, "Downloads");
  for (const folder of [downloads, join(downloads, "RECnRun"), join(downloads, "RECnRun", "poc")]) {
    const entry = await host.lstat(folder).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
    if (entry && (entry.isSymbolicLink() || !entry.isDirectory())) {
      throw new Error(
        `${folder} is a symbolic link or not a folder; E4 clears nothing through it.`,
      );
    }
  }
  return downloads;
}

/** The default Downloads folder, cleared of the namespace so each sample starts with no presence. */
export async function clearLabDefault(host: LabHost): Promise<string> {
  const downloads = await labDownloads(host);
  await host.rm(namespaceFolder(downloads));
  return downloads;
}

/** The lab environment over `host`. */
export function labEnvironmentOn(host: LabHost): E4Environment {
  return {
    target: {
      environment: "lab",
      chrome: async () =>
        (await promisify(execFile)(resolveChromePath(), ["--version"])).stdout.trim(),
    },
    session: async () => {
      const downloads = await clearLabDefault(host);
      const clear = async () => void (await clearLabDefault(host));
      return createSession({
        defaultDownloads: downloads,
        realDefault: true,
        makeFolder: (name) => mkdtemp(join(tmpdir(), `recnrun-e4-${name}-`)),
        removeFolder: removeTree,
        launch: (root) => launchForUnpacked({ userDataDir: root }),
        binary: resolveChromePath(),
        // Chrome runs as root in the test container, where its sandbox cannot start.
        openArgs: ["--no-sandbox"],
        cleanup: clear,
      });
    },
  };
}

export const labEnvironment = labEnvironmentOn(currentHost);
