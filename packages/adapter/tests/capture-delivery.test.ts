import { HOOK_VERSION } from "@recnrun/protocol";
import { setTimeout as tick } from "node:timers/promises";
import { expect, test } from "vite-plus/test";
import { capturing, DOC } from "./capture-harness.ts";
import { FakeChannel } from "./fake-channel.ts";
import { instrumentChannel } from "../src/index.ts";

const PRODUCER = `hook:${DOC}`;
const installed = {
  kind: "lifecycle",
  type: "document.hook-installed",
  payload: { url: "http://127.0.0.1:4600/routes/burst", hookVersion: HOOK_VERSION },
};
const focus = (seq: number) => ({
  kind: "dom",
  type: "focusin",
  seq,
  payload: { target: { tag: "#document" }, isTrusted: true },
});

async function hooked() {
  const captured = await capturing();
  captured.channel.attach("S1", { targetId: "T1", type: "page" });
  captured.channel.context("S1", 3, "T1");
  captured.channel.post("S1", 3, installed);
  return captured;
}

const acks = (channel: FakeChannel) =>
  channel.sent
    .filter(({ method, params }) => method === "Runtime.evaluate" && params?.["contextId"] === 3)
    .map(({ params, sessionId }) => ({ sessionId, expression: params?.["expression"] }));

test("hook messages keep the hook's sequence, a resent duplicate is dropped, and arrivals are acknowledged", async () => {
  const { channel, events } = await hooked();
  channel.post("S1", 3, focus(2));
  channel.post("S1", 3, focus(2));
  expect(events.filter(({ producer }) => producer === PRODUCER).map(({ seq }) => seq)).toEqual([
    1, 2,
  ]);
  await tick(5);
  expect(acks(channel)).toEqual([
    { sessionId: "S1", expression: `globalThis.__recnrunHook?.ack?.("${DOC}", 2)` },
  ]);
});

test("a buffer-exhausted message becomes a gap naming the hook's producer, range, and surface", async () => {
  const { channel, of } = await hooked();
  const payload = { fromSeq: 2, toSeq: 11, lost: 10, kinds: ["dom"] };
  channel.post("S1", 3, { kind: "gap", type: "buffer.exhausted", seq: 12, payload });
  expect(of("gap")).toEqual([
    expect.objectContaining({
      id: `${PRODUCER}#12`,
      producer: PRODUCER,
      seq: 12,
      component: "collector",
      type: "buffer-exhausted",
    }),
  ]);
  expect(of("gap")[0]?.payload).toEqual({
    reason: "buffer-exhausted",
    producer: PRODUCER,
    surface: "dom-events",
    fromSeq: 2,
    toSeq: 11,
    lost: 10,
  });
});

test("a hole no resend filled is a delivery-lost gap once its document's context goes away", async () => {
  const { channel, of } = await hooked();
  channel.post("S1", 3, focus(4));
  channel.emit("Runtime.executionContextDestroyed", { executionContextId: 3 }, "S1");
  expect(of("gap").map(({ producer, payload }) => ({ producer, payload }))).toEqual([
    {
      producer: "cdp:S1",
      payload: { reason: "delivery-lost", producer: PRODUCER, fromSeq: 2, toSeq: 3, lost: 2 },
    },
  ]);
});

test("detaching or stopping closes every document left, once", async () => {
  const { channel, handle, of } = await hooked();
  channel.post("S1", 3, focus(3));
  channel.emit("Target.detachedFromTarget", { sessionId: "S1" });
  handle.stop();
  const ranges = of("gap").map((event) =>
    event.category === "gap" ? [event.payload.fromSeq, event.payload.toSeq] : [],
  );
  expect(ranges).toEqual([[2, 2]]);
});

test("a worker that was already running is a target-unattached gap of workers and frames", async () => {
  const { channel, of } = await capturing();
  channel.attach("W1", { targetId: "W", type: "worker" }, false);
  channel.attach("W2", { targetId: "W2", type: "worker" });
  expect(of("gap").map(({ targetId, payload }) => ({ targetId, payload }))).toEqual([
    { targetId: "W", payload: { reason: "target-unattached", surface: "workers-frames" } },
  ]);
});

test("the hook of every document gets the configured buffer", async () => {
  const channel = new FakeChannel();
  await instrumentChannel(channel, { observerBuffer: 10 });
  channel.attach("S1", { targetId: "T1", type: "page" });
  const script = channel.sent.find(
    ({ method }) => method === "Page.addScriptToEvaluateOnNewDocument",
  );
  expect(String(script?.params?.["source"])).toContain('"buffer":10');
});
