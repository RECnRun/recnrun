// What a person does on the container's Xvfb display: xdotool for windows, keys, and clicks; scrot for pixels.
import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

const exec = promisify(execFile);
const TOOL_TIMEOUT_MS = 15_000;

export type Rgb = [number, number, number];

export interface Geometry {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Polls `check` every 100 ms for up to `ms`, ten seconds unless told otherwise. */
export async function until(
  check: () => Promise<boolean>,
  what: string,
  ms = 10_000,
): Promise<void> {
  for (let left = ms / 100; left > 0; left--) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error(`Timed out waiting for ${what}.`);
}

async function xdotool(...args: string[]): Promise<string> {
  const { stdout } = await exec("xdotool", args, { timeout: TOOL_TIMEOUT_MS });
  return stdout.trim();
}

/**
 * The visible windows whose title matches, "" for none, or undefined when the search has to run
 * again: xdotool 3.20160805 exits on BadWindow when any window closes during the search. Both
 * that and no match exit 1, so stderr tells them apart.
 */
async function search(title: string, ...options: string[]): Promise<string | undefined> {
  try {
    return await xdotool("search", ...options, "--onlyvisible", "--name", title);
  } catch (error) {
    const { code, stderr } = error as { code?: unknown; stderr?: unknown };
    if (String(stderr).includes("BadWindow")) return undefined;
    if (code === 1 && !stderr) return "";
    throw error;
  }
}

/** The first visible window whose title matches; --sync's half-second wait lets a new window take keys. */
export async function findWindow(title: string, ms = 20_000): Promise<string> {
  let found: string | undefined;
  await until(
    async () => {
      found = await search(title, "--sync");
      return found !== undefined && found !== "";
    },
    `the window "${title}" to show`,
    ms,
  );
  return (found ?? "").split("\n")[0] ?? "";
}

/** There is no window manager, so every window that should take keys is focused explicitly. */
export const focus = (id: string) => xdotool("windowfocus", "--sync", id);

export async function geometryOf(id: string): Promise<Geometry> {
  const shell = await xdotool("getwindowgeometry", "--shell", id);
  const at = (key: string) => Number(new RegExp(`^${key}=(\\d+)$`, "m").exec(shell)?.[1]);
  return { x: at("X"), y: at("Y"), width: at("WIDTH"), height: at("HEIGHT") };
}

/** Clicks at display coordinates and parks the pointer, so no button stays hovered. */
export async function click(x: number, y: number): Promise<void> {
  await xdotool("mousemove", "--sync", String(x), String(y));
  await xdotool("click", "1");
  await xdotool("mousemove", "0", "0");
}

export const key = (...keys: string[]) => xdotool("key", "--clearmodifiers", ...keys);

export const typeText = (text: string) => xdotool("type", "--delay", "20", text);

/** Every visible window with its title and geometry, for the evidence and the failure report. */
export async function listWindows(): Promise<string> {
  const ids = ((await search(".")) ?? "").split("\n").filter(Boolean);
  const lines = await Promise.all(
    ids.map(async (id) => {
      const name = await xdotool("getwindowname", id).catch(() => "?");
      const { x, y, width, height } = await geometryOf(id).catch(() => ({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
      }));
      return `${id}\t${width}x${height}+${x}+${y}\t${name}`;
    }),
  );
  return lines.join("\n");
}

/** A PNG of the whole display, what the person sees. */
export const screenshot = (file: string) =>
  exec("scrot", ["-o", file], { timeout: TOOL_TIMEOUT_MS }).then(() => undefined);

/** The pixel of a one-pixel PNG: its first row's filter byte, then the pixel's bytes. */
function decodePixel(png: Buffer): Rgb {
  const data: Buffer[] = [];
  for (let offset = 8; offset < png.length;) {
    const length = png.readUInt32BE(offset);
    const type = png.toString("ascii", offset + 4, offset + 8);
    const chunk = png.subarray(offset + 8, offset + 8 + length);
    if (type === "IHDR" && (chunk[8] !== 8 || (chunk[9] !== 2 && chunk[9] !== 6)))
      throw new Error("scrot wrote a PNG that is not 8-bit RGB or RGBA.");
    if (type === "IDAT") data.push(chunk);
    offset += length + 12;
  }
  const raw = inflateSync(Buffer.concat(data));
  return [raw[1] ?? 0, raw[2] ?? 0, raw[3] ?? 0];
}

/** The color of one pixel of the display: the one sign of a bubble the driver has no handle on. */
export async function pixelAt(x: number, y: number): Promise<Rgb> {
  const file = join(tmpdir(), `recnrun-pixel-${process.pid}.png`);
  await exec("scrot", ["-o", "-a", `${x},${y},1,1`, file], { timeout: TOOL_TIMEOUT_MS });
  try {
    return decodePixel(readFileSync(file));
  } finally {
    rmSync(file, { force: true });
  }
}
