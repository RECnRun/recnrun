import { HOOK_VERSION, OBSERVER_BINDING, ObserverMessageSchema } from "@recnrun/protocol";
import { runInContext, createContext } from "node:vm";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { hookSource } from "../src/hook-source.ts";

interface Page {
  window: Record<string, unknown>;
  posted: unknown[];
  run: () => void;
  navigate: (url: string) => void;
}

// A minimal main world: the hook only needs window, document, location, performance, and crypto.
function page(url: string, withBinding = true): Page {
  const posted: unknown[] = [];
  const window: Record<string, unknown> = {
    document: {},
    location: { href: url },
    performance,
    crypto,
  };
  window.window = window;
  if (withBinding) window[OBSERVER_BINDING] = (message: string) => posted.push(JSON.parse(message));
  const context = createContext(window);
  return {
    window: context,
    posted,
    run: () => runInContext(hookSource("T1"), context),
    navigate: (next) => {
      context.document = {};
      context.location = { href: next };
    },
  };
}

const hookOf = (target: Page) =>
  runInContext("window.__recnrunHook", target.window) as {
    version: number;
    documentId: string;
    installedAt: number;
  };

test("posts a valid install message through the binding and exposes the frozen hook", () => {
  const target = page("http://127.0.0.1:4600/routes/form");
  target.run();
  const hook = hookOf(target);
  expect(hook).toMatchObject({
    version: HOOK_VERSION,
    documentId: expect.stringMatching(/^[0-9a-f]{32}$/),
  });
  expect(Object.isFrozen(hook)).toBe(true);
  expect(target.posted).toEqual([
    {
      kind: "lifecycle",
      type: "document.hook-installed",
      seq: 1,
      documentId: hook.documentId,
      ts: expect.any(Number),
      targetId: "T1",
      payload: { url: "http://127.0.0.1:4600/routes/form", hookVersion: HOOK_VERSION },
    },
  ]);
  expect(v.is(ObserverMessageSchema, target.posted[0])).toBe(true);
});

test("runs once per window", () => {
  const target = page("http://127.0.0.1:4600/");
  target.run();
  target.run();
  expect(target.posted).toHaveLength(1);
});

test("queues messages until Runtime.addBinding assigns the binding", () => {
  const target = page("http://127.0.0.1:4600/", false);
  target.run();
  const received: string[] = [];
  runInContext(`window["${OBSERVER_BINDING}"] = 1;`, target.window);
  target.window.receive = (message: string) => received.push(message);
  runInContext(`window["${OBSERVER_BINDING}"] = (message) => receive(message);`, target.window);
  expect(received.map((message) => JSON.parse(message).type)).toEqual(["document.hook-installed"]);
  expect(runInContext(`typeof window["${OBSERVER_BINDING}"]`, target.window)).toBe("function");
});

test("a new document in a reused window gets its own identity when the hook is read", () => {
  const target = page("about:blank");
  target.run();
  const first = hookOf(target).documentId;
  expect(hookOf(target).documentId, "the same document keeps its id").toBe(first);
  target.navigate("http://127.0.0.1:4600/routes/popup-child");
  const second = hookOf(target).documentId;
  expect(second).not.toBe(first);
  expect(target.posted).toMatchObject([
    { seq: 1, documentId: first, payload: { url: "about:blank" } },
    { seq: 1, documentId: second, payload: { url: "http://127.0.0.1:4600/routes/popup-child" } },
  ]);
});
