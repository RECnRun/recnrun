import type { CaptureSink, ReplayBlobs } from "@recnrun/engine";
import { CapturedEventSchema, type CapturedEvent } from "@recnrun/protocol";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { observeReplay } from "../src/replay-observer.ts";
import type { ReplayPage } from "../src/replay-page.ts";
import { ReplyingChannel } from "./capture-harness.ts";
import { now } from "./fake-cdp.ts";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/x";
const API = "http://127.0.0.1:4600/api/json";
const SHA = "a".repeat(64);

/** Chrome as the observer sees it: attaching to a target emits its attach event before answering. */
class ExplicitAttach extends ReplyingChannel {
  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const sent = super.send(method, params, sessionId);
    if (method !== "Target.attachToTarget") return sent;
    const targetId = String(params?.["targetId"]);
    this.attach(`S-${targetId}`, { targetId, type: "page" }, false);
    return sent.then(() => ({ sessionId: `S-${targetId}` }));
  }
}

/** A Playwright page whose CDP session names its target. */
function pageOf(targetId: string, fail = false): ReplayPage {
  const session = {
    send: async () => {
      if (fail) throw new Error("Target closed.");
      return { targetInfo: { targetId } };
    },
    detach: async () => {},
  };
  return { context: () => ({ newCDPSession: async () => session }) } as unknown as ReplayPage;
}

async function observe() {
  const channel = new ExplicitAttach();
  const events: CapturedEvent[] = [];
  const stored: (string | Uint8Array)[] = [];
  const blobs: ReplayBlobs = {
    put: async (content, meta) => {
      stored.push(content);
      return {
        sha256: SHA,
        mime: meta.mime,
        encoding: meta.encoding,
        size: 11,
        condition: "captured",
      };
    },
  };
  const sink: CaptureSink = {
    runId: "run-9",
    event: (event) => {
      expect(v.is(CapturedEventSchema, event)).toBe(true);
      events.push(event);
    },
    blobs,
  };
  const observer = await observeReplay(ENDPOINT, sink, { now, openChannel: async () => channel });
  return { channel, events, stored, observer };
}

test("captures only the tabs replay opened, installed before adopt answers", async () => {
  const { channel, events, observer } = await observe();
  // Playwright's own new page reaches the observer's auto-attach first: not adopted yet, so let go.
  channel.attach("S-AUTO", { targetId: "REPLAY", type: "page" });
  channel.attach("S-MAIL", { targetId: "MAIL", type: "page" }, false);
  await observer.adopt(pageOf("REPLAY"));
  channel.attach("S-POP", { targetId: "POP", type: "page", openerId: "REPLAY" } as never);
  await observer.drain();
  const attached = events.filter((e) => e.category === "target" && e.type === "attached");
  expect(attached.map(({ targetId }) => targetId)).toEqual(["REPLAY", "POP"]);
  expect(events.every(({ runId }) => runId === "run-9")).toBe(true);
  const onReplay = channel.methods("S-REPLAY");
  expect(onReplay).toContain("Page.addScriptToEvaluateOnNewDocument");
  expect(onReplay.at(-1), "the ordering probe goes after the install").toBe("Runtime.evaluate");
  expect(channel.methods("S-AUTO")).toEqual(["Runtime.runIfWaitingForDebugger"]);
  expect(channel.closed, "draining stops the capture").toBe(true);
});

test("response bodies go to the run's blobs as text, so the run can redact them", async () => {
  const { channel, events, stored, observer } = await observe();
  await observer.adopt(pageOf("REPLAY"));
  channel.replies.set("Network.getResponseBody", { body: '{"ok":true}', base64Encoded: false });
  const request = { url: API, method: "GET" };
  channel.emit(
    "Network.requestWillBeSent",
    { requestId: "R1", request, type: "Fetch" },
    "S-REPLAY",
  );
  const response = { url: API, status: 500, statusText: "", mimeType: "application/json" };
  channel.emit(
    "Network.responseReceived",
    { requestId: "R1", type: "Fetch", response },
    "S-REPLAY",
  );
  channel.emit("Network.loadingFinished", { requestId: "R1", encodedDataLength: 11 }, "S-REPLAY");
  await observer.drain();
  expect(stored).toEqual(['{"ok":true}']);
  const network = events.filter(({ category }) => category === "network");
  expect(network.map(({ type }) => type)).toEqual(["request", "response", "finished", "body"]);
  expect(network[1]?.payload).toMatchObject({ status: 500 });
});

test("a tab that cannot be adopted is a target-unattached gap, never a failed step", async () => {
  const { events, observer } = await observe();
  await observer.adopt(pageOf("REPLAY", true));
  expect(events).toMatchObject([
    { category: "gap", type: "target-unattached", producer: "adapter:replay", seq: 1 },
  ]);
  observer.stop();
  await observer.adopt(pageOf("LATER"));
  expect(events).toHaveLength(1);
});
