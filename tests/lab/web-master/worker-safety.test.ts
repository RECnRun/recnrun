import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";

import type { CaptureFrame } from "./worker-extension/capture.js";

/*
 * W6 review fixes, worker side: capture.js and observe.js against a fake chrome.debugger debuggee,
 * with signature checks and screenshot replies whose completion each test controls.
 */

const WORKER = "abcdefghijklmnopabcdefghijklmnop";
const JOB = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORIGIN = "https://a.test";
const TAB = 7;

const control = vi.hoisted(() => ({
  verify: new Map<number, (ok: boolean) => void>(),
  job: null as null | { jobId: string; tabId: number; origins: string[] },
}));

vi.mock("./worker-extension/job-check.js", () => ({
  signatureValid: (message: { sessionEpoch: number }) =>
    new Promise<boolean>((resolve) => control.verify.set(message.sessionEpoch, resolve)),
}));
vi.mock("./worker-extension/runner.js", () => ({ current: () => control.job }));
vi.mock("./worker-extension/ledger.js", () => ({ load: async () => undefined }));

// A JPEG start-of-frame of 32×16, enough for decodeFrame's size readout.
const JPEG = Buffer.from([
  0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x00, 0x10, 0x00, 0x20, 0x03, 0, 0, 0, 0, 0, 0,
]).toString("base64");

interface Fake {
  events: ((source: { tabId: number }, method: string, params: unknown) => void)[];
  commands: { method: string; params: Record<string, unknown> }[];
  messages: { type: string }[];
  screenshot: () => Promise<{ data: string }>;
}

function installChrome(): Fake {
  const fake: Fake = {
    events: [],
    commands: [],
    messages: [],
    screenshot: async () => ({ data: JPEG }),
  };
  const sendCommand = async (_target: unknown, method: string, params = {}) => {
    fake.commands.push({ method, params });
    if (method === "Page.captureScreenshot") return fake.screenshot();
    if (method === "Page.getLayoutMetrics") {
      return { cssVisualViewport: { clientWidth: 32, clientHeight: 16 } };
    }
    return {};
  };
  vi.stubGlobal("chrome", {
    debugger: {
      onEvent: { addListener: (listener: Fake["events"][number]) => fake.events.push(listener) },
      onDetach: { addListener: () => undefined },
      sendCommand,
    },
    runtime: {
      id: WORKER,
      sendMessage: async (message: { type: string }) => void fake.messages.push(message),
    },
    storage: { local: { get: async () => ({ provision: { masterKey: { kty: "EC" } } }) } },
  });
  return fake;
}

const tick = () => new Promise((resolve) => setImmediate(resolve));
async function flush(rounds = 20) {
  for (let round = 0; round < rounds; round += 1) await tick();
}

const emit = (fake: Fake, method: string, params: unknown) => {
  for (const listener of fake.events) listener({ tabId: TAB }, method, params);
};
const navigate = (fake: Fake, path: string) =>
  emit(fake, "Page.frameNavigated", { frame: { id: "main", url: `${ORIGIN}${path}` } });
const paint = (fake: Fake) =>
  emit(fake, "Page.screencastFrame", {
    data: JPEG,
    metadata: { timestamp: Date.now() / 1_000 },
    sessionId: 1,
  });

let fake: Fake;
beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({
    now: 1_000_000,
    toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
  });
  control.verify.clear();
  control.job = { jobId: JOB, tabId: TAB, origins: [ORIGIN] };
  fake = installChrome();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const load = async () => ({
  capture: await import("./worker-extension/capture.js"),
  observe: await import("./worker-extension/observe.js"),
});

/** A signed-looking request; the mocked check settles its signature when the test says. */
const request = (bootId: string, type: string, sessionEpoch: number, mode = "thumbnail") => ({
  type,
  requestId: crypto.randomUUID(),
  workerId: WORKER,
  bootId,
  jobId: JOB,
  targetId: TAB,
  mode,
  sessionEpoch,
  issuedAt: Date.now(),
  expiresAt: Date.now() + 10_000,
  nonce: crypto.randomUUID().replaceAll("-", ""),
  signature: "c2ln",
});

async function release(epoch: number) {
  for (let round = 0; round < 50 && !control.verify.has(epoch); round += 1) await tick();
  control.verify.get(epoch)?.(true);
  control.verify.delete(epoch);
  await flush();
}

/** An accepted session on the bound job tab, on an allowed document. */
async function observing(mode: "thumbnail" | "live") {
  const { capture, observe } = await load();
  capture.bind({ tabId: TAB }, JOB);
  navigate(fake, "/one");
  const reply = observe.observe(request(capture.bootId(), "OBSERVE_START", 2, mode), "link");
  await release(2);
  expect(await reply).toMatchObject({ ok: true });
  return { capture, observe };
}

const relayed = () => fake.messages.filter((message) => message.type === "visual-frame").length;

describe("the worker's screenshot", () => {
  test("a screenshot answered after a navigation is dropped, not stamped as the new document", async () => {
    const { capture } = await load();
    let answer: (value: { data: string }) => void = () => undefined;
    fake.screenshot = () => new Promise((resolve) => (answer = resolve));
    const sunk: CaptureFrame[] = [];
    capture.setSink(async (frame) => void sunk.push(frame));
    await capture.start({ mode: "thumbnail" });
    capture.bind({ tabId: TAB }, JOB);
    await flush();
    navigate(fake, "/two");
    answer({ data: JPEG });
    await flush();
    expect(sunk).toEqual([]);
    expect(capture.lastFrame()).toBeNull();
  });

  test("a screenshot takes no clip, so Chrome never swaps the page's view size", async () => {
    const { capture } = await load();
    await capture.start({ mode: "thumbnail" });
    capture.bind({ tabId: TAB }, JOB);
    await flush();
    const shot = fake.commands.find((entry) => entry.method === "Page.captureScreenshot");
    expect(shot?.params).not.toHaveProperty("clip");
  });
});

describe("the worker's observe session", () => {
  test("a frame past its authorization is never relayed, even before the next tick", async () => {
    (await load()).observe.observeLab.limit({ maxAuthMs: 1_000 });
    await observing("thumbnail");
    const before = relayed();
    vi.setSystemTime(Date.now() + 2_000);
    paint(fake);
    await flush();
    expect(relayed()).toBe(before);
  });

  test("a navigation drops the frame the gate held for the old document", async () => {
    await observing("live");
    paint(fake);
    await flush();
    paint(fake);
    await flush();
    const before = relayed();
    navigate(fake, "/two");
    await vi.advanceTimersByTimeAsync(300);
    await flush();
    expect(relayed()).toBe(before);
  });

  test("concurrent starts never roll the session epoch back", async () => {
    const { capture, observe } = await load();
    const boot = capture.bootId();
    const newer = observe.observe(request(boot, "OBSERVE_START", 3), "link");
    const older = observe.observe(request(boot, "OBSERVE_START", 2), "link");
    await flush();
    await release(3);
    await release(2);
    expect(await newer).toMatchObject({ ok: true });
    expect(await older).toMatchObject({ ok: false, code: "OLD_EPOCH" });
    expect(observe.observeLab.stats().highestEpoch).toBe(3);
  });

  test("a request whose job ended while its signature was checked is refused", async () => {
    const { capture, observe } = await load();
    const reply = observe.observe(request(capture.bootId(), "OBSERVE_START", 2), "link");
    await flush();
    control.job = null;
    await release(2);
    expect(await reply).toMatchObject({ ok: false });
    expect(observe.observeLab.stats().session).toBeNull();
  });
});

describe("the worker's visual sender", () => {
  test("a closed visual.v1 is forgotten and no frame is sent on it", async () => {
    const { createSender } = await import("./worker-extension/visual-sender.js");
    const sender = createSender();
    const pc = {} as RTCPeerConnection;
    const channel = { readyState: "open", bufferedAmount: 0 } as RTCDataChannel;
    sender.attach(channel, pc);
    sender.select(pc);
    expect(sender.stats().links).toBe(1);
    Object.assign(channel, { readyState: "closed" });
    channel.onclose?.(new Event("close"));
    expect(sender.stats().links).toBe(0);
  });
});
