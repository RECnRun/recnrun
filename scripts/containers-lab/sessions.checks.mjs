// Unit checks for the single-tab session manager's pure rules: container names per generation and
// which identity a paused request gets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, setPhaseSource, startDocuments } from "./extension/documents.js";
import { containerIdOf } from "./extension/sessions.js";

await test("the first generation keeps the id; a reset appends the generation", () => {
  assert.equal(containerIdOf("A", 1), "a");
  assert.equal(containerIdOf("A", 2), "a.2");
  assert.equal(containerIdOf("b", 3), "b.3");
});

const listeners = {};
const listener = (name) => ({ addListener: (fn) => (listeners[name] = fn) });
globalThis.chrome = {
  debugger: { onEvent: listener("debugger.onEvent") },
  webNavigation: {
    onCommitted: listener("onCommitted"),
    onErrorOccurred: listener("onErrorOccurred"),
  },
  tabs: { onRemoved: listener("onRemoved") },
};
startDocuments();

const main = { tabId: 7 };
const child = { tabId: 7, sessionId: "s1" };
const state = { container: "x" };
const paused = (resourceType, networkId) => ({ resourceType, networkId, request: {} });

await test("an unmanaged tab keeps its container", async () => {
  setPhaseSource(() => ({ managed: false, container: null }));
  assert.deepEqual(await decide(main, state, paused("XHR", "n1")), { container: "x" });
});

await test("a navigation while switching is blocked; while active it gets the active container", async () => {
  setPhaseSource(() => ({ managed: true, container: null }));
  assert.deepEqual(await decide(main, state, paused("Document", "n2")), {
    block: "navigation-while-switching",
  });
  setPhaseSource(() => ({ managed: true, container: "a" }));
  assert.deepEqual(await decide(main, state, paused("Document", "n3")), { container: "a" });
});

await test("a child session uses the container it was bound to, or is blocked", async () => {
  setPhaseSource(() => ({ managed: true, container: "a" }));
  assert.deepEqual(await decide(child, { ...state, childContainer: "b" }, paused("XHR", "n4")), {
    container: "b",
  });
  assert.deepEqual(await decide(child, state, paused("XHR", "n5")), {
    block: "child-of-unknown-document",
  });
});

await test("a subresource of an unknown document is blocked after the wait", async () => {
  setPhaseSource(() => ({ managed: true, container: "a" }));
  const started = Date.now();
  assert.deepEqual(await decide(main, state, paused("XHR", "never-sent")), {
    block: "unknown-document",
  });
  assert.ok(Date.now() - started >= 150);
});

await test("a request Chrome never announced belongs to its frame's current document", async () => {
  setPhaseSource(() => ({ managed: true, container: "a" }));
  listeners["debugger.onEvent"](main, "Page.frameNavigated", {
    frame: { id: "F1", loaderId: "L1", url: "http://app.localhost/home" },
  });
  const inFrame = { ...paused("Script", "never-sent-2"), frameId: "F1" };
  assert.deepEqual(await decide(main, state, inFrame), { container: "a" });
  // Only the frame's own document counts: a frame that never navigated is still unknown.
  const elsewhere = { ...paused("Script", "never-sent-3"), frameId: "F2" };
  assert.deepEqual(await decide(main, state, elsewhere), { block: "unknown-document" });
});

await test("a CORS preflight, announced with an empty loader, belongs to its frame's document", async () => {
  setPhaseSource(() => ({ managed: true, container: "a" }));
  listeners["debugger.onEvent"](main, "Page.frameNavigated", {
    frame: { id: "F3", loaderId: "L3", url: "http://app.localhost/home" },
  });
  listeners["debugger.onEvent"](main, "Network.requestWillBeSent", {
    requestId: "preflight-1",
    loaderId: "",
    type: "Preflight",
    request: { url: "http://idp.localhost/account" },
  });
  const preflight = { ...paused("Preflight", "preflight-1"), frameId: "F3" };
  assert.deepEqual(await decide(main, state, preflight), { container: "a" });
});
