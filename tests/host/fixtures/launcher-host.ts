import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { CHROME_BINARY } from "./host-env.ts";

const run = promisify(execFile);
const APP = "Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
const MOCK_KEYCHAIN = "--use-mock-keychain";

/**
 * The environment the launcher scripts run under on a throwaway HOME. chrome_binary looks below
 * RECNRUN_DISCOVERY_PREFIX first, so a wrapper there stands for the installed Chrome: it keeps its own
 * path as argv[0] (`exec -a`, as Google's google-chrome script does) and adds --use-mock-keychain, so
 * the Chrome the launcher starts never asks for the owner's Chrome Safe Storage key (and `extraFlags`,
 * for a run that must attach to the Chrome the launcher starts). The request
 * open.sh builds is unchanged.
 */
export async function launcherEnv(
  home: string,
  extraFlags: readonly string[] = [],
): Promise<NodeJS.ProcessEnv> {
  const wrapper = join(home, APP);
  await mkdir(dirname(wrapper), { recursive: true });
  const flags = [MOCK_KEYCHAIN, ...extraFlags].join(" ");
  const script = `#!/bin/bash\nexec -a "$0" "${CHROME_BINARY}" ${flags} "$@"\n`;
  await writeFile(wrapper, script, { mode: 0o755 });
  return { PATH: process.env.PATH ?? "", HOME: home, RECNRUN_DISCOVERY_PREFIX: home };
}

/** The pids of Chrome processes whose command line names `root` as the user data directory. */
export async function chromesOf(root: string): Promise<number[]> {
  const { stdout } = await run("ps", ["-axo", "pid=,command="], { maxBuffer: 64 * 1024 * 1024 });
  return stdout
    .split("\n")
    .filter((line) => line.includes(`--user-data-dir=${root}`))
    .map((line) => Number(line.trim().split(/\s+/)[0]));
}

/** The command line of a live pid, empty when it is gone. */
export async function commandLineOf(pid: number): Promise<string> {
  if (pid <= 0) return "";
  const { stdout } = await run("ps", ["-o", "command=", "-p", String(pid)]).catch(() => ({
    stdout: "",
  }));
  return stdout.trim();
}

/** What the Chrome the launcher started must show: the wrapper below HOME as argv[0] and its flag. */
export function keychainProblems(commandLine: string, home: string): string[] {
  const problems: string[] = [];
  if (!commandLine.startsWith(`${join(home, APP)} `))
    problems.push(
      `Chrome's command line ${JSON.stringify(commandLine)} does not start with the wrapper`,
    );
  if (!commandLine.includes(` ${MOCK_KEYCHAIN} `))
    problems.push(
      `Chrome's command line lacks ${MOCK_KEYCHAIN}: it may ask for the owner's keychain`,
    );
  return problems;
}
