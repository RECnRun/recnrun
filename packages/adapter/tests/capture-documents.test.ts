import { HOOK_VERSION } from "@recnrun/protocol";
import { expect, test } from "vite-plus/test";
import { READ_HOOK_DOCUMENT, withDeadline } from "../src/capture-documents.ts";
import { capturing, type ReplyingChannel } from "./capture-harness.ts";

const BLANK = "0123456789abcdef0123456789abcdef";
const NEXT = "fedcba9876543210fedcba9876543210";
const CHILD = "http://127.0.0.1:4600/routes/popup-child-quiet";

const install = (documentId: string, url: string) => ({
  kind: "lifecycle",
  type: "document.hook-installed",
  documentId,
  payload: { url, hookVersion: HOOK_VERSION },
});

// A popup whose about:blank window, hook included, Chrome hands on to its first document.
async function reusedWindow() {
  const harness = await capturing();
  const { channel } = harness;
  channel.attach("S1", { targetId: "T1", type: "page" });
  channel.context("S1", 1, "T1");
  channel.post("S1", 1, install(BLANK, "about:blank"));
  await harness.handle.settled();
  return harness;
}

function navigateAndLog(channel: ReplyingChannel) {
  channel.emit("Page.frameNavigated", { frame: { id: "T1", url: CHILD } }, "S1");
  channel.emit(
    "Runtime.consoleAPICalled",
    { type: "log", args: [{ type: "string", value: "first" }], executionContextId: 1 },
    "S1",
  );
}

test("a log after a navigation in a reused context waits for the new document's install", async () => {
  const { channel, handle, events, of } = await reusedWindow();
  channel.holding.add("Runtime.evaluate");
  navigateAndLog(channel);
  expect(of("console")).toEqual([]);
  expect(channel.sent).toContainEqual({
    method: "Runtime.evaluate",
    params: { expression: READ_HOOK_DOCUMENT, contextId: 1, returnByValue: true, silent: true },
    sessionId: "S1",
  });
  channel.post("S1", 1, install(NEXT, CHILD));
  expect(events.slice(-2)).toMatchObject([
    { type: "hook-installed", documentId: NEXT },
    { category: "console", documentId: NEXT, payload: { args: ["first"] } },
  ]);
  channel.held[0]?.({ result: { type: "string", value: NEXT } });
  await handle.settled();
  expect(of("console")).toHaveLength(1);
});

test("the read's answer names the new document when no install message comes", async () => {
  const { channel, handle, of } = await reusedWindow();
  channel.replies.set("Runtime.evaluate", { result: { type: "string", value: NEXT } });
  navigateAndLog(channel);
  await handle.settled();
  expect(of("console")).toMatchObject([{ documentId: NEXT }]);
  channel.emit("Runtime.consoleAPICalled", { type: "log", args: [], executionContextId: 1 }, "S1");
  expect(of("console").at(-1)).toMatchObject({ documentId: NEXT });
});

test("stop releases held events without a document instead of the old one", async () => {
  const { channel, handle, of } = await reusedWindow();
  channel.holding.add("Runtime.evaluate");
  navigateAndLog(channel);
  handle.stop();
  expect(of("console")).toMatchObject([{ documentId: null }]);
});

test("a read without a hook, or that fails, releases held events without a document", async () => {
  const { channel, handle, of } = await reusedWindow();
  navigateAndLog(channel);
  await handle.settled();
  channel.failing.set("Runtime.evaluate", "Cannot find context with specified id");
  navigateAndLog(channel);
  await handle.settled();
  expect(of("console").map(({ documentId }) => documentId)).toEqual([null, null]);
});

test("a deadline rejects a reply that never comes and passes one that does", async () => {
  await expect(withDeadline(new Promise(() => undefined), 5)).rejects.toThrow(
    "No answer within 5 ms.",
  );
  await expect(withDeadline(Promise.resolve(1), 5)).resolves.toBe(1);
  await expect(withDeadline(Promise.reject(new Error("gone")), 5)).rejects.toThrow("gone");
});
