import {
  MAX_DOM_SNAPSHOT_BYTES,
  MAX_SCREENSHOT_BYTES,
  SnapshotEventSchema,
  type BodyRef,
  type Event,
  type RunManifest,
  type Step,
} from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import {
  replayFlow,
  SNAPSHOT_TIMEOUT_MS,
  type PageCapture,
  type ReplayBlobs,
  type ReplayDriver,
  type ReplayRunStore,
} from "../src/index.ts";
import { fakeClock, fakeDriver, flowOf } from "./replay-fakes.ts";

const BOX = { testId: "box" };
const GO: Step = { id: "go", action: "navigate", url: "http://127.0.0.1:4600/" };
const CLICK: Step = { id: "click", action: "click", target: BOX, timeoutMs: 100 };
const SEEN: Step = { id: "seen", assertion: "visible", target: BOX, timeoutMs: 100 };
const PNG = new Uint8Array([137, 80, 78, 71]);
const PIN = "pin-4321";

const MANIFEST: RunManifest = {
  schemaVersion: 1,
  runId: "run-1",
  flowId: "replay",
  flowRevision: "a".repeat(64),
  startedAt: "2026-11-02T10:00:00.000Z",
  captureLevel: "normal",
  versions: { engine: "0.0.0", protocol: 1 },
  bindings: {},
};

type Put = { content: Uint8Array | string; meta: Parameters<ReplayBlobs["put"]>[1] };

/** A run store whose blobs cap like persistence's and name each blob by its order. */
function fakeStore(withBlobs = true) {
  const events: Event[] = [];
  const puts: Put[] = [];
  const blobs: ReplayBlobs = {
    async put(content, meta) {
      puts.push({ content, meta });
      const cap = meta.maxBytes ?? 1_048_576;
      const sha256 = puts.length.toString(16).padStart(64, "0");
      const condition = content.length > cap ? "truncated" : "captured";
      const ref: BodyRef = {
        sha256,
        mime: meta.mime,
        encoding: meta.encoding,
        size: content.length,
        condition,
      };
      return ref;
    },
  };
  const store: ReplayRunStore = {
    async createRun() {
      const journal = {
        append: async (event: Event) => void events.push(event),
        close: async () => {},
      };
      return withBlobs ? { journal, blobs } : { journal };
    },
    async finishRun() {},
  };
  return { store, events, puts };
}

/** A driver whose capture answers `page` and logs the timeout it was given. */
function capturing(page: () => PageCapture | Promise<PageCapture>) {
  const fake = fakeDriver({ elements: {} });
  const timeouts: number[] = [];
  const driver: ReplayDriver = {
    ...fake.driver,
    async capture(options) {
      timeouts.push(options.timeoutMs);
      return page();
    },
  };
  return { driver, timeouts };
}

const page = (html: string, png = PNG): PageCapture => ({
  tab: true,
  url: "http://127.0.0.1:4600/",
  html: { ok: true, value: html },
  screenshot: { ok: true, value: png },
});

const snapshots = (events: readonly Event[]) =>
  events.filter(
    (event): event is Exclude<Event, { category: "gap" }> => event.category === "snapshot",
  );

async function replay(driver: ReplayDriver, steps: Step[], withBlobs = true) {
  const { store, events, puts } = fakeStore(withBlobs);
  const outcome = await replayFlow(driver, flowOf(steps), {
    clock: fakeClock(),
    run: { store, manifest: MANIFEST },
    secrets: { pin: PIN },
  });
  return { outcome, events, puts };
}

describe("snapshots at milestones", () => {
  test("a failed action has before, after, and failure snapshots referencing blobs", async () => {
    const { driver, timeouts } = capturing(() => page("<html><body>Box</body></html>"));
    const { outcome, events, puts } = await replay(driver, [GO, CLICK]);
    expect(outcome.status).not.toBe("passed");
    const taken = snapshots(events).map((event) => [event.stepId, event.payload["milestone"]]);
    expect(taken).toEqual([
      ["go", "before"],
      ["go", "after"],
      ["click", "before"],
      ["click", "after"],
      ["click", "failure"],
    ]);
    for (const event of snapshots(events))
      expect(SnapshotEventSchema["~standard"].validate(event)).not.toHaveProperty("issues");
    expect(snapshots(events)[4]?.payload).toMatchObject({
      url: "http://127.0.0.1:4600/",
      dom: { mime: "text/html", encoding: "utf8", condition: "captured" },
      screenshot: { mime: "image/png", encoding: "binary", size: 4, condition: "captured" },
    });
    expect(puts).toHaveLength(10);
    expect(new Set(timeouts)).toEqual(new Set([SNAPSHOT_TIMEOUT_MS]));
  });

  test("snapshot events come between the step's start and finish, in journal order", async () => {
    const { driver } = capturing(() => page("<p/>"));
    const { events } = await replay(driver, [GO]);
    expect(events.map(({ seq, type }) => [seq, type])).toEqual([
      [1, "step.started"],
      [2, "captured"],
      [3, "captured"],
      [4, "step.finished"],
    ]);
  });

  test("an assertion is captured only when it fails", async () => {
    const { driver } = capturing(() => page("<p/>"));
    const { events } = await replay(driver, [SEEN]);
    expect(snapshots(events).map((event) => event.payload["milestone"])).toEqual(["failure"]);
  });

  test("secret values never reach a stored DOM snapshot", async () => {
    const { driver } = capturing(() => page(`<input value="${PIN}">`));
    const { puts } = await replay(driver, [GO]);
    const html = String(puts[0]?.content);
    expect(html).not.toContain(PIN);
    expect(html).toContain("redacted");
  });
});

describe("snapshot caps and gaps", () => {
  test("a DOM over its cap is truncated; a screenshot over its cap is not stored", async () => {
    const big = "x".repeat(MAX_DOM_SNAPSHOT_BYTES + 10);
    const huge = new Uint8Array(MAX_SCREENSHOT_BYTES + 1);
    const { driver } = capturing(() => page(big, huge));
    const { events, puts } = await replay(driver, [GO]);
    expect(snapshots(events)[0]?.payload).toMatchObject({
      dom: { size: MAX_DOM_SNAPSHOT_BYTES + 10, condition: "truncated" },
      screenshot: { condition: "unavailable", reason: "over-cap" },
    });
    expect(puts.map(({ meta }) => meta.maxBytes)).toEqual([
      MAX_DOM_SNAPSHOT_BYTES,
      MAX_DOM_SNAPSHOT_BYTES,
    ]);
  });

  test("no open tab, a failed part, and a capture that throws are unavailable", async () => {
    const answers: (() => PageCapture)[] = [
      () => ({ tab: false }),
      () => ({ ...page("<p/>"), html: { ok: false, message: "detached" } }),
      () => {
        throw new Error("Target closed");
      },
    ];
    const { driver } = capturing(() => (answers.shift() ?? (() => page("<p/>")))());
    const { outcome, events } = await replay(driver, [GO, { ...GO, id: "again" }]);
    expect(outcome.status).toBe("passed");
    expect(snapshots(events).map(({ payload }) => [payload["dom"], payload["screenshot"]])).toEqual(
      [
        [
          { condition: "unavailable", reason: "no-tab" },
          { condition: "unavailable", reason: "no-tab" },
        ],
        [
          { condition: "unavailable", reason: "capture-failed" },
          expect.objectContaining({ size: 4 }),
        ],
        [
          { condition: "unavailable", reason: "capture-failed" },
          { condition: "unavailable", reason: "capture-failed" },
        ],
        expect.anything(),
      ],
    );
  });

  test("nothing is captured when the run has no blob store", async () => {
    const { driver, timeouts } = capturing(() => page("<p/>"));
    const { events } = await replay(driver, [GO], false);
    expect(snapshots(events)).toEqual([]);
    expect(timeouts).toEqual([]);
  });
});
