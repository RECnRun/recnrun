import { RECORDER_OVERLAY_PREFIX, type DomTarget } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { PICKER_BINDING, PICKER_WORLD, pickerSource, startPicker } from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/x";

/** Answers the picker's attach and isolated world as Chrome does. */
class PageChannel extends FakeChannel {
  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const reply = super.send(method, params, sessionId);
    if (method === "Target.attachToTarget") return reply.then(() => ({ sessionId: "PS" }));
    if (method === "Page.createIsolatedWorld") return reply.then(() => ({ executionContextId: 7 }));
    return reply;
  }
}

async function pick() {
  const channel = new PageChannel();
  const picked: DomTarget[] = [];
  const picker = await startPicker(ENDPOINT, "ROOT", {
    openChannel: async () => channel,
    onPicked: (target) => picked.push(target),
  });
  return { channel, picked, picker };
}

const called = (channel: FakeChannel, params: Record<string, unknown>, sessionId = "PS") =>
  channel.emit(
    "Runtime.bindingCalled",
    { name: PICKER_BINDING, executionContextId: 7, ...params },
    sessionId,
  );

test("draws the overlay in an isolated world of the page's main frame", async () => {
  const { channel } = await pick();
  expect(channel.sent.map(({ method }) => method)).toEqual([
    "Target.attachToTarget",
    "Runtime.enable",
    "Runtime.addBinding",
    "Page.createIsolatedWorld",
    "Runtime.evaluate",
  ]);
  expect(channel.sent[0]?.params).toEqual({ targetId: "ROOT", flatten: true });
  expect(channel.sent[2]?.params).toEqual({
    name: PICKER_BINDING,
    executionContextName: PICKER_WORLD,
  });
  expect(channel.sent[3]?.params).toEqual({ frameId: "ROOT", worldName: PICKER_WORLD });
  expect(channel.sent[4]).toMatchObject({ params: { contextId: 7 }, sessionId: "PS" });
});

test("reports a picked element from its own world only", async () => {
  const { channel, picked } = await pick();
  called(channel, { payload: JSON.stringify({ tag: "button", testId: "submit" }) });
  // The main world, another session, an invalid shape, and text that is not JSON are ignored.
  called(channel, { payload: JSON.stringify({ tag: "a" }), executionContextId: 1 });
  called(channel, { payload: JSON.stringify({ tag: "a" }) }, "OTHER");
  called(channel, { payload: JSON.stringify({ tag: "" }) });
  called(channel, { payload: "{" });
  called(channel, { payload: JSON.stringify({ tag: "a" }), name: "__recnrunObserver" });
  expect(picked).toEqual([{ tag: "button", testId: "submit" }]);
});

test("stop removes the overlay and closes the picker's own socket", async () => {
  const { channel, picker } = await pick();
  await picker.stop();
  expect(channel.sent.at(-1)).toMatchObject({ method: "Runtime.evaluate", sessionId: "PS" });
  expect(channel.closed).toBe(true);
});

test("closes the socket when the page cannot be reached", async () => {
  const channel = new FakeChannel();
  channel.failing.set("Target.attachToTarget", "No target with given id found");
  await expect(
    startPicker(ENDPOINT, "GONE", { openChannel: async () => channel, onPicked: () => undefined }),
  ).rejects.toThrow("No target with given id found");
  expect(channel.closed).toBe(true);
});

test("the overlay elements carry the recorder overlay prefix", () => {
  const source = pickerSource();
  expect(source).toContain(`"prefix":${JSON.stringify(RECORDER_OVERLAY_PREFIX)}`);
  expect(source).toContain('config.prefix + "-picker"');
  expect(source).toContain('config.prefix + "-highlight"');
  expect(source).toContain(PICKER_BINDING);
});
