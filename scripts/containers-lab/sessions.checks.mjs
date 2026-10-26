// Unit checks for the single-tab session manager's pure rules: container names per generation and
// which identity a paused request gets.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decide, setPhaseSource } from "./extension/documents.js";
import { containerIdOf } from "./extension/sessions.js";

await test("the first generation keeps the id; a reset appends the generation", () => {
  assert.equal(containerIdOf("A", 1), "a");
  assert.equal(containerIdOf("A", 2), "a.2");
  assert.equal(containerIdOf("b", 3), "b.3");
});

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
