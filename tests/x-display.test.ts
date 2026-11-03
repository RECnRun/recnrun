import { deflateSync } from "node:zlib";
import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  clickAt,
  decodePixel,
  findWindow,
  focus,
  keepDisplayOnFailure,
  pixelAt,
  searchOutcome,
  until,
  windowGone,
  windowOrigin,
  xdotool,
} from "./browser/fixtures/x-display.ts";

/** One PNG chunk; the decoder never reads the CRC, so it stays zero. */
function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  return Buffer.concat([length, Buffer.from(type, "ascii"), data, Buffer.alloc(4)]);
}

/** A one-pixel PNG of `pixel` at `depth` bits with color type `color` (2 RGB, 6 RGBA). */
function onePixel(pixel: number[], color = 2, depth = 8): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header[8] = depth;
  header[9] = color;
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const row = deflateSync(Buffer.from([0, ...pixel]));
  const parts = [chunk("IHDR", header), chunk("IDAT", row), chunk("IEND", Buffer.alloc(0))];
  return Buffer.concat([signature, ...parts]);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("x-display", () => {
  test("decodes the pixel of a one-pixel RGB or RGBA PNG", () => {
    expect(decodePixel(onePixel([26, 115, 232]))).toEqual([26, 115, 232]);
    expect(decodePixel(onePixel([1, 2, 3, 255], 6))).toEqual([1, 2, 3]);
  });

  test("rejects a PNG that is not 8-bit RGB or RGBA", () => {
    expect(() => decodePixel(onePixel([0, 0, 0, 0, 0, 0], 2, 16))).toThrow(
      "scrot wrote a PNG that is not 8-bit RGB or RGBA.",
    );
  });

  test("tells xdotool's BadWindow exit from no match and from other failures", () => {
    const badWindow = { code: 1, stderr: "X Error of failed request:  BadWindow" };
    expect(searchOutcome(badWindow)).toBeUndefined();
    expect(searchOutcome({ code: 1, stderr: "" })).toBe("");
    const notice = "Defaulting to search window name, class, and classname\n";
    expect(searchOutcome({ code: 1, stderr: notice })).toBe("");
    const other = { code: 2, stderr: "Unknown command" };
    expect(() => searchOutcome(other)).toThrow();
  });

  test("polls until the check holds, and names what it waited for when it never does", async () => {
    let calls = 0;
    await until(async () => ++calls === 3, "three calls");
    expect(calls).toBe(3);
    await expect(until(async () => false, "nothing", 200)).rejects.toThrow(
      "Timed out waiting for nothing.",
    );
  });

  test("refuses to drive a display outside the test container", async () => {
    vi.stubEnv("RECNRUN_TEST_CONTAINER", "0");
    const outside = /only in the test container/;
    await expect(xdotool("getmouselocation")).rejects.toThrow(outside);
    await expect(pixelAt(0, 0)).rejects.toThrow(outside);
    await expect(findWindow("^recnrun")).rejects.toThrow(outside);
    await expect(windowOrigin("1")).rejects.toThrow(outside);
    await expect(windowGone("^recnrun")).rejects.toThrow(outside);
    await expect(focus("1")).rejects.toThrow(outside);
    await expect(clickAt({ x: 0, y: 0 })).rejects.toThrow(outside);
    const failed = {
      status: "failed" as const,
      expectedStatus: "passed" as const,
      outputPath: () => "/x.png",
    };
    await expect(keepDisplayOnFailure(failed)).rejects.toThrow(outside);
  });
});
