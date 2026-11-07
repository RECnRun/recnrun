import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import { createAdmission } from "./site/admission.js";
import { createObserve } from "./site/observe-client.js";

/* W6 review fixes, master side: frame admission and the observe client's requests, without a browser. */

vi.mock("./site/jobs.js", () => ({
  sign: async (fields: Record<string, unknown>) => ({ ...fields, signature: "c2ln" }),
}));

const BOOT = "11111111-2222-4333-8444-555555555555";
const JOB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const plain = (uuid: string) => uuid.replaceAll("-", "");

describe("the master's frame admission", () => {
  const session = { bootId: BOOT, jobId: JOB, targetId: 7, sessionEpoch: 5 };
  const frame = (overrides = {}) => ({
    bootId: plain(BOOT),
    jobId: plain(JOB),
    targetId: 7,
    sessionEpoch: 5,
    frameSeq: 1,
    ...overrides,
  });

  type Frame = ReturnType<typeof frame>;

  test("a frame that beats the worker's accept is held, then shown once it accepts", () => {
    const shown: number[] = [];
    const admission = createAdmission();
    admission.request("w", session);
    admission.offer("w", frame(), (value: Frame) => shown.push(value.frameSeq));
    expect(shown).toEqual([]);
    admission.accept("w", (value: Frame) => shown.push(value.frameSeq));
    expect(shown).toEqual([1]);
  });

  test("a refused start shows nothing, not even the frame it held", () => {
    const shown: number[] = [];
    const admission = createAdmission();
    admission.request("w", session);
    admission.offer("w", frame(), (value: Frame) => shown.push(value.frameSeq));
    admission.revoke("w", "refused");
    admission.accept("w", (value: Frame) => shown.push(value.frameSeq));
    expect(shown).toEqual([]);
  });

  test("frames of another tab or another session are refused", () => {
    const admission = createAdmission();
    admission.request("w", session);
    admission.accept("w", () => undefined);
    expect(admission.check("w", frame({ targetId: 8 }))).toBe("wrong-target");
    expect(admission.check("w", frame({ sessionEpoch: 4 }))).toBe("wrong-session");
    expect(admission.check("w", frame())).toBeNull();
  });

  test("an accepted session lapses without renewals and at its grant", () => {
    const clock = { now: 0 };
    const admission = createAdmission({ now: () => clock.now, grantMs: 10_000 });
    admission.request("w", session);
    admission.accept("w", () => undefined);
    clock.now = 2_000;
    admission.renewed("w");
    clock.now = 4_500;
    expect(admission.check("w", frame())).toBeNull();
    clock.now = 5_100;
    expect(admission.check("w", frame())).toBe("lapsed");
    expect(admission.check("w", frame())).toBe("unsolicited");
    admission.request("w", session);
    admission.accept("w", () => undefined);
    for (clock.now = 5_100; clock.now < 16_000; clock.now += 1_000) admission.renewed("w");
    expect(admission.check("w", frame())).toBe("lapsed");
  });
});

class Channel extends EventTarget {
  readyState = "open";
  sent: Record<string, unknown>[] = [];
  send(text: string) {
    this.sent.push(JSON.parse(text));
  }
  of(type: string) {
    return this.sent.filter((message) => message.type === type);
  }
  reply(request: Record<string, unknown> | undefined, body: Record<string, unknown>) {
    const data = JSON.stringify({
      type: `${String(request?.type)}-reply`,
      requestId: request?.requestId,
      ...body,
    });
    this.dispatchEvent(new MessageEvent("message", { data }));
  }
  push(message: Record<string, unknown>) {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(message) }));
  }
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function flush(rounds = 10) {
  for (let round = 0; round < rounds; round += 1) await tick();
}

describe("the master's observe client", () => {
  let channel: Channel;
  let calls: string[];
  let client: ReturnType<typeof createObserve>;

  beforeEach(() => {
    vi.useFakeTimers({
      now: 1_000_000,
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    channel = new Channel();
    calls = [];
    const record = (name: string) => (_link: string, reason?: unknown) =>
      void calls.push(typeof reason === "string" ? `${name}:${reason}` : name);
    const visual = {
      jobStatus: async () => ({ bootId: BOOT, jobs: [{ targetId: 7 }] }),
      beginSession: record("begin"),
      acceptSession: record("accept"),
      renewed: record("renewed"),
      endSession: record("end"),
    };
    const links = new Map([["w", { channel, proven: { workerId: "a".repeat(32) } }]]);
    client = createObserve({ links, visual });
  });
  afterEach(() => vi.useRealTimers());

  /** An Observe the worker accepts; renewals then go out every second. */
  async function observing() {
    const reply = client.observeStart("w", JOB, "thumbnail");
    await flush();
    const [start] = channel.of("OBSERVE_START");
    channel.reply(start, { ok: true });
    expect(await reply).toMatchObject({ ok: true });
    return start;
  }

  test("frames are admitted only once the worker accepted the start", async () => {
    await observing();
    expect(calls).toEqual(["begin", "accept"]);
  });

  test("a request the worker never answers settles as TIMEOUT and is forgotten", async () => {
    const reply = client.observeStart("w", JOB, "thumbnail");
    await vi.advanceTimersByTimeAsync(10_001);
    expect(await reply).toMatchObject({ ok: false, code: "TIMEOUT" });
    expect(client.observePending()).toBe(0);
  });

  test("renewals never pile up while the worker is silent", async () => {
    await observing();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(channel.of("OBSERVE_STATUS")).toHaveLength(1);
  });

  test("a closed channel settles its requests, stops renewing, and revokes admission", async () => {
    await observing();
    const reply = client.observeMode("w", "live");
    await flush();
    channel.dispatchEvent(new Event("close"));
    expect(await reply).toMatchObject({ ok: false, code: "CLOSED" });
    const sent = channel.sent.length;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channel.sent.length).toBe(sent);
    expect(calls).toContain("end:disconnected");
  });

  test("a renewal refused after an outage starts a fresh session, with bounded attempts", async () => {
    const first = await observing();
    await vi.advanceTimersByTimeAsync(1_000);
    channel.reply(channel.of("OBSERVE_STATUS")[0], { ok: false, code: "NO_SESSION" });
    await flush();
    expect(calls).toContain("end:refused");
    await vi.advanceTimersByTimeAsync(1_000);
    const restarted = channel.of("OBSERVE_START");
    expect(restarted).toHaveLength(2);
    expect(Number(restarted[1]?.sessionEpoch)).toBeGreaterThan(Number(first?.sessionEpoch));
    for (let round = 0; round < 6; round += 1) {
      const last = channel.of("OBSERVE_START").at(-1) ?? {};
      channel.reply(last, { ok: false, code: "RATE_LIMITED" });
      await vi.advanceTimersByTimeAsync(5_000);
    }
    expect(channel.of("OBSERVE_START")).toHaveLength(4);
    expect(client.observeEvents("w").restarts.at(-1)).toMatchObject({ gaveUp: true });
  });

  test("a session the worker ended at its grant stops showing at once and is not restarted", async () => {
    const start = await observing();
    channel.push({
      type: "VISUAL_HEARTBEAT",
      state: "ENDED",
      reason: "AUTHORIZATION_EXPIRED",
      sessionEpoch: start?.sessionEpoch,
    });
    expect(calls).toContain("end:ended");
    await vi.advanceTimersByTimeAsync(1_000);
    channel.reply(channel.of("OBSERVE_STATUS")[0], { ok: false, code: "NO_SESSION" });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(channel.of("OBSERVE_START")).toHaveLength(1);
  });
});
