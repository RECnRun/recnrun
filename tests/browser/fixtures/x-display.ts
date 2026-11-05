import { execFile } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import type { TestInfo } from "@playwright/test";

/*
 * Browser UI with no CDP handle (window titles, the whole display) is read on the container's
 * Xvfb display with xdotool and scrot. No long option is passed: the harness scan takes every
 * `--name` string under tests/browser for a Chrome launch flag.
 */

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
// What `xdotool search` prints on stderr, on success too, when no property option is given.
const SEARCH_NOTICE = "Defaulting to search window name, class, and classname";

function requireContainer(): void {
  if (process.env.RECNRUN_TEST_CONTAINER !== "1") {
    throw new Error(
      "xdotool and scrot drive the display only in the test container (vp run test:browser); on a host they would act on the person's own screen.",
    );
  }
}

async function xdotool(...args: string[]): Promise<string> {
  requireContainer();
  const { stdout } = await exec("xdotool", args, { timeout: COMMAND_TIMEOUT_MS });
  return stdout.trim();
}

/**
 * What a failed `xdotool search` means: undefined to search again, "" for no match. Ubuntu
 * noble's xdotool 3.20160805 exits 1 on BadWindow when any window closes during the search, and
 * also exits 1 when nothing matches, saying only which properties it searched.
 */
function searchOutcome(error: unknown): string | undefined {
  const { code, stderr } = error as { code?: unknown; stderr?: unknown };
  const said = typeof stderr === "string" ? stderr.replace(SEARCH_NOTICE, "").trim() : "";
  if (said.includes("BadWindow")) return undefined;
  if (code === 1 && said === "") return "";
  throw error;
}

/** Thrown when every attempt of a search hit BadWindow, so "no window" cannot be told from "unknown". */
export class InconclusiveSearchError extends Error {}

/** Retries `attempt` while it is inconclusive (undefined) up to `ms`, then throws instead of reporting no windows. */
export async function conclusive(
  attempt: () => Promise<string | undefined>,
  ms = 5_000,
  pollMs = POLL_MS,
): Promise<string> {
  for (let left = Math.max(1, Math.ceil(ms / pollMs)); left > 0; left--) {
    const found = await attempt();
    if (found !== undefined) return found;
    await delay(pollMs);
  }
  throw new InconclusiveSearchError(
    "xdotool search stayed inconclusive (BadWindow) until the deadline.",
  );
}

async function search(title: string): Promise<string> {
  return conclusive(async () => {
    try {
      return await xdotool("search", title);
    } catch (error) {
      return searchOutcome(error);
    }
  });
}

/** The pids that own a window whose name or class matches `pattern` (empty when no window does). */
export async function windowOwners(pattern: string): Promise<number[]> {
  const ids = (await search(pattern)).split("\n").filter(Boolean);
  const owners = await Promise.all(
    ids.map((id) => xdotool("getwindowpid", id).then(Number, () => 0)),
  );
  return owners.filter((pid) => pid > 0);
}

/** Polls `check` every 100 ms for up to `ms`, ten seconds unless told otherwise. */
async function until(check: () => Promise<boolean>, what: string, ms = 10_000): Promise<void> {
  for (let left = ms / POLL_MS; left > 0; left--) {
    if (await check()) return;
    await delay(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** Whether a window whose title, class, or class name matches `title` shows within `ms`. */
export async function windowShows(title: string, ms?: number): Promise<boolean> {
  try {
    await until(async () => Boolean(await search(title)), `the window "${title}" to show`, ms);
    return true;
  } catch (error) {
    if (error instanceof InconclusiveSearchError) throw error;
    return false;
  }
}

/** Keeps a screenshot of the whole display as `display.png` when the test did not pass. */
export async function keepDisplayOnFailure(
  testInfo: Pick<TestInfo, "status" | "expectedStatus" | "outputPath">,
): Promise<void> {
  if (testInfo.status === testInfo.expectedStatus) return;
  requireContainer();
  await exec("scrot", ["-o", testInfo.outputPath("display.png")], { timeout: COMMAND_TIMEOUT_MS });
}

/** A real pointer click at display coordinates `x`, `y`: a gesture, as a person would make it. */
export async function clickAt(x: number, y: number): Promise<void> {
  await xdotool("mousemove", String(Math.round(x)), String(Math.round(y)), "click", "1");
}
