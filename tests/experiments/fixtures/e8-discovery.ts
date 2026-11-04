import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChainRun } from "../e8-chain.ts";

/*
 * E8 runs the launcher's own shell chain, scripts/poc-cross-profile/discovery.sh, as a child process:
 * a fixed argument list (never a shell string) and an environment of its own whose HOME is the
 * sample's folder, so the chain's bounded find stays inside it.
 */

export const NAMESPACE = "lab";
const DISCOVERY = fileURLToPath(
  new URL("../../../scripts/poc-cross-profile/discovery.sh", import.meta.url),
);
const TIMEOUT_MS = 60_000;

/** The chain's environment: a PATH to find sh's tools, and HOME with the user-dirs file under it. */
const chainEnvironment = (home: string, path = process.env.PATH): NodeJS.ProcessEnv => ({
  PATH: path ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
});

/** Runs one command of discovery.sh; only its own exit status is a result, a spawn error is not. */
export function runDiscovery(
  home: string,
  command: string,
  args: readonly string[],
): Promise<ChainRun> {
  const options = { env: chainEnvironment(home), timeout: TIMEOUT_MS };
  return new Promise((resolve, reject) => {
    execFile("sh", [DISCOVERY, command, ...args], options, (error, stdout, stderr) => {
      const code = error ? error.code : 0;
      if (typeof code === "number") resolve({ code, stdout, stderr });
      else reject(error ?? new Error("discovery.sh gave no exit status"));
    });
  });
}
