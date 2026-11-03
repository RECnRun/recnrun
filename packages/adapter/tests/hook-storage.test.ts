import { MAX_CAPTURED_TEXT, ObserverMessageSchema } from "@recnrun/protocol";
import { runInContext } from "node:vm";
import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { page, type Page } from "./hook-world.ts";

// Gives the fake main world a Storage class and, as Chrome does for its [Global] Window, the two
// getters on the global object itself rather than on Window.prototype.
const STORAGE_WORLD = `
  globalThis.Storage = class Storage {
    #items = new Map();
    setItem(key, value) {
      if (String(key) === "full") {
        const error = new Error("quota");
        error.name = "QuotaExceededError";
        throw error;
      }
      this.#items.set(String(key), String(value));
    }
    removeItem(key) { this.#items.delete(String(key)); }
    clear() { this.#items.clear(); }
    getItem(key) { return this.#items.get(String(key)) ?? null; }
  };
  const local = new Storage();
  const session = new Storage();
  Object.defineProperty(globalThis, "localStorage", { get: () => local, configurable: true });
  Object.defineProperty(globalThis, "sessionStorage", { get: () => session, configurable: true });
`;

function storagePage(): Page {
  const target = page("http://127.0.0.1:4600/routes/storage");
  runInContext(STORAGE_WORLD, target.window);
  target.run();
  return target;
}

const operations = (target: Page) =>
  target.posted
    .map((message) => v.parse(ObserverMessageSchema, message))
    .filter((message) => message.kind === "storage")
    .map((message) => message.payload);

test("each Web Storage call posts a valid operation with its area, key, and value", () => {
  const target = storagePage();
  runInContext(
    `localStorage.setItem("theme", "dark");
     localStorage.removeItem("theme");
     sessionStorage.setItem("draft", 42);
     sessionStorage.clear();`,
    target.window,
  );
  expect(operations(target)).toEqual([
    { area: "local", operation: "setItem", key: "theme", value: "dark" },
    { area: "local", operation: "removeItem", key: "theme" },
    { area: "session", operation: "setItem", key: "draft", value: "42" },
    { area: "session", operation: "clear" },
  ]);
  expect(
    runInContext(`[localStorage.getItem("theme"), sessionStorage.getItem("draft")]`, target.window),
  ).toEqual([null, null]);
  expect(runInContext("localStorage.setItem.name", target.window)).toBe("setItem");
});

test("a long value is clipped and flagged, and an object argument is not stringified again", () => {
  const target = storagePage();
  runInContext(
    `localStorage.setItem("long", "v".repeat(${MAX_CAPTURED_TEXT + 5}));
     localStorage.setItem({ toString: () => "made" }, "x");`,
    target.window,
  );
  expect(operations(target)).toEqual([
    {
      area: "local",
      operation: "setItem",
      key: "long",
      value: "v".repeat(MAX_CAPTURED_TEXT),
      truncated: true,
    },
    { area: "local", operation: "setItem", value: "x" },
  ]);
});

test("a call that throws is reported with the error's name and still throws", () => {
  const target = storagePage();
  const thrown = runInContext(
    `try { localStorage.setItem("full", "x"); } catch (error) { error.name }`,
    target.window,
  );
  expect(thrown).toBe("QuotaExceededError");
  expect(operations(target)).toEqual([
    { area: "local", operation: "setItem", key: "full", value: "x", error: "QuotaExceededError" },
  ]);
});

test("a Storage object that is neither area is not reported", () => {
  const target = storagePage();
  runInContext(`new Storage().setItem("other", "x")`, target.window);
  expect(operations(target)).toEqual([]);
});
