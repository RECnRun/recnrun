import { execFile } from "node:child_process";
import { readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { inflateSync } from "node:zlib";

/*
 * Chrome's permission bubbles show over the browser window, and the driver has no handle on
 * them, so the one sign of them is what the display shows: scrot captures one pixel of it.
 */

const exec = promisify(execFile);

export type Rgb = [number, number, number];

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

/** The color of one pixel of the container's display. */
export async function pixelAt(x: number, y: number): Promise<Rgb> {
  const file = join(tmpdir(), `recnrun-pixel-${process.pid}.png`);
  await exec("scrot", ["-o", "-a", `${x},${y},1,1`, file], { timeout: 15_000 });
  try {
    return decodePixel(readFileSync(file));
  } finally {
    rmSync(file, { force: true });
  }
}

/** Polls `check` every 100 ms for up to ten seconds. */
export async function until(check: () => Promise<boolean>, what: string): Promise<void> {
  for (let left = 100; left > 0; left--) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`Timed out waiting for ${what}.`);
}
