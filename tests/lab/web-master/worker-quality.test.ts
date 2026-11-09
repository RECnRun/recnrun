import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { CAPS, createGate } from "./worker-extension/observe-gate.js";
import type { GateFrame } from "./worker-extension/observe-gate.js";
import { createQuality } from "./worker-extension/quality.js";
import { HEADER_BYTES } from "./worker-extension/visual-envelope.js";

/* Owner flow, task B: the interact screencast adapts its JPEG quality and gets caps of its own. */

const BUDGET = 200_000;
const UUID = "11111111-2222-4333-8444-555555555555";

describe("the adaptive JPEG quality", () => {
  test("starts at 70, steps down 10 per second over budget, and stops at 30", () => {
    let clock = 0;
    const quality = createQuality({ budget: BUDGET, now: () => clock });
    expect(quality.value()).toBe(70);
    expect(quality.observe(BUDGET + 1)).toBe(true);
    expect(quality.value()).toBe(60);
    clock += 500;
    expect(quality.observe(BUDGET + 1)).toBe(false);
    expect(quality.value()).toBe(60);
    for (let step = 0; step < 5; step += 1) {
      clock += 1_000;
      quality.observe(BUDGET + 1);
    }
    expect(quality.value()).toBe(30);
  });

  test("steps back up under half the budget, holds between, and never passes 70", () => {
    let clock = 0;
    const quality = createQuality({ budget: BUDGET, now: () => clock });
    quality.observe(BUDGET + 1);
    clock += 1_000;
    expect(quality.observe(BUDGET / 2)).toBe(false);
    expect(quality.value()).toBe(60);
    expect(quality.observe(BUDGET / 2 - 1)).toBe(true);
    expect(quality.value()).toBe(70);
    clock += 1_000;
    expect(quality.observe(1)).toBe(false);
    expect(quality.value()).toBe(70);
    quality.observe(BUDGET + 1);
    quality.reset();
    expect(quality.value()).toBe(70);
  });
});

describe("the interact caps", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const frame = (frameSeq: number, size: number): GateFrame => ({
    bytes: new Uint8Array(size),
    width: 1920,
    height: 1080,
    frameSeq,
  });

  test("interact alone takes 1080p frames up to 512 KiB at up to 6 MiB/s", () => {
    expect(CAPS.interact).toMatchObject({
      maxWidth: 1920,
      maxHeight: 1080,
      frameBytes: 524_288,
      bytesPerSecond: 6_291_456,
    });
    expect(CAPS.frameBytes).toBe(194_560);
    expect(CAPS.bytesPerSecond).toBe(1_048_576);
    const sent: number[] = [];
    const gate = createGate({ send: (value) => sent.push(value.frameSeq) });
    gate.setMode("interact");
    for (let seq = 1; seq <= 25; seq += 1) {
      gate.offer(frame(seq, 240_000));
      vi.advanceTimersByTime(40);
    }
    gate.offer(frame(26, 524_289));
    expect(sent.length).toBeGreaterThanOrEqual(24);
    expect(gate.stats().drops["frame-cap"]).toBe(1);
  });

  test("the interact frame cap fits the sender's interact buffer above its low mark", () => {
    const chunks = Math.ceil(CAPS.interact.frameBytes / (16_384 - HEADER_BYTES));
    const needed = CAPS.interact.frameBytes + chunks * HEADER_BYTES + 65_536;
    expect(needed).toBeLessThanOrEqual(CAPS.interact.bufferBytes);
  });
});

describe("the sender's per-frame buffer cap", () => {
  afterEach(() => vi.unstubAllGlobals());

  async function senderWith(bufferCap?: number) {
    vi.stubGlobal("chrome", { runtime: { id: "abcdefghijklmnopabcdefghijklmnop" } });
    const { createSender } = await import("./worker-extension/visual-sender.js");
    const sender = createSender();
    const pc = {} as RTCPeerConnection;
    const channel = {
      readyState: "open",
      bufferedAmount: 0,
      send(message: ArrayBuffer) {
        this.bufferedAmount += message.byteLength;
      },
    };
    sender.attach(channel as unknown as RTCDataChannel, pc);
    sender.select(pc);
    const data = Buffer.alloc(400_000).toString("base64");
    const meta = { bootId: UUID, jobId: UUID, targetId: 1, epoch: 1, frameSeq: 1, width: 1280 };
    const frame = { ...meta, height: 720, sessionEpoch: 1, capturedAtMs: 1, queuedAt: Date.now() };
    sender.relayed({ ...frame, data, ...(bufferCap ? { bufferCap } : {}) });
    return sender.stats();
  }

  test("a 400 KB frame overflows the default buffer but fits an interact frame's cap", async () => {
    expect((await senderWith()).drops.oversize).toBe(1);
    const stats = await senderWith(CAPS.interact.bufferBytes);
    expect(stats.drops.oversize).toBe(0);
    expect(stats.sent).toBe(1);
  });
});
