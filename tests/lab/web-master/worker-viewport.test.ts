import { describe, expect, test } from "vite-plus/test";
import { inputError } from "./worker-extension/input-schema.js";
import { clampViewport, createViewport } from "./worker-extension/viewport.js";

/* Owner flow, task B: INTERACT_VIEWPORT is a closed input.v1 message, clamped to the policy bounds. */

const LEASE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const message = (width: unknown, height: unknown) => ({
  type: "INTERACT_VIEWPORT",
  leaseId: LEASE,
  seq: 2,
  width,
  height,
});
const POLICY = { minWidth: 400, minHeight: 300, maxWidth: 1600, maxHeight: 900 };

describe("the INTERACT_VIEWPORT message", () => {
  test("is a known input.v1 message with exact keys", () => {
    expect(inputError(message(1280, 720))).toBeNull();
    expect(inputError({ ...message(1280, 720), deviceScaleFactor: 2 })).toBe("INVALID_REQUEST");
    expect(inputError({ type: "INTERACT_VIEWPORT", leaseId: LEASE, seq: 2 })).toBe(
      "INVALID_REQUEST",
    );
  });
});

describe("the viewport clamp", () => {
  test.each([
    [1280, 720, undefined, { width: 1280, height: 720 }],
    [100, 100, undefined, { width: 320, height: 240 }],
    [5000, 3000, undefined, { width: 1920, height: 1080 }],
    [320, 1080, undefined, { width: 320, height: 1080 }],
    [100, 2000, POLICY, { width: 400, height: 900 }],
    [1280, 720, POLICY, { width: 1280, height: 720 }],
  ])("%i×%i within %o is %o", (width, height, bounds, effective) => {
    expect(clampViewport({ width, height }, bounds)).toEqual(effective);
  });

  test.each([
    [1280.5, 720],
    [Number.NaN, 720],
    [1280, null],
    [1280, "720"],
    [Infinity, 720],
  ])("%s×%s is INPUT_INVALID", (width, height) => {
    expect(clampViewport({ width, height })).toBe("INPUT_INVALID");
  });
});

describe("the applied viewport", () => {
  test("starts at the interact default with seq 0 and follows each applied seq", () => {
    const viewport = createViewport();
    expect(viewport.current()).toEqual({ width: 960, height: 540, seq: 0 });
    expect(viewport.size("interact", { maxWidth: 960, maxHeight: 540 })).toEqual({
      maxWidth: 960,
      maxHeight: 540,
    });
    viewport.apply({ width: 1280, height: 720 }, 4);
    expect(viewport.current()).toEqual({ width: 1280, height: 720, seq: 4 });
    expect(viewport.size("interact", { maxWidth: 960, maxHeight: 540 })).toEqual({
      maxWidth: 1280,
      maxHeight: 720,
    });
    expect(viewport.size("live", { maxWidth: 960, maxHeight: 540 })).toEqual({
      maxWidth: 960,
      maxHeight: 540,
    });
    viewport.reset();
    expect(viewport.current().seq).toBe(0);
  });
});
