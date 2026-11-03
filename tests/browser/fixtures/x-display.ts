import { execFile } from "node:child_process";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";
import type { TestInfo } from "@playwright/test";

/*
 * Chrome's infobar, its bubbles, and DevTools windows are browser UI with no handle in CDP, so
 * the browser layer drives them on the container's Xvfb display: xdotool finds windows by title
 * and sends keys and clicks, scrot reads pixels. There is no window manager, so windows stack at
 * the origin and get focus only from `focus()`. No long option is passed: the harness scan takes
 * every `--name` string under tests/browser for a Chrome launch flag.
 */

const exec = promisify(execFile);
const COMMAND_TIMEOUT_MS = 15_000;
const POLL_MS = 100;
// What `xdotool search` prints on stderr, on success too, when no property option is given.
const SEARCH_NOTICE = "Defaulting to search window name, class, and classname";
let pixels = 0;

export type Rgb = [number, number, number];

export interface Point {
  x: number;
  y: number;
}

function requireContainer(): void {
  if (process.env.RECNRUN_TEST_CONTAINER !== "1") {
    throw new Error(
      "xdotool and scrot drive the display only in the test container (vp run test:browser); on a host they would act on the person's own screen.",
    );
  }
}

export async function xdotool(...args: string[]): Promise<string> {
  requireContainer();
  const { stdout } = await exec("xdotool", args, { timeout: COMMAND_TIMEOUT_MS });
  return stdout.trim();
}

/**
 * What a failed `xdotool search` means: undefined to search again, "" for no match. Ubuntu
 * noble's xdotool 3.20160805 exits 1 on BadWindow when any window closes during the search, and
 * also exits 1 when nothing matches, saying only which properties it searched; anything else is
 * an error.
 */
export function searchOutcome(error: unknown): string | undefined {
  const { code, stderr } = error as { code?: unknown; stderr?: unknown };
  const said = typeof stderr === "string" ? stderr.replace(SEARCH_NOTICE, "").trim() : "";
  if (said.includes("BadWindow")) return undefined;
  if (code === 1 && said === "") return "";
  throw error;
}

/** Windows whose title, class, or class name matches, one id per line, "" for none, undefined to retry. */
async function search(title: string): Promise<string | undefined> {
  try {
    return await xdotool("search", title);
  } catch (error) {
    return searchOutcome(error);
  }
}

/** Polls `check` every 100 ms for up to `ms`, ten seconds unless told otherwise. */
export async function until(
  check: () => Promise<boolean>,
  what: string,
  ms = 10_000,
): Promise<void> {
  for (let left = ms / POLL_MS; left > 0; left--) {
    if (await check()) return;
    await delay(POLL_MS);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

/** The first window whose title matches `title`, once one shows. */
export async function findWindow(title: string, ms?: number): Promise<string> {
  let found = "";
  await until(
    async () => {
      found = (await search(title))?.split("\n")[0] ?? "";
      return found !== "";
    },
    `the window "${title}" to show`,
    ms,
  );
  return found;
}

/** Whether `title` matches no window any more. */
export async function windowGone(title: string): Promise<boolean> {
  return (await search(title)) === "";
}

export async function windowOrigin(id: string): Promise<Point> {
  const geometry = await xdotool("getwindowgeometry", id);
  const [, x, y] = /Position: (\d+),(\d+)/.exec(geometry) ?? [];
  if (x === undefined || y === undefined) throw new Error(`xdotool gave no position: ${geometry}`);
  return { x: Number(x), y: Number(y) };
}

/** Gives the window the keyboard focus and waits until X reports it focused. */
export async function focus(id: string): Promise<void> {
  await xdotool("windowfocus", id);
  await until(async () => (await xdotool("getwindowfocus")) === id, `window ${id} to take focus`);
}

/** Clicks at a point of the display; no raise, which would cover a bubble Chrome already shows. */
export async function clickAt({ x, y }: Point): Promise<void> {
  await xdotool("mousemove", String(x), String(y));
  await xdotool("click", "1");
  // The pointer left over a button changes its color for the next pixel read.
  await xdotool("mousemove", "0", "0");
}

/** The pixel of a one-pixel PNG: its first row's filter byte, then the pixel's bytes. */
export function decodePixel(png: Buffer): Rgb {
  const data: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    const rgb = chunk[9] === 2 || chunk[9] === 6;
    if (type === "IHDR" && (chunk[8] !== 8 || !rgb)) {
      throw new Error("scrot wrote a PNG that is not 8-bit RGB or RGBA.");
    }
    if (type === "IDAT") data.push(chunk);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  return [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0];
}

/** The color of one pixel of the container's display. */
export async function pixelAt(x: number, y: number): Promise<Rgb> {
  requireContainer();
  const file = join(tmpdir(), `recnrun-pixel-${process.pid}-${++pixels}.png`);
  await exec("scrot", ["-o", "-a", `${x},${y},1,1`, file], { timeout: COMMAND_TIMEOUT_MS });
  try {
    return decodePixel(await readFile(file));
  } finally {
    await rm(file, { force: true });
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
