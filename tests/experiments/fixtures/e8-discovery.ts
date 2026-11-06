import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ChainRun } from "../e8-chain.ts";

/*
 * E8 runs the launcher's own shell scripts, scripts/poc-cross-profile/discovery.sh and profiles.sh, as child processes:
 * a fixed argument list (never a shell string) and an environment of its own whose HOME is the
 * sample's folder, so the chain's bounded find stays inside it.
 */

export const NAMESPACE = "lab";
const DISCOVERY = fileURLToPath(
  new URL("../../../scripts/poc-cross-profile/discovery.sh", import.meta.url),
);
const PROFILES = fileURLToPath(
  new URL("../../../scripts/poc-cross-profile/profiles.sh", import.meta.url),
);
const TIMEOUT_MS = 60_000;

/** The chain's environment: a PATH to find sh's tools, and HOME with the user-dirs file under it. */
const chainEnvironment = (home: string, path = process.env.PATH): NodeJS.ProcessEnv => ({
  PATH: path ?? "/usr/bin:/bin",
  HOME: home,
  XDG_CONFIG_HOME: join(home, ".config"),
  // Chrome is looked up only under the sample's folder, never in the host's /usr or /opt.
  RECNRUN_DISCOVERY_PREFIX: home,
});

/** Runs one command of a script; only its own exit status is a result, a spawn error is not. */
function runScript(
  script: string,
  home: string,
  command: string,
  args: readonly string[],
): Promise<ChainRun> {
  const options = { env: chainEnvironment(home), timeout: TIMEOUT_MS };
  return new Promise((resolve, reject) => {
    execFile("sh", [script, command, ...args], options, (error, stdout, stderr) => {
      const code = error ? error.code : 0;
      if (typeof code === "number") resolve({ code, stdout, stderr });
      else reject(error ?? new Error(`${script} gave no exit status`));
    });
  });
}

/** Runs one command of discovery.sh. */
export const runDiscovery = (home: string, command: string, args: readonly string[]) =>
  runScript(DISCOVERY, home, command, args);

/** Runs one command of profiles.sh, with HOME and the Chrome prefix both the sample's folder. */
export const runProfiles = (home: string, command: string, args: readonly string[]) =>
  runScript(PROFILES, home, command, args);
