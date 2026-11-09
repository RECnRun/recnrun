import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { createEvents } from "./worker-extension/interact-events.js";
import type { Live, TabOps } from "./worker-extension/interact-events.js";
import { createFrames } from "./worker-extension/interact-frames.js";
import { createGate, within } from "./worker-extension/interact-gate.js";
import { createHeld } from "./worker-extension/interact-held.js";
import { detachReason } from "./worker-extension/interact-lease.js";

/* W7 fixes: the bounded queue, the check right before each dispatch, the hold, and letting go. */

const named = (code: string) => code;
const never = () => new Promise<string>(() => undefined);
const settle = () => new Promise((go) => setTimeout(go, 0));

describe("the input queue", () => {
  test("work past its depth is refused and overloads the lease", async () => {
    const overloads: string[] = [];
    const gate = createGate({ depth: 2, onOverload: (code) => overloads.push(code) });
    let open = () => undefined as void;
    const head = gate.serial(() => new Promise<string>((go) => (open = () => go("head"))), named);
    const second = gate.serial(async () => "second", named);
    const third = gate.serial(async () => "third", named);
    expect(overloads).toEqual(["QUEUE_FULL"]);
    await settle();
    open();
    expect(await Promise.all([head, second, third])).toEqual(["head", "second", "QUEUE_FULL"]);
  });

  test("work past its rate is refused", async () => {
    const overloads: string[] = [];
    const gate = createGate({
      rate: 3,
      now: () => 1_000,
      onOverload: (code) => overloads.push(code),
    });
    const replies = await Promise.all(
      [1, 2, 3, 4].map((n) => gate.serial(async (): Promise<number | string> => n, named)),
    );
    expect(replies).toEqual([1, 2, 3, "RATE_LIMITED"]);
    expect(overloads).toEqual(["RATE_LIMITED"]);
  });

  test("work that waited past its age is refused, not run", async () => {
    let at = 0;
    const gate = createGate({ ageMs: 100, now: () => at });
    let open = () => undefined as void;
    const head = gate.serial(() => new Promise<string>((go) => (open = () => go("head"))), named);
    const late = gate.serial(async () => "ran", named);
    await settle();
    at = 200;
    open();
    expect(await Promise.all([head, late])).toEqual(["head", "QUEUE_STALE"]);
  });

  test("an await past its deadline rejects with its code", async () => {
    await expect(within(never(), 10, "OP_TIMEOUT")).rejects.toThrow("OP_TIMEOUT");
  });
});

const GEOMETRY = { deviceWidth: 800, deviceHeight: 600, pageScaleFactor: 1, offsetTop: 0 };
const AIM = { type: "INPUT_EVENT", leaseId: "lease", seq: 1, frameSeq: 1, bootId: "boot" };
const FRAME = { ...AIM, sessionEpoch: 1, loaderId: "L1" };
const DOWN = { ...FRAME, kind: "pointerDown", x: 0.5, y: 0.5, button: "left", clickCount: 1 };
const HOLD = { ...FRAME, kind: "hold" };
const LAYOUT = { width: 800, height: 600, scale: 1 };
const LIVE: Live = { loaderId: "L1", url: "http://a/", zoom: 1, allowed: true, layout: LAYOUT };

const setup = (over: Partial<TabOps> = {}) => {
  const frames = createFrames();
  frames.add({ frameSeq: 1, bootId: "boot", sessionEpoch: 1, loaderId: "L1", geometry: GEOMETRY });
  const sent: string[] = [];
  const revoked: string[] = [];
  const state = { lease: true, pressed: false };
  const tab: TabOps = {
    liveDocument: async () => LIVE,
    mouse: async (params) => {
      sent.push(String(params.type));
      state.pressed = params.type === "mousePressed";
    },
    key: async () => undefined,
    insertText: async () => undefined,
    holding: () => state.pressed,
    releaseHeld: async () => {
      sent.push("release");
      state.pressed = false;
      return true;
    },
    ...over,
  };
  const event = createEvents({
    frames,
    tab,
    stats: { holds: 0, dispatched: 0 },
    refuse: (code, extra = {}) => ({ ok: false, code, ...extra }),
    revoke: (reason) => revoked.push(reason),
    serial: (work) => work(),
    authorized: () => state.lease,
  });
  return { event, sent, revoked, state };
};

describe("one checked event", () => {
  test("a lease revoked while the document is read dispatches nothing", async () => {
    const box: { state?: { lease: boolean } } = {};
    const run = setup({
      liveDocument: async () => {
        if (box.state) box.state.lease = false;
        return LIVE;
      },
    });
    box.state = run.state;
    expect(await run.event(DOWN)).toMatchObject({ ok: false, code: "SESSION_REVOKED" });
    expect(run.sent).toEqual([]);
  });

  test("a read that fails after the revoke closed the tab is that revoke", async () => {
    const box: { state?: { lease: boolean } } = {};
    const run = setup({
      liveDocument: async () => {
        if (box.state) box.state.lease = false;
        throw new Error("Debugger is not attached to the tab");
      },
    });
    box.state = run.state;
    expect(await run.event(DOWN)).toMatchObject({ ok: false, code: "SESSION_REVOKED" });
  });

  test("a hold aimed at an unknown frame is refused", async () => {
    expect(await setup().event({ ...HOLD, frameSeq: 9 })).toMatchObject({ code: "UNKNOWN_FRAME" });
  });

  test("a hold on an off-policy document is refused and revokes", async () => {
    const run = setup({ liveDocument: async () => ({ ...LIVE, allowed: false }) });
    expect(await run.event(HOLD)).toMatchObject({ code: "TARGET_OFF_POLICY" });
    expect(run.revoked).toEqual(["TARGET_OFF_POLICY"]);
  });
});

describe("the dead man", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => void vi.useRealTimers());

  test("a refused event never re-arms it", async () => {
    const run = setup();
    expect(await run.event(DOWN)).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(900);
    expect(await run.event({ ...HOLD, seq: 2, frameSeq: 9 })).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(101);
    expect(run.sent).toEqual(["mousePressed", "release"]);
  });

  test("an accepted hold re-arms it", async () => {
    const run = setup();
    await run.event(DOWN);
    await vi.advanceTimersByTimeAsync(900);
    expect(await run.event({ ...HOLD, seq: 2 })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(101);
    expect(run.sent).toEqual(["mousePressed"]);
    await vi.advanceTimersByTimeAsync(900);
    expect(run.sent).toEqual(["mousePressed", "release"]);
  });

  test("a release it cannot confirm revokes with INPUT_STATE_UNKNOWN", async () => {
    const run = setup({ releaseHeld: async () => false });
    await run.event(DOWN);
    await vi.advanceTimersByTimeAsync(1_001);
    expect(run.revoked).toEqual(["INPUT_STATE_UNKNOWN"]);
  });
});

const MOUSE = "Input.dispatchMouseEvent";
const KEY = "Input.dispatchKeyEvent";
const CANCEL = "Input.cancelDragging";

describe("letting go", () => {
  const pressed = () => {
    const held = createHeld();
    held.track(MOUSE, { type: "mousePressed", x: 1, y: 1, button: "left" });
    held.track(KEY, { type: "keyDown", key: "a", code: "KeyA", windowsVirtualKeyCode: 65 });
    return held;
  };

  test("a drag is cancelled before any key or button goes up", async () => {
    const held = pressed();
    const sent: string[] = [];
    const sure = await held.releaseAll(async (method, params) => {
      sent.push(method === CANCEL ? method : String(params.type));
    });
    expect(sent).toEqual([CANCEL, "keyUp", "mouseReleased"]);
    expect(sure).toBe(true);
    expect(held.any()).toBe(false);
  });

  test("a release that fails stays held and leaves the state unknown", async () => {
    const held = pressed();
    const sure = await held.releaseAll(async (method) => {
      if (method === MOUSE) throw new Error("INPUT_UNKNOWN");
    });
    expect(sure).toBe(false);
    expect(held.size()).toBe(1);
  });

  test("a cancel past its deadline leaves the state unknown", async () => {
    const held = createHeld();
    const sure = await held.releaseAll(async (method) => {
      if (method === CANCEL) throw new Error("INPUT_UNKNOWN");
    });
    expect(sure).toBe(false);
  });

  test("a cancel the protocol refuses means no drag was under way", async () => {
    const held = createHeld();
    const sure = await held.releaseAll(async () => {
      throw new Error("No drag in progress");
    });
    expect(sure).toBe(true);
  });
});

describe("a debugger detach", () => {
  test("the owner's Cancel on the infobar stops the worker", () => {
    expect(detachReason("canceled_by_user")).toBe("WORKER_STOP");
  });

  test("any other detach only ends the lease", () => {
    expect(detachReason("target_closed")).toBe("CDP_DETACHED");
  });
});
