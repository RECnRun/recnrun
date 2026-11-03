import { execFile } from "node:child_process";
import { promisify } from "node:util";

/*
 * The lab's native windows (Save As, the download bubble) on the container's Xvfb display. No
 * long option is passed: the harness scan reads every `--name` string as a Chrome flag.
 */

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;

function requireContainer(): void {
  if (process.env.RECNRUN_TEST_CONTAINER !== "1") {
    throw new Error("xdotool and scrot act only on the test container's display, never a host's.");
  }
}

/** xdotool's output; "" when a search matched nothing or a window closed under it. */
async function xdotool(...args: string[]): Promise<string> {
  requireContainer();
  try {
    return (await exec("xdotool", args, { timeout: COMMAND_TIMEOUT_MS })).stdout.trim();
  } catch (error) {
    if ((error as { code?: unknown }).code === 1) return "";
    throw error;
  }
}

/** Every window with a name or class on the display, by id, with its name ("" when unnamed). */
export async function windowNames(): Promise<Map<string, string>> {
  const ids = (await xdotool("search", ".")).split("\n").filter(Boolean);
  const names = new Map<string, string>();
  for (const id of ids) names.set(id, await xdotool("getwindowname", id));
  return names;
}

/** Gives the window the keyboard focus (there is no window manager) and presses `key` in it. */
export async function pressIn(id: string, key: string): Promise<void> {
  await xdotool("windowfocus", id);
  await xdotool("key", key);
}

export async function screenshot(path: string): Promise<void> {
  requireContainer();
  await exec("scrot", ["-o", path], { timeout: COMMAND_TIMEOUT_MS });
}
