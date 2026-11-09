import { describe, expect, test } from "vite-plus/test";
import { createViewport, sessionViewport } from "./site/viewport.js";
import type { Viewport } from "./site/viewport.js";

/* The master's viewport match: a debounced, serialized sender and the stale-frame gate. */

type Size = { width: number; height: number };

const rig = (reply: (size: Size) => unknown = (size) => ({ ok: true, effective: size })) => {
  const sent: Size[] = [];
  const timers: { run: () => void; id: number }[] = [];
  const waiting: (() => void)[] = [];
  let hold = false;
  const viewport = createViewport({
    send: async (size: Size) => {
      sent.push(size);
      if (hold) await new Promise<void>((resolve) => waiting.push(resolve));
      return reply(size);
    },
    delay: 300,
    setTimer: (run: () => void) => {
      timers.push({ run, id: timers.length + 1 });
      return timers.length;
    },
    clearTimer: (id: number) => {
      const found = timers.findIndex((timer) => timer.id === id);
      if (found >= 0) timers.splice(found, 1);
    },
  });
  const fire = async () => {
    timers.shift()?.run();
    await Promise.resolve();
    await Promise.resolve();
  };
  return {
    viewport,
    sent,
    timers,
    fire,
    holdReplies: () => (hold = true),
    release: async () => {
      waiting.shift()?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    },
  };
};

describe("sender", () => {
  test("a burst of sizes sends only the last one after the debounce", async () => {
    const { viewport, sent, timers, fire } = rig();
    viewport.observe({ width: 800, height: 600 });
    viewport.observe({ width: 810, height: 600 });
    viewport.observe({ width: 820, height: 610 });
    expect(sent).toEqual([]);
    expect(timers).toHaveLength(1);
    await fire();
    expect(sent).toEqual([{ width: 820, height: 610 }]);
  });

  test("a lease that starts before any size still sends the first one observed", async () => {
    // input-client.js calls now() on every lease start, before owner.js watches the panel.
    const { viewport, sent, fire } = rig();
    await viewport.now();
    viewport.observe({ width: 960, height: 540 });
    await fire();
    expect(sent).toEqual([{ width: 960, height: 540 }]);
  });

  test("a size observed while the last reply settles is still sent", async () => {
    const { viewport, sent, fire, holdReplies, release } = rig();
    holdReplies();
    viewport.observe({ width: 800, height: 600 });
    await fire();
    viewport.observe({ width: 1280, height: 720 });
    await release();
    await fire();
    await release();
    expect(sent).toEqual([
      { width: 800, height: 600 },
      { width: 1280, height: 720 },
    ]);
  });

  test("the size the worker already has is not sent again", async () => {
    const { viewport, sent, fire } = rig();
    viewport.observe({ width: 800, height: 600 });
    await fire();
    viewport.observe({ width: 800, height: 600 });
    expect(sent).toHaveLength(1);
  });

  test("a lease start sends the last observed size at once", async () => {
    const { viewport, sent } = rig();
    viewport.observe({ width: 640, height: 480 });
    await viewport.now();
    expect(sent).toEqual([{ width: 640, height: 480 }]);
  });

  test("only one request is in flight; the newest size follows its reply", async () => {
    const { viewport, sent, fire, holdReplies, release } = rig();
    holdReplies();
    viewport.observe({ width: 800, height: 600 });
    await fire();
    viewport.observe({ width: 900, height: 700 });
    await fire();
    expect(sent).toEqual([{ width: 800, height: 600 }]);
    await release();
    expect(sent).toEqual([
      { width: 800, height: 600 },
      { width: 900, height: 700 },
    ]);
  });

  test("nothing is sent before a size was observed", async () => {
    const { viewport, sent } = rig();
    await viewport.now();
    expect(sent).toEqual([]);
  });
});

describe("effective size and frame gate", () => {
  test("the worker's effective size is what pointers aim with", async () => {
    const { viewport } = rig((size) => ({
      ok: true,
      effective: { width: size.width - 10, height: size.height },
      viewportSeq: 4,
    }));
    expect(viewport.effective()).toBeNull();
    viewport.observe({ width: 800, height: 600 });
    await viewport.now();
    expect(viewport.effective()).toEqual({ width: 790, height: 600 });
  });

  test("frames older than the last effective viewportSeq are dropped", async () => {
    const { viewport } = rig(() => ({
      ok: true,
      effective: { width: 1, height: 1 },
      viewportSeq: 5,
    }));
    viewport.observe({ width: 800, height: 600 });
    await viewport.now();
    expect(viewport.accepts({ viewportSeq: 4 })).toBe(false);
    expect(viewport.accepts({ viewportSeq: 5 })).toBe(true);
    expect(viewport.accepts({ viewportSeq: 6 })).toBe(true);
    expect(viewport.accepts({})).toBe(true);
  });

  test("a refused request keeps the earlier effective size", async () => {
    let answer: unknown = { ok: true, effective: { width: 700, height: 500 }, viewportSeq: 2 };
    const { viewport } = rig(() => answer);
    viewport.observe({ width: 700, height: 500 });
    await viewport.now();
    answer = { ok: false, code: "BAD_LEASE" };
    viewport.observe({ width: 900, height: 900 });
    await viewport.now();
    expect(viewport.effective()).toEqual({ width: 700, height: 500 });
  });

  test("reset forgets the sent size and the gate for a new lease", async () => {
    const { viewport, sent } = rig(() => ({
      ok: true,
      effective: { width: 1, height: 1 },
      viewportSeq: 9,
    }));
    viewport.observe({ width: 800, height: 600 });
    await viewport.now();
    viewport.reset();
    expect(viewport.accepts({ viewportSeq: 1 })).toBe(true);
    expect(viewport.effective()).toBeNull();
    await viewport.now();
    expect(sent).toHaveLength(2);
  });
});

type Holder = { lease: unknown; seq: number; viewport?: Viewport };

describe("sessionViewport", () => {
  test("rides the lease as INTERACT_VIEWPORT and echoes its own seq when the reply has none", async () => {
    const calls: unknown[] = [];
    const session: Holder = { lease: { leaseId: "l" }, seq: 6 };
    const viewport = sessionViewport(session, async (_session, type, extra) => {
      calls.push([type, extra]);
      return { ok: true, effective: extra };
    });
    viewport.observe({ width: 500, height: 400 });
    await viewport.now();
    expect(calls).toEqual([["INTERACT_VIEWPORT", { width: 500, height: 400 }]]);
    expect(viewport.effective()).toEqual({ width: 500, height: 400 });
    expect(viewport.accepts({ viewportSeq: 6 })).toBe(false);
    expect(viewport.accepts({ viewportSeq: 7 })).toBe(true);
  });

  test("without a lease nothing is sent", async () => {
    const session: Holder = { lease: null, seq: 0 };
    const viewport = sessionViewport(session, async () => {
      throw new Error("must not send");
    });
    viewport.observe({ width: 1, height: 1 });
    await viewport.now();
    expect(viewport.effective()).toBeNull();
  });
});
