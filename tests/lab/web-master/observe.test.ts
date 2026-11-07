import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createReceiver } from "./site/visual-receiver.js";
import { createObserveCheck } from "./worker-extension/observe-check.js";
import type { CheckContext } from "./worker-extension/observe-check.js";
import { CAPS, createGate } from "./worker-extension/observe-gate.js";
import type { Caps, GateFrame } from "./worker-extension/observe-gate.js";
import { requestError } from "./worker-extension/observe-schema.js";
import { encodeFrame } from "./worker-extension/visual-envelope.js";

/* W6 slice C: the closed observe schema, its signed check, and the worker's frame caps. */

const WORKER = "abcdefghijklmnopabcdefghijklmnop";
const BOOT = "11111111-2222-4333-8444-555555555555";
const JOB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const request = (overrides: Record<string, unknown> = {}) => ({
  type: "OBSERVE_START",
  requestId: crypto.randomUUID(),
  workerId: WORKER,
  bootId: BOOT,
  jobId: JOB,
  targetId: 7,
  mode: "thumbnail",
  sessionEpoch: 2,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 10_000,
  nonce: crypto.randomUUID().replaceAll("-", ""),
  ...overrides,
});

const keyPair = () => crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);

async function signWith(
  key: CryptoKey,
  fields: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const data = new TextEncoder().encode(canonical(fields));
  const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return { ...fields, signature: Buffer.from(raw).toString("base64") };
}

describe("the closed observe schema", () => {
  test("a well-formed request passes", () => {
    expect(requestError({ ...request(), signature: "c2ln" })).toBeNull();
  });

  test.each([
    ["an unknown field", { selector: "#go" }],
    ["a URL field", { url: "https://example.test/" }],
    ["code in the mode", { mode: "live;eval(1)" }],
    ["an unknown type", { type: "OBSERVE_EVAL" }],
    ["a mode a stop does not take", { type: "OBSERVE_STOP", mode: "live" }],
    ["a job id that is not a UUID", { jobId: "../job" }],
    ["a ttl over 30 s", { expiresAt: Date.now() + 60_000 }],
  ])("%s is refused", (_name, overrides) => {
    expect(requestError({ ...request(overrides), signature: "c2ln" })).toBe("INVALID_REQUEST");
  });
});

describe("the signed observe check", () => {
  let master: CryptoKeyPair;
  let context: CheckContext;
  const finished = new Set(["99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee"]);

  beforeEach(async () => {
    master = await keyPair();
    context = {
      masterKey: await crypto.subtle.exportKey("jwk", master.publicKey),
      workerId: WORKER,
      bootId: BOOT,
      job: { jobId: JOB, targetId: 7 },
      finished: async (jobId) => finished.has(jobId),
      session: null,
      highestEpoch: 1,
    };
  });

  const signed = (overrides: Record<string, unknown> = {}) =>
    signWith(master.privateKey, request(overrides));

  test("a request signed by the pinned key for this job's tab is accepted", async () => {
    expect(await createObserveCheck().check(await signed(), context)).toBeNull();
  });

  test.each([
    ["an expired ttl", { issuedAt: Date.now() - 20_000, expiresAt: Date.now() - 1 }, "EXPIRED"],
    ["an unknown job", { jobId: crypto.randomUUID() }, "UNKNOWN_JOB"],
    ["a finished job", { jobId: "99999999-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, "JOB_FINISHED"],
    ["another tab", { targetId: 8 }, "WRONG_TARGET"],
    ["an old boot", { bootId: crypto.randomUUID() }, "OLD_BOOT"],
    ["an old session epoch", { sessionEpoch: 1 }, "OLD_EPOCH"],
    ["another worker", { workerId: "pppppppppppppppppppppppppppppppp" }, "WRONG_WORKER"],
  ])("%s is refused", async (_name, overrides, code) => {
    expect(await createObserveCheck().check(await signed(overrides), context)).toBe(code);
  });

  test("a request signed by another key is refused", async () => {
    const other = await keyPair();
    const message = await signWith(other.privateKey, request());
    expect(await createObserveCheck().check(message, context)).toBe("UNPINNED_MASTER");
  });

  test("a replayed request id or nonce is refused", async () => {
    const check = createObserveCheck();
    const first = await signed();
    expect(await check.check(first, context)).toBeNull();
    expect(await check.check(first, context)).toBe("REPLAY");
    const sameNonce = await signed({ nonce: first.nonce, sessionEpoch: 3 });
    expect(await check.check(sameNonce, context)).toBe("REPLAY");
  });

  test("a stop of a session that is not the current one is refused", async () => {
    const check = createObserveCheck();
    const live = { ...context, session: { sessionEpoch: 5 }, highestEpoch: 5 };
    const stop = { type: "OBSERVE_STOP", mode: "off" };
    expect(await check.check(await signed({ ...stop, sessionEpoch: 4 }), live)).toBe("OLD_EPOCH");
    expect(await check.check(await signed({ ...stop, sessionEpoch: 5 }), live)).toBeNull();
  });

  test("requests over the rate are refused before any signature work", async () => {
    const check = createObserveCheck({ rate: { max: 3, windowMs: 10_000 } });
    const codes = [];
    for (let index = 0; index < 5; index += 1) {
      codes.push(await check.check(await signed({ sessionEpoch: 2 + index }), context));
    }
    expect(codes).toEqual([null, null, null, "RATE_LIMITED", "RATE_LIMITED"]);
  });

  test("refused arrivals do not grow the rate history", async () => {
    const check = createObserveCheck({ rate: { max: 3, windowMs: 10_000 } });
    for (let index = 0; index < 100; index += 1) await check.check({}, context);
    expect(check.sizes().recent).toBeLessThanOrEqual(3);
  });
});

describe("the worker's frame caps", () => {
  beforeEach(() => vi.useFakeTimers({ now: 1_000_000 }));
  afterEach(() => vi.useRealTimers());

  const frame = (frameSeq: number, size = 20_000, width = 480, height = 270): GateFrame => ({
    bytes: new Uint8Array(size),
    width,
    height,
    frameSeq,
  });

  /** Offers a frame every 50 ms for `ms`; answers the sequence numbers sent. */
  function stream(mode: "thumbnail" | "live", ms: number, caps: Caps = CAPS, size = 20_000) {
    const sent: number[] = [];
    const gate = createGate({ send: (value) => sent.push(value.frameSeq), caps });
    gate.setMode(mode);
    for (let seq = 1; seq <= ms / 50; seq += 1) {
      gate.offer(frame(seq, size, mode === "live" ? 960 : 480, mode === "live" ? 540 : 270));
      vi.advanceTimersByTime(50);
    }
    return { sent, gate };
  }

  test("thumbnail sends at most 1 frame per second and live at most 5", () => {
    // Over 3 s, both ends included: one frame at 0 ms, then one per interval.
    expect(stream("thumbnail", 3_000).sent).toHaveLength(4);
    expect(stream("live", 3_000).sent).toHaveLength(16);
  });

  test("the last frame offered is sent once the interval allows", () => {
    const sent: number[] = [];
    const gate = createGate({ send: (value) => sent.push(value.frameSeq) });
    gate.setMode("thumbnail");
    gate.offer(frame(1));
    gate.offer(frame(2));
    gate.offer(frame(3));
    vi.advanceTimersByTime(1_000);
    expect(sent).toEqual([1, 3]);
    expect(gate.stats().drops.replaced).toBe(1);
  });

  test("a frame over the mode's size or the per-frame byte cap is never sent", () => {
    const sent: number[] = [];
    const gate = createGate({ send: (value) => sent.push(value.frameSeq) });
    gate.setMode("thumbnail");
    gate.offer(frame(1, 1_000, 960, 540));
    gate.offer(frame(2, CAPS.frameBytes + 1));
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([]);
    expect(gate.stats().drops).toMatchObject({ dimensions: 1, "frame-cap": 1 });
  });

  test("the per-frame cap fits the sender's buffer above its low mark", () => {
    // visual-sender.js sends when the buffer is at most 64 KiB and drops above 256 KiB.
    const chunks = Math.ceil(CAPS.frameBytes / (16_384 - 82));
    expect(CAPS.frameBytes + chunks * 82 + 65_536).toBeLessThanOrEqual(262_144);
  });

  test("the byte budget holds a mode's rate down", () => {
    const tight = { ...CAPS, bytesPerSecond: 100_000 };
    const { sent, gate } = stream("live", 3_000, tight, 40_000);
    expect(sent.length).toBeLessThanOrEqual(8);
    expect(gate.stats().bytes).toBeLessThanOrEqual(3 * 100_000 + 40_000);
  });

  test("a mode change drops a held frame over the new mode's size", () => {
    const sent: number[] = [];
    const gate = createGate({ send: (value) => sent.push(value.frameSeq) });
    gate.setMode("live");
    gate.offer(frame(1, 1_000, 960, 540));
    gate.offer(frame(2, 1_000, 960, 540));
    gate.setMode("thumbnail");
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([1]);
    expect(gate.stats().drops.dimensions).toBe(1);
  });

  test("a held frame the session no longer allows is dropped at send", () => {
    const sent: number[] = [];
    let allowed = true;
    const gate = createGate({ send: (value) => sent.push(value.frameSeq), valid: () => allowed });
    gate.setMode("thumbnail");
    gate.offer(frame(1));
    gate.offer(frame(2));
    allowed = false;
    vi.advanceTimersByTime(2_000);
    expect(sent).toEqual([1]);
    expect(gate.stats().drops.invalid).toBe(1);
  });

  test("no mode sends nothing and frees the frame it held", () => {
    const sent: number[] = [];
    const gate = createGate({ send: (value) => sent.push(value.frameSeq) });
    gate.setMode("thumbnail");
    gate.offer(frame(1));
    gate.offer(frame(2));
    gate.setMode(null);
    gate.offer(frame(3));
    vi.advanceTimersByTime(3_000);
    expect(sent).toEqual([1]);
  });
});

describe("the master's receiver across sessions", () => {
  const jpeg = (size: number) => {
    const bytes = new Uint8Array(size);
    bytes.set([0xff, 0xd8]);
    return bytes;
  };
  const message = (bootId: string, capturedAtMs: number) =>
    encodeFrame(
      {
        workerId: WORKER,
        bootId,
        jobId: JOB,
        targetId: 7,
        epoch: 1,
        frameSeq: 1,
        width: 480,
        height: 270,
        capturedAtMs,
      },
      jpeg(100),
    )[0];
  const hex = "0123456789abcdef0123456789abcdef";

  test("a new session's first frame is shown even when its clock reads earlier", () => {
    const receiver = createReceiver({ onFrame: () => undefined });
    expect(receiver.accept(message(BOOT, 5_000))).toBe("frame");
    receiver.reset(hex);
    expect(receiver.accept(message("22222222-2222-4333-8444-555555555555", 1_000))).toBe("frame");
  });

  test("a frame its link does not admit is dropped with the link's reason", () => {
    const shown: unknown[] = [];
    const receiver = createReceiver({ onFrame: (value) => shown.push(value) });
    expect(receiver.accept(message(BOOT, 1_000), () => "unproven")).toBe("unproven");
    expect(shown).toHaveLength(0);
    expect(receiver.stats().drops.unproven).toBe(1);
  });
});
