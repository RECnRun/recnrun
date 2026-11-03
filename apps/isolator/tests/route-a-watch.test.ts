import { withMarker } from "@recnrun/worker-bootstrap";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { TargetInfo } from "@/background/probes/types";
import { NOT_ALLOWED } from "./fake-debugger";
import { APP, INSTALLED, TARGETS, setup } from "./route-a-setup";

const NEW_SW: TargetInfo = {
  type: "worker",
  id: "sw-new",
  url: `${APP}/sw-main.js?variant=classic`,
  attached: false,
};
const NEW_DEDICATED: TargetInfo = {
  type: "other",
  id: "dedicated-new",
  url: `${APP}/worker.js?type=module`,
  attached: false,
};
const NEW_ELSEWHERE: TargetInfo = {
  type: "worker",
  id: "idp-new",
  url: "http://idp.localhost:4602/sw.js",
  attached: false,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Route A watch", () => {
  test("skips the origin's workers listed at watch and attaches each new one once, by id", async () => {
    const targets = [...TARGETS];
    const { engine, sent, onDetach } = setup({ targets });
    const detached: unknown[] = [];
    onDetach.addListener((source) => detached.push(source));
    expect(await engine.watch({ origin: APP, marker: "w1" })).toEqual({
      intervalMs: 10,
      staleSkipped: 2,
    });
    targets.push(NEW_SW, NEW_DEDICATED, NEW_ELSEWHERE);
    await vi.advanceTimersByTimeAsync(30);
    const report = await engine.unwatch();
    expect(sent.map((item) => [item.target, item.method])).toEqual([
      [{ targetId: "sw-new" }, "Runtime.evaluate"],
      [{ targetId: "dedicated-new" }, "Runtime.evaluate"],
    ]);
    expect(sent[0]?.params).toMatchObject({ expression: withMarker("w1") });
    expect(report).toMatchObject({ origin: APP, marker: "w1", intervalMs: 10, staleSkipped: 2 });
    expect(report.polls).toBeGreaterThanOrEqual(3);
    expect(report.entries).toEqual([
      {
        sessionId: "",
        targetId: "sw-new",
        type: "worker",
        url: NEW_SW.url,
        waitingForDebugger: false,
        attachedAt: expect.any(Number),
        attachMs: expect.any(Number),
        marker: "w1",
        bootstrapMs: expect.any(Number),
        installed: INSTALLED,
        released: false,
      },
      expect.objectContaining({ targetId: "dedicated-new", type: "other", installed: INSTALLED }),
    ]);
    expect(detached).toEqual([{ targetId: "sw-new" }, { targetId: "dedicated-new" }]);
  });

  test("keeps Chrome's exact errors for a refused attach and a failed poll", async () => {
    const targets = [...TARGETS];
    const { engine, api, sent } = setup({ targets });
    api.attach = async () => {
      throw new Error("Cannot attach to this target.");
    };
    await engine.watch({ origin: APP, marker: "w1", intervalMs: 50 });
    targets.push(NEW_SW);
    await vi.advanceTimersByTimeAsync(50);
    const getTargets = api.getTargets.bind(api);
    api.getTargets = async () => {
      throw new Error(NOT_ALLOWED);
    };
    await vi.advanceTimersByTimeAsync(50);
    api.getTargets = getTargets;
    const report = await engine.unwatch();
    expect(report.intervalMs).toBe(50);
    expect(report.pollErrors).toEqual([NOT_ALLOWED]);
    expect(report.entries.map((entry) => [entry.error, entry.installed])).toEqual([
      ["Cannot attach to this target.", undefined],
    ]);
    expect(sent).toEqual([]);
  });

  test("refuses an origin outside the loopback, a URL that is not an origin, and a second watch", async () => {
    const { engine } = setup();
    await expect(engine.watch({ origin: "https://example.com", marker: "w1" })).rejects.toThrow(
      "expected { origin: <loopback origin>, marker: <marker>, intervalMs?: <1-1000> }",
    );
    await expect(engine.watch({ origin: `${APP}/sw.html`, marker: "w1" })).rejects.toThrow(
      "expected { origin",
    );
    await expect(engine.watch({ origin: APP, marker: "a:b" })).rejects.toThrow("expected { origin");
    await expect(engine.unwatch()).rejects.toThrow("not watching");
    await engine.watch({ origin: APP, marker: "w1" });
    await expect(engine.watch({ origin: APP, marker: "w2" })).rejects.toThrow("already watching");
  });
});

describe("Route A closeTarget", () => {
  test("attaches by id, closes the target from its own session, and says whether it is still listed", async () => {
    const { engine, sent } = setup();
    expect(await engine.closeTarget({ targetId: "shared" })).toEqual({
      targetId: "shared",
      attach: "ok",
      close: "ok",
      detach: "ok",
      listedAfter: false,
      at: { start: 5, closed: 10, detached: 15 },
      sessions: [],
    });
    expect(sent).toEqual([
      {
        target: { targetId: "shared" },
        method: "Target.closeTarget",
        params: { targetId: "shared" },
      },
    ]);
  });

  test("keeps Chrome's exact error when it refuses to close or keeps listing the target", async () => {
    const refused = setup({ refused: { "Target.closeTarget": NOT_ALLOWED } });
    const kept = setup({ keepsClosed: true });
    expect(await refused.engine.closeTarget({ targetId: "shared" })).toMatchObject({
      close: NOT_ALLOWED,
      listedAfter: true,
    });
    expect(await kept.engine.closeTarget({ targetId: "shared" })).toMatchObject({
      close: "ok",
      listedAfter: true,
    });
  });
});
