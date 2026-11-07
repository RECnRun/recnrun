import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { Page } from "@playwright/test";
import { launchChrome } from "../../browser/fixtures/chrome.ts";
import type { StrictChrome } from "../../browser/fixtures/chrome.ts";
import { aimable, letterbox } from "./interact-click-harness.ts";
import { interactStart } from "./interact-harness.ts";
import { call, until } from "./lifecycle-harness.ts";
import { NAME } from "./trust-harness.ts";

/* Helpers of the W7 host cell (RECNRUN_W7_HOST=1): the worker launch and the display capture. */

const run = promisify(execFile);

export const hostMode = () => process.env.RECNRUN_W7_HOST === "1";

/** The worker root started with the single flag the product keeps: no debugging port, no pipe. */
export async function launchBareWorker(root: string, headless: boolean): Promise<StrictChrome> {
  const args = headless ? ["--headless"] : [];
  return launchChrome({ cdp: false, userDataDir: root, silentDebugger: true, args });
}

/** The command line of `pid`: /proc on Linux, `ps` elsewhere (macOS has no /proc). */
export async function commandLine(pid: number): Promise<string[]> {
  if (process.platform === "linux") {
    return (await readFile(`/proc/${pid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  }
  const { stdout } = await run("ps", ["-ww", "-o", "command=", "-p", String(pid)]);
  return stdout.trim().split(/\s+(?=--|about:)/);
}

/** A full-display screenshot: `screencapture` on macOS, `scrot` on the lab's Xvfb. */
export async function captureDisplay(file: string): Promise<void> {
  if (process.platform === "darwin") await run("screencapture", ["-x", file]);
  else if (process.platform === "linux") await run("scrot", ["-o", file]);
  else throw new Error(`No display capture for ${process.platform}.`);
}

/** Starts a lease on a fixture page (retrying while the last release lands), observed and aimable. */
export async function beginLease(page: Page, url: string): Promise<void> {
  const started = await until(
    () => interactStart(page, url),
    (reply) => reply.ok,
    8_000,
  );
  if (!started.ok) throw new Error(JSON.stringify(started));
  const observed = await call<{ ok: boolean }>(page, "interactObserve", NAME);
  if (!observed.ok) throw new Error(`interactObserve: ${JSON.stringify(observed)}`);
  await letterbox(page);
  await aimable(page);
}
