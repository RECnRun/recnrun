import { MAX_CAPTURED_TEXT, type DomTarget } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { INSPECT_MODE, startPicker, targetOf } from "../src/index.ts";
import { FakeChannel } from "./fake-channel.ts";

const ENDPOINT = "ws://127.0.0.1:9222/devtools/browser/x";

const button = {
  node: {
    backendNodeId: 42,
    localName: "button",
    attributes: ["class", "primary", "data-testid", "submit", "type", "submit", "name", ""],
  },
};

/** Answers the picker's attach and DOM.describeNode as Chrome does. */
class PageChannel extends FakeChannel {
  override send(method: string, params?: Record<string, unknown>, sessionId?: string) {
    const reply = super.send(method, params, sessionId);
    if (method === "Target.attachToTarget") return reply.then(() => ({ sessionId: "PS" }));
    if (method === "DOM.describeNode")
      return reply.then(() => (params?.["backendNodeId"] === 42 ? button : { node: {} }));
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

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("turns on Chrome's inspect mode on its own session of the page", async () => {
  const { channel } = await pick();
  expect(channel.sent[0]).toEqual({
    method: "Target.attachToTarget",
    params: { targetId: "ROOT", flatten: true },
  });
  expect(channel.methods("PS")).toEqual(["DOM.enable", "Overlay.enable", "Overlay.setInspectMode"]);
  expect(channel.sent.at(-1)?.params).toEqual(INSPECT_MODE);
});

test("reports the node Chrome picked, described by Chrome, on its own session only", async () => {
  const { channel, picked } = await pick();
  channel.emit("Overlay.inspectNodeRequested", { backendNodeId: 42 }, "PS");
  // Another session, a missing node id, and a node that cannot be described are ignored.
  channel.emit("Overlay.inspectNodeRequested", { backendNodeId: 42 }, "OTHER");
  channel.emit("Overlay.inspectNodeRequested", {}, "PS");
  channel.emit("Overlay.inspectNodeRequested", { backendNodeId: 7 }, "PS");
  channel.emit("Overlay.inspectModeCanceled", {}, "PS");
  await settle();
  expect(picked).toEqual([{ tag: "button", testId: "submit", inputType: "submit" }]);
  expect(channel.methods("PS").filter((method) => method === "DOM.describeNode")).toHaveLength(2);
});

test("a failed description reports nothing", async () => {
  const { channel, picked } = await pick();
  channel.failing.set("DOM.describeNode", "No node with given id found");
  channel.emit("Overlay.inspectNodeRequested", { backendNodeId: 42 }, "PS");
  await settle();
  expect(picked).toEqual([]);
});

test("describes an element by the attributes locators use, cut to the captured length", () => {
  const long = "x".repeat(MAX_CAPTURED_TEXT + 10);
  const reply = { node: { localName: "input", attributes: ["id", long, "role", "searchbox"] } };
  expect(targetOf(reply)).toEqual({
    tag: "input",
    id: "x".repeat(MAX_CAPTURED_TEXT),
    role: "searchbox",
  });
  expect(targetOf({ node: { localName: "html" } })).toEqual({ tag: "html" });
  expect(targetOf({ node: { localName: "" } })).toBeUndefined();
  expect(targetOf(undefined)).toBeUndefined();
});

test("stop ends inspect mode and closes the picker's own socket", async () => {
  const { channel, picker } = await pick();
  await picker.stop();
  expect(channel.sent.at(-1)).toMatchObject({
    method: "Overlay.setInspectMode",
    params: { mode: "none" },
    sessionId: "PS",
  });
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
