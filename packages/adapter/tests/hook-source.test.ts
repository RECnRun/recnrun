import {
  HOOK_VERSION,
  MAX_CAPTURED_TEXT,
  OBSERVER_BINDING,
  ObserverMessageSchema,
} from "@recnrun/protocol";
import { runInContext, createContext } from "node:vm";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { hookSource } from "../src/hook-source.ts";

type Listener = (event: Record<string, unknown>) => void;

interface Page {
  window: Record<string, unknown>;
  posted: unknown[];
  run: () => void;
  navigate: (url: string) => void;
  /** Dispatches a fake event to the hook's capture-phase listener for its type. */
  dispatch: (event: Record<string, unknown>) => void;
}

// A minimal main world: window, document, location, performance, crypto, timers, and listeners.
function page(url: string, withBinding = true): Page {
  const posted: unknown[] = [];
  const listeners = new Map<string, Listener>();
  const window: Record<string, unknown> = {
    document: {},
    location: { href: url },
    performance,
    crypto,
    setTimeout,
    clearTimeout,
    scrollX: 0,
    scrollY: 0,
    getSelection: () => "",
    addEventListener: (type: string, listener: Listener, options: unknown) => {
      expect(options).toEqual({ capture: true, passive: true });
      listeners.set(type, listener);
    },
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
    dispatch: (event) => listeners.get(String(event.type))?.(event),
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

// A fake element: attributes by name, plus whatever properties the event reads.
const element = (attributes: Record<string, string>, properties: Record<string, unknown> = {}) => ({
  nodeType: 1,
  localName: "input",
  getAttribute: (name: string) => attributes[name] ?? null,
  ...properties,
});

const domOf = (target: Page) =>
  target.posted.filter((message) => (message as { kind: string }).kind === "dom");

test("DOM events are posted with their target, details, and the document's sequence", () => {
  const target = page("http://127.0.0.1:4600/routes/form");
  target.run();
  const name = element({ "data-testid": "name", name: "name", id: "n" }, { value: "Ada" });
  target.dispatch({
    type: "click",
    target: name,
    isTrusted: true,
    clientX: 10.4,
    clientY: 20.6,
    button: 0,
    detail: 1,
    pointerType: "mouse",
    shiftKey: true,
  });
  target.dispatch({ type: "keydown", target: name, isTrusted: true, key: "a", code: "KeyA" });
  target.dispatch({
    type: "input",
    target: name,
    isTrusted: false,
    inputType: "insertText",
    data: "a",
  });
  target.dispatch({
    type: "input",
    target: name,
    isTrusted: true,
    inputType: "deleteContentBackward",
    data: null,
  });
  target.dispatch({ type: "submit", target: { nodeType: 9 }, isTrusted: true });
  target.dispatch({ type: "focusin", target: undefined, isTrusted: true });
  const posted = domOf(target);
  expect(posted).toMatchObject([
    {
      type: "click",
      seq: 2,
      payload: {
        target: { tag: "input", testId: "name", name: "name", id: "n" },
        isTrusted: true,
        x: 10,
        y: 21,
        button: 0,
        detail: 1,
        pointerType: "mouse",
        modifiers: ["shift"],
      },
    },
    { type: "keydown", payload: { key: "a", code: "KeyA", modifiers: [] } },
    {
      type: "input",
      payload: { isTrusted: false, inputType: "insertText", data: "a", value: "Ada" },
    },
    { type: "input", payload: { data: null } },
    { type: "submit", payload: { target: { tag: "#document" } } },
    { type: "focusin", payload: { target: { tag: "#window" } } },
  ]);
  for (const message of posted)
    expect(v.is(ObserverMessageSchema, message), JSON.stringify(message)).toBe(true);
});

test("password fields report neither keys, data, nor values", () => {
  const target = page("http://127.0.0.1:4600/");
  target.run();
  const secret = element({ type: "password" }, { type: "password", value: "hunter2" });
  target.dispatch({ type: "keyup", target: secret, isTrusted: true, key: "2", code: "Digit2" });
  target.dispatch({
    type: "input",
    target: secret,
    isTrusted: true,
    inputType: "insertText",
    data: "2",
  });
  target.dispatch({ type: "change", target: secret, isTrusted: true });
  const payloads = domOf(target).map((message) => (message as { payload: object }).payload);
  expect(payloads).toEqual([
    {
      target: { tag: "input", inputType: "password" },
      isTrusted: true,
      redacted: true,
      modifiers: [],
    },
    {
      target: { tag: "input", inputType: "password" },
      isTrusted: true,
      inputType: "insertText",
      redacted: true,
    },
    { target: { tag: "input", inputType: "password" }, isTrusted: true, redacted: true },
  ]);
  expect(JSON.stringify(target.posted)).not.toContain("hunter2");
});

test("no text-bearing event of a password field discloses its text", () => {
  const target = page("http://127.0.0.1:4600/");
  target.run();
  const secret = element(
    { type: "password" },
    { type: "password", value: "hunter2", selectionStart: 0, selectionEnd: 7 },
  );
  const text = { key: "hunter2", code: "hunter2", data: "hunter2" };
  for (const type of ["keydown", "keyup", "input", "change"])
    target.dispatch({ type, target: secret, isTrusted: true, ...text });
  for (const type of ["compositionstart", "compositionupdate", "compositionend"])
    target.dispatch({ type, target: secret, isTrusted: true, ...text });
  target.window.document = { activeElement: secret };
  target.window.getSelection = () => "hunter2";
  target.dispatch({ type: "selectionchange", target: { nodeType: 9 }, isTrusted: true });
  const posted = domOf(target) as { type: string; payload: Record<string, unknown> }[];
  expect(posted.map((message) => message.type)).toEqual([
    "keydown",
    "keyup",
    "input",
    "change",
    "compositionstart",
    "compositionupdate",
    "compositionend",
    "selectionchange",
  ]);
  for (const message of posted.slice(0, 7))
    expect(message.payload, message.type).toMatchObject({ redacted: true });
  expect(JSON.stringify(target.posted)).not.toContain("hunter2");
  for (const message of posted) expect(v.is(ObserverMessageSchema, message)).toBe(true);
});

test("checkboxes report checked, selections their range, and long text is clipped", () => {
  const target = page("http://127.0.0.1:4600/");
  target.run();
  const box = element({ type: "checkbox" }, { type: "checkbox", checked: true, value: "on" });
  target.dispatch({ type: "change", target: box, isTrusted: true });
  const field = element(
    {},
    { value: "x".repeat(MAX_CAPTURED_TEXT + 5), selectionStart: 1, selectionEnd: 3 },
  );
  target.dispatch({ type: "change", target: field, isTrusted: true });
  target.window.document = { activeElement: field };
  target.dispatch({ type: "selectionchange", target: { nodeType: 9 }, isTrusted: true });
  target.window.document = { activeElement: null };
  target.window.getSelection = () => "abc";
  target.dispatch({ type: "selectionchange", target: { nodeType: 9 }, isTrusted: true });
  target.dispatch({ type: "compositionend", target: field, isTrusted: true, data: "日本" });
  expect(domOf(target)).toMatchObject([
    { payload: { checked: true, value: "on" } },
    { payload: { value: "x".repeat(MAX_CAPTURED_TEXT) } },
    { payload: { selectionStart: 1, selectionEnd: 3 } },
    { payload: { selectedLength: 3 } },
    { type: "compositionend", payload: { data: "日本" } },
  ]);
});

test("scrolls are debounced per node and report the final position", async () => {
  const target = page("http://127.0.0.1:4600/");
  target.run();
  const list = element({ "data-testid": "list" }, { scrollLeft: 0, scrollTop: 100 });
  target.dispatch({ type: "scroll", target: list, isTrusted: true });
  (list as Record<string, unknown>).scrollTop = 400.4;
  target.dispatch({ type: "scroll", target: list, isTrusted: true });
  target.window.scrollY = 50;
  target.dispatch({ type: "scroll", target: { nodeType: 9 }, isTrusted: true });
  expect(domOf(target)).toEqual([]);
  await new Promise((resolve) => setTimeout(resolve, 150));
  expect(domOf(target)).toMatchObject([
    { type: "scroll", payload: { target: { testId: "list" }, scrollX: 0, scrollY: 400 } },
    { type: "scroll", payload: { target: { tag: "#document" }, scrollX: 0, scrollY: 50 } },
  ]);
});

test("a failing listener never throws into the page, and a reused window starts a new document", () => {
  const target = page("about:blank");
  target.run();
  const broken = {
    nodeType: 1,
    localName: "div",
    getAttribute: () => {
      throw new Error("patched");
    },
  };
  expect(() => target.dispatch({ type: "click", target: broken, isTrusted: true })).not.toThrow();
  target.navigate("http://127.0.0.1:4600/routes/popup-child");
  target.dispatch({ type: "focusin", target: { nodeType: 9 }, isTrusted: true });
  expect(target.posted.map((message) => (message as { type: string; seq: number }).type)).toEqual([
    "document.hook-installed",
    "document.hook-installed",
    "focusin",
  ]);
  expect(target.posted.at(-1)).toMatchObject({ seq: 2 });
});
