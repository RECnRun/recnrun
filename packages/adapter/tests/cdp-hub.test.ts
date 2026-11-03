import type { CapturedEvent, DomTarget } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { cdpHub } from "../src/cdp-hub.ts";
import type { CdpChannel, CdpEvent } from "../src/cdp-socket.ts";
import { startPicker, startRecording } from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";
import { now } from "./fake-cdp.ts";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/x";
const PAGE = { type: "page", url: "about:blank" };
const STATUS = { node: { localName: "output", attributes: ["data-testid", "status"] } };

/** Chrome's browser endpoint: lanes are browser sessions L1, L2, …; an attach's event precedes its reply. */
class ChromeChannel extends FakeChannel {
  /** Methods Chrome never answers. */
  readonly holding = new Set<string>();
  private lanes = 0;

  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const reply = super.send(method, params, sessionId);
    if (this.holding.has(method)) return new Promise<unknown>(() => undefined);
    if (method === "Target.attachToBrowserTarget") {
      this.lanes += 1;
      return reply.then(() => ({ sessionId: `L${this.lanes}` }));
    }
    if (method === "Target.attachToTarget") {
      const targetId = String(params?.["targetId"]);
      const attached = `A-${targetId}`;
      this.attachOn(sessionId, attached, targetId);
      return reply.then(() => ({ sessionId: attached }));
    }
    if (method === "Target.createTarget") return reply.then(() => ({ targetId: "ROOT" }));
    if (method === "DOM.describeNode") return reply.then(() => STATUS);
    return reply;
  }

  /** Chrome reports a page session attached under `parent` (a lane or one of its sessions). */
  attachOn(parent: string | undefined, sessionId: string, targetId: string, type = "page") {
    this.emit(
      "Target.attachedToTarget",
      { sessionId, targetInfo: { ...PAGE, type, targetId }, waitingForDebugger: false },
      parent,
    );
  }
}

function heard(channel: CdpChannel): CdpEvent[] {
  const events: CdpEvent[] = [];
  channel.onEvent((event) => events.push(event));
  return events;
}

async function twoLanes() {
  const root = new ChromeChannel();
  const hub = cdpHub(root);
  const first = await hub.lane();
  const second = await hub.lane();
  return { root, hub, first, second, one: heard(first), two: heard(second) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a lane's own commands ride its browser session; child sessions are addressed directly", async () => {
  const { root, first, second } = await twoLanes();
  expect(root.sent).toEqual([
    { method: "Target.attachToBrowserTarget" },
    { method: "Target.attachToBrowserTarget" },
  ]);
  await first.send("Target.setAutoAttach", { autoAttach: true });
  await second.send("Target.getTargets");
  await first.send("Runtime.enable", undefined, "P1");
  expect(root.sent.slice(2)).toEqual([
    { method: "Target.setAutoAttach", params: { autoAttach: true }, sessionId: "L1" },
    { method: "Target.getTargets", sessionId: "L2" },
    { method: "Runtime.enable", sessionId: "P1" },
  ]);
});

test("events reach the lane that attached their session and no other", async () => {
  const { root, one, two } = await twoLanes();
  root.attach("P0", { targetId: "T0", type: "page" });
  root.attachOn("L1", "P1", "T1");
  root.emit("Page.frameNavigated", { frame: {} }, "P1");
  root.emit("Page.frameNavigated", { frame: {} }, "UNKNOWN");
  root.emit("Target.targetCreated", { targetInfo: {} }, "L2");
  expect(one).toEqual([
    {
      method: "Target.attachedToTarget",
      params: {
        sessionId: "P1",
        targetInfo: { ...PAGE, targetId: "T1" },
        waitingForDebugger: false,
      },
    },
    { method: "Page.frameNavigated", params: { frame: {} }, sessionId: "P1" },
  ]);
  expect(two).toEqual([{ method: "Target.targetCreated", params: { targetInfo: {} } }]);
});

test("a session attached under a lane's own session belongs to that lane too", async () => {
  const { root, hub, one, two } = await twoLanes();
  root.attachOn("L1", "P1", "T1");
  root.attachOn("P1", "F1", "T1-frame", "iframe");
  root.emit("Runtime.executionContextCreated", { context: {} }, "F1");
  expect(one.at(-1)).toEqual({
    method: "Runtime.executionContextCreated",
    params: { context: {} },
    sessionId: "F1",
  });
  expect(two).toEqual([]);
  expect(hub.held()).toEqual(new Set(["T1", "T1-frame"]));
});

test("held targets follow attaches, detaches, and the close of a lane", async () => {
  const { root, hub, second } = await twoLanes();
  root.attachOn("L1", "P1", "T1");
  root.attachOn("L2", "P2", "T2");
  expect(hub.held()).toEqual(new Set(["T1", "T2"]));
  root.emit("Target.detachedFromTarget", { sessionId: "P1", targetId: "T1" }, "L1");
  expect(hub.held()).toEqual(new Set(["T2"]));
  second.close();
  expect(hub.held()).toEqual(new Set());
});

test("closing a lane detaches its browser session and rejects what it still awaited", async () => {
  const { root, first, second, one, two } = await twoLanes();
  let firstLost = 0;
  first.onClose(() => (firstLost += 1));
  root.holding.add("Runtime.evaluate");
  const slow = first.send("Runtime.evaluate", { expression: "1" }, "P1");
  first.close();
  await expect(slow).rejects.toThrow(/closed/);
  await expect(first.send("Target.getTargets")).rejects.toThrow(/closed/);
  expect(root.sent.at(-1)).toEqual({
    method: "Target.detachFromTarget",
    params: { sessionId: "L1" },
  });
  // The other lane goes on over the same socket, which stays open.
  root.emit("Target.targetCreated", {}, "L1");
  root.emit("Target.targetCreated", {}, "L2");
  await second.send("Target.getTargets");
  expect(one).toEqual([]);
  expect(two).toHaveLength(1);
  expect(root.closed).toBe(false);
  expect(firstLost).toBe(0);
});

test("a lost socket cuts every lane off once and tells the hub", async () => {
  const { root, hub, first, second } = await twoLanes();
  const lost = { first: 0, second: 0, hub: 0 };
  first.onClose(() => (lost.first += 1));
  second.onClose(() => (lost.second += 1));
  hub.onClose(() => (lost.hub += 1));
  root.lose();
  expect(lost).toEqual({ first: 1, second: 1, hub: 1 });
  await expect(first.send("Target.getTargets")).rejects.toThrow(/closed/);
  await expect(hub.lane()).rejects.toThrow(/closed/);
});

test("closing the hub closes the socket and cuts off the lanes it still carried", async () => {
  const { root, hub, first, second } = await twoLanes();
  const lost = { first: 0, second: 0, hub: 0 };
  first.onClose(() => (lost.first += 1));
  second.onClose(() => (lost.second += 1));
  hub.onClose(() => (lost.hub += 1));
  first.close();
  hub.close();
  expect(root.closed).toBe(true);
  expect(lost).toEqual({ first: 0, second: 1, hub: 0 });
  await expect(second.send("Target.getTargets")).rejects.toThrow(/closed/);
});

test("a recording and a picker on two lanes never see each other's sessions", async () => {
  const root = new ChromeChannel();
  const hub = cdpHub(root);
  const events: CapturedEvent[] = [];
  const recording = await startRecording(ENDPOINT, {
    now,
    openChannel: () => hub.lane(),
    capture: { runId: "session-1", onEvent: (event) => void events.push(event) },
  });
  root.attachOn("L1", "P-ROOT", "ROOT");
  const picked: DomTarget[] = [];
  const picker = await startPicker(ENDPOINT, "ROOT", {
    openChannel: () => hub.lane(),
    onPicked: (target) => picked.push(target),
  });
  await recording.settled();
  // The picker's session of the recorded page gets no instrumentation and is never detached.
  expect(root.methods("A-ROOT")).toEqual([
    "DOM.enable",
    "Overlay.enable",
    "Overlay.setInspectMode",
  ]);
  expect(root.methods("P-ROOT")).toContain("Page.addScriptToEvaluateOnNewDocument");
  expect(root.sent.filter(({ method }) => method === "Target.detachFromTarget")).toEqual([]);
  expect(events.filter((event) => event.category === "target").map((e) => e.targetId)).toEqual([
    "ROOT",
  ]);
  root.emit("Overlay.inspectNodeRequested", { backendNodeId: 7 }, "A-ROOT");
  await settle();
  expect(picked).toEqual([{ tag: "output", testId: "status" }]);
  await picker.stop();
  expect(root.sent.at(-1)).toEqual({
    method: "Target.detachFromTarget",
    params: { sessionId: "L2" },
  });
  // The recording's lane goes on after the picker left the shared socket.
  root.emit("Page.frameNavigated", { frame: { id: "ROOT", url: "https://a" } }, "P-ROOT");
  await recording.settled();
  expect(events.some((event) => event.category === "navigation")).toBe(true);
  recording.stop();
  expect(root.closed).toBe(false);
});
