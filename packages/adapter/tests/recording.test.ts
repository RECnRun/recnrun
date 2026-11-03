import type { CapturedEvent } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { startRecording } from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";
import { now } from "./fake-cdp.ts";

/** Answers `Target.createTarget` with the session's own page, as Chrome does. */
class BrowserChannel extends FakeChannel {
  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const reply = super.send(method, params, sessionId);
    return method === "Target.createTarget" ? reply.then(() => ({ targetId: "ROOT" })) : reply;
  }
}

function attach(
  channel: FakeChannel,
  sessionId: string,
  info: { targetId: string; type: string; openerId?: string },
  options: { waiting?: boolean; parent?: string } = {},
) {
  channel.emit(
    "Target.attachedToTarget",
    {
      sessionId,
      targetInfo: { url: "about:blank", ...info },
      waitingForDebugger: options.waiting ?? true,
    },
    options.parent,
  );
}

async function record() {
  const channel = new BrowserChannel();
  const events: CapturedEvent[] = [];
  const recording = await startRecording("ws://127.0.0.1:9222/devtools/browser/x", {
    now,
    openChannel: async () => channel,
    capture: { runId: "session-1", onEvent: (event) => events.push(event) },
  });
  return { channel, events, recording };
}

const attachedTargets = (events: CapturedEvent[]) =>
  events.filter((e) => e.category === "target" && e.type === "attached").map((e) => e.targetId);

test("opens the session's own page before it attaches to anything", async () => {
  const { channel, recording } = await record();
  expect(recording.targetId).toBe("ROOT");
  expect(channel.sent.slice(0, 2).map(({ method }) => method)).toEqual([
    "Target.createTarget",
    "Target.setAutoAttach",
  ]);
  expect(channel.sent[0]?.params).toEqual({ url: "about:blank" });
});

test("instruments the session's page, its popups, and their frames, never another tab", async () => {
  const { channel, events, recording } = await record();
  attach(channel, "S-ROOT", { targetId: "ROOT", type: "page" }, { waiting: false });
  attach(channel, "S-MAIL", { targetId: "MAIL", type: "page" }, { waiting: false });
  attach(channel, "S-POP", { targetId: "POP", type: "page", openerId: "ROOT" });
  attach(channel, "S-FRAME", { targetId: "FRAME", type: "iframe" }, { parent: "S-POP" });
  attach(channel, "S-NEW", { targetId: "NEW", type: "page", openerId: "MAIL" });
  attach(channel, "S-SW", { targetId: "SW", type: "service_worker" });
  await recording.settled();
  expect(attachedTargets(events)).toEqual(["ROOT", "POP", "FRAME"]);
  expect(recording.report().targets.map(({ targetId }) => targetId)).toEqual([
    "ROOT",
    "POP",
    "FRAME",
  ]);
  expect(channel.methods("S-ROOT")).toContain("Page.addScriptToEvaluateOnNewDocument");
  expect(channel.methods("S-FRAME")).toContain("Page.addScriptToEvaluateOnNewDocument");
  // Tabs outside the scope get nothing installed: a held one is resumed, then each is let go.
  expect(channel.methods("S-MAIL")).toEqual([]);
  expect(channel.methods("S-NEW")).toEqual(["Runtime.runIfWaitingForDebugger"]);
  const detached = channel.sent.filter(({ method }) => method === "Target.detachFromTarget");
  expect(detached.map(({ params }) => params?.sessionId)).toEqual(["S-MAIL", "S-NEW", "S-SW"]);
});

test("ignores the DOM events of a tab outside the scope", async () => {
  const { channel, events, recording } = await record();
  attach(channel, "S-MAIL", { targetId: "MAIL", type: "page" }, { waiting: false });
  channel.emit("Page.frameNavigated", { frame: { id: "MAIL", url: "https://mail" } }, "S-MAIL");
  await recording.settled();
  expect(events).toEqual([]);
});

test("closes the channel when the session's page cannot be opened", async () => {
  const channel = new FakeChannel();
  channel.failing.set("Target.createTarget", "Target creation failed");
  await expect(
    startRecording("ws://127.0.0.1:9222/devtools/browser/x", { openChannel: async () => channel }),
  ).rejects.toThrow("Target creation failed");
  expect(channel.closed).toBe(true);
});
