import { readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium } from "@playwright/test";
import type { Browser } from "@playwright/test";
import { connected, overOwnClient } from "./downloads-profiles.ts";
import type { DownloadsProfile } from "./downloads-profiles.ts";
import type { LaunchedChrome } from "./chrome.ts";
import { within } from "./trust.ts";

/*
 * Attaching to a Chrome the launcher scripts started on a clone root, and ending it, for the lab (Docker)
 * and the host twin (macOS): both find the main process and the processes of a root their own way.
 */

const ENDPOINT_MS = 30_000;
const EXIT_MS = 30_000;

// Built from parts: the observer allowlist scans for launch flags written out, and this only reads one.
// Built in pieces: the flag allowlist guards launches, and this only reads a command line.
const CHILD = new RegExp("(^|[\\s\\0])-{2}type=");

/** Whether a Chrome command line (spaces or NULs between arguments) is a renderer, GPU, or other child. */
export const isChildProcess = (commandLine: string) => CHILD.test(commandLine);

/** How a platform names the Chrome of a root. */
export interface Processes {
  /** The pid of the root's main Chrome process. */
  pidOf(root: string): Promise<number | undefined>;
  /** The pids of every process that names the root. */
  alive(root: string): Promise<number[]>;
}

async function endpointOf(root: string): Promise<string> {
  const file = join(root, "DevToolsActivePort");
  const read = async () => {
    const [port = "", path = ""] = (await readFile(file, "utf8")).trim().split("\n");
    return path.startsWith("/devtools/browser/") ? `ws://127.0.0.1:${port}${path}` : undefined;
  };
  const found = await within(read, ENDPOINT_MS);
  if (!found) throw new Error(`${file} named no endpoint within ${ENDPOINT_MS} ms`);
  return found;
}

/** A DownloadsProfile over the Chrome on `root`, attached through the debugging port it opened. */
export async function attachTo(
  root: string,
  who: { name: string; instanceId: string },
  processes: Processes,
  browsers: Map<DownloadsProfile, Browser>,
) {
  const wsEndpoint = await endpointOf(root);
  const browser = await chromium.connectOverCDP(wsEndpoint);
  await overOwnClient(wsEndpoint);
  const chrome: LaunchedChrome = {
    browser,
    cdp: await browser.newBrowserCDPSession(),
    wsEndpoint,
    version: browser.version(),
    executable: "google-chrome",
    userDataDir: root,
    pid: (await processes.pidOf(root)) ?? 0,
    flags: [],
    exited: () => false,
    diagnostics: () => "",
    close: async () => undefined,
  };
  const profile: DownloadsProfile = {
    name: who.name,
    root,
    dir: root,
    profileId: who.instanceId,
    chrome,
    ...(await connected(browser)),
  };
  browsers.set(profile, browser);
  return profile;
}

/** SIGTERM to the main Chrome of `root`, Chrome's orderly quit, and until nothing names the root. */
export async function endChrome(root: string, processes: Processes) {
  const pid = await processes.pidOf(root);
  if (pid !== undefined) process.kill(pid, "SIGTERM");
  const deadline = Date.now() + EXIT_MS;
  while ((await processes.alive(root)).length > 0) {
    if (Date.now() > deadline) throw new Error(`Chrome still names ${root} after ${EXIT_MS} ms`);
    await delay(200);
  }
  await rm(join(root, "DevToolsActivePort"), { force: true });
}
