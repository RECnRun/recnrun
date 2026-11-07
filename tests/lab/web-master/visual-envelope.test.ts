import { describe, expect, test } from "vite-plus/test";
import { LIMITS, createReceiver, parse } from "./site/visual-receiver.js";
import type { Frame } from "./site/visual-receiver.js";
import { HEADER_BYTES, MESSAGE_MAX, encodeFrame } from "./worker-extension/visual-envelope.js";
import type { FrameMeta } from "./worker-extension/visual-envelope.js";

/* W6.B: the visual.v1 envelope and the master's receiver, without a browser. */

const WORKER = "abcdefghijklmnopabcdefghijklmnop";
const BOOT = "11111111-2222-4333-8444-555555555555";

const meta = (overrides: Partial<FrameMeta> = {}): FrameMeta => ({
  workerId: WORKER,
  bootId: BOOT,
  jobId: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  targetId: 7,
  epoch: 1,
  frameSeq: 1,
  width: 480,
  height: 270,
  capturedAtMs: 1_000,
  ...overrides,
});

/** A JPEG-looking payload: SOI marker, then `size - 2` bytes of a repeating pattern. */
const jpeg = (size: number) => {
  const bytes = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) bytes[index] = index % 251;
  bytes.set([0xff, 0xd8]);
  return bytes;
};

const receiver = (clock = { now: 0 }) => {
  const shown: Frame[] = [];
  const instance = createReceiver({ onFrame: (frame) => shown.push(frame), now: () => clock.now });
  return { ...instance, shown, clock };
};

const patch = (message: ArrayBuffer, offset: number, write: (view: DataView) => void) => {
  const copy = message.slice(0);
  write(new DataView(copy, offset));
  return copy;
};

describe("encodeFrame", () => {
  test("splits a frame into messages of at most 16 KiB, header included", () => {
    const messages = encodeFrame(meta(), jpeg(40_000));
    expect(messages.length).toBe(3);
    for (const message of messages) expect(message.byteLength).toBeLessThanOrEqual(MESSAGE_MAX);
    const total = messages.reduce((sum, message) => sum + message.byteLength - HEADER_BYTES, 0);
    expect(total).toBe(40_000);
  });

  test("clamps the chunks to a smaller negotiated maxMessageSize", () => {
    const messages = encodeFrame(meta(), jpeg(5_000), 1_024);
    expect(messages.length).toBe(Math.ceil(5_000 / (1_024 - HEADER_BYTES)));
    for (const message of messages) expect(message.byteLength).toBeLessThanOrEqual(1_024);
  });

  test("refuses ids outside the closed format", () => {
    expect(() => encodeFrame(meta({ jobId: "lab" }), jpeg(10))).toThrow("NOT_A_UUID");
    expect(() => encodeFrame(meta({ workerId: "z".repeat(32) }), jpeg(10))).toThrow(
      "NOT_AN_EXTENSION_ID",
    );
  });

  test("round-trips every header field", () => {
    const [message] = encodeFrame(meta({ epoch: 3, frameSeq: 9, capturedAtMs: 1.5e12 }), jpeg(10));
    const parsed = parse(message);
    if (typeof parsed === "string") throw new Error(parsed);
    expect(parsed.head).toMatchObject({
      version: 1,
      codec: 1,
      workerId: "0123456789abcdef0123456789abcdef",
      bootId: BOOT.replaceAll("-", ""),
      targetId: 7,
      epoch: 3,
      frameSeq: 9,
      chunkIndex: 0,
      chunkCount: 1,
      frameBytes: 10,
      width: 480,
      height: 270,
      capturedAtMs: 1.5e12,
    });
  });
});

describe("createReceiver", () => {
  test("shows a frame only once every chunk arrived, in any order", () => {
    const r = receiver();
    const messages = encodeFrame(meta(), jpeg(40_000));
    expect(r.accept(messages[2])).toBe("partial");
    expect(r.accept(messages[0])).toBe("partial");
    expect(r.shown).toHaveLength(0);
    expect(r.accept(messages[1])).toBe("frame");
    expect(r.shown[0]?.bytes).toEqual(jpeg(40_000));
    expect(r.stats()).toEqual({ frames: 1, drops: {} });
  });

  test.each([
    ["a string", "hello", "malformed"],
    ["a header alone", new ArrayBuffer(HEADER_BYTES), "malformed"],
    ["a message over 16 KiB", new ArrayBuffer(MESSAGE_MAX + 1), "oversize"],
  ])("refuses %s", (_name, data, reason) => {
    const r = receiver();
    expect(r.accept(data)).toBe(reason);
    expect(r.stats().drops).toEqual({ [reason]: 1 });
  });

  test.each([
    ["an unknown version", 0, (v: DataView) => v.setUint8(0, 2), "bad-version"],
    ["an unknown codec", 1, (v: DataView) => v.setUint8(0, 9), "bad-codec"],
    ["zero chunks", 64, (v: DataView) => v.setUint16(0, 0), "bad-chunk-count"],
    ["too many chunks", 64, (v: DataView) => v.setUint16(0, LIMITS.chunks + 1), "bad-chunk-count"],
    ["a chunk past the count", 62, (v: DataView) => v.setUint16(0, 1), "bad-chunk-index"],
    ["a frame over 512 KiB", 66, (v: DataView) => v.setUint32(0, 524_289), "oversize"],
    ["a zero width", 70, (v: DataView) => v.setUint16(0, 0), "malformed"],
  ])("refuses %s", (_name, offset, write, reason) => {
    const r = receiver();
    const [message] = encodeFrame(meta(), jpeg(100));
    expect(r.accept(patch(message as ArrayBuffer, offset, write))).toBe(reason);
    expect(r.shown).toHaveLength(0);
  });

  test("refuses a payload that is not a JPEG", () => {
    const r = receiver();
    const [message] = encodeFrame(meta(), new Uint8Array(100));
    expect(r.accept(message)).toBe("not-jpeg");
  });

  test("drops a duplicate chunk and a chunk whose frame fields differ", () => {
    const r = receiver();
    const messages = encodeFrame(meta(), jpeg(40_000));
    r.accept(messages[0]);
    expect(r.accept(messages[0])).toBe("duplicate");
    const other = encodeFrame(meta({ width: 960 }), jpeg(40_000));
    expect(r.accept(other[1])).toBe("mismatch");
    expect(r.accept(messages[1])).toBe("partial");
    expect(r.accept(messages[2])).toBe("frame");
  });

  test("drops a partial frame after 2 s", () => {
    const r = receiver();
    const messages = encodeFrame(meta(), jpeg(40_000));
    r.accept(messages[0]);
    r.accept(messages[1]);
    r.clock.now = LIMITS.ttlMs + 1;
    r.sweep();
    expect(r.stats().drops).toEqual({ expired: 1 });
    expect(r.accept(messages[2])).toBe("partial");
    expect(r.shown).toHaveLength(0);
  });

  test("drops a late frame, a repeated frame, and a frame of an older epoch", () => {
    const r = receiver();
    expect(r.accept(encodeFrame(meta({ epoch: 2, frameSeq: 5 }), jpeg(10))[0])).toBe("frame");
    expect(r.accept(encodeFrame(meta({ epoch: 2, frameSeq: 4 }), jpeg(10))[0])).toBe("stale");
    expect(r.accept(encodeFrame(meta({ epoch: 2, frameSeq: 5 }), jpeg(10))[0])).toBe("stale");
    expect(r.accept(encodeFrame(meta({ epoch: 1, frameSeq: 6 }), jpeg(10))[0])).toBe("old-epoch");
    expect(r.accept(encodeFrame(meta({ epoch: 3, frameSeq: 6 }), jpeg(10))[0])).toBe("frame");
    expect(r.shown.map((frame) => frame.frameSeq)).toEqual([5, 6]);
  });

  test("a newer frame supersedes an unfinished one; the older one's chunks are then stale", () => {
    const r = receiver();
    const older = encodeFrame(meta({ frameSeq: 1 }), jpeg(40_000));
    r.accept(older[0]);
    expect(r.accept(encodeFrame(meta({ frameSeq: 2 }), jpeg(10))[0])).toBe("frame");
    expect(r.accept(older[1])).toBe("stale");
    expect(r.stats().drops).toEqual({ superseded: 1, stale: 1 });
  });

  test("a restarted worker starts over; a late frame of the old boot stays dropped", () => {
    const r = receiver();
    r.accept(encodeFrame(meta({ frameSeq: 50, capturedAtMs: 2_000 }), jpeg(10))[0]);
    const reboot = meta({ bootId: "99999999-2222-4333-8444-555555555555" });
    expect(
      r.accept(encodeFrame({ ...reboot, frameSeq: 1, capturedAtMs: 3_000 }, jpeg(10))[0]),
    ).toBe("frame");
    expect(r.accept(encodeFrame(meta({ frameSeq: 51, capturedAtMs: 2_500 }), jpeg(10))[0])).toBe(
      "stale",
    );
  });

  test("tracks at most 32 workers", () => {
    const r = receiver();
    for (let index = 0; index < LIMITS.workers; index += 1) {
      const workerId =
        String.fromCharCode(97 + (index % 16)).repeat(31) + "abcdefghijklmnop"[index >> 4];
      expect(r.accept(encodeFrame(meta({ workerId }), jpeg(10))[0])).toBe("frame");
    }
    const extra = meta({ workerId: "p".repeat(32) });
    expect(r.accept(encodeFrame(extra, jpeg(10))[0])).toBe("too-many-workers");
  });
});
