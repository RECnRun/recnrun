import { describe, expect, test } from "vite-plus/test";
import { DIAGNOSTICS_KEY, installBootstrap } from "../src/index.ts";
import { call, fakeScope } from "./fake-scope.ts";

describe("installBootstrap", () => {
  test("{ marker } installs the marked bootstrap", () => {
    const { scope, calls } = fakeScope();
    expect(installBootstrap(scope, { marker: "m1" })).toMatchObject({ marker: "m1" });
    call(scope, "indexedDB", "open", "fixture-sw");
    expect(calls).toEqual(["indexedDB.open __rec:m1:fixture-sw"]);
  });

  test("{ original: true } installs the original-session filter", async () => {
    const { scope, calls } = fakeScope({ databases: ["__rec:m1:fixture-sw", "fixture-sw"] });
    expect(installBootstrap(scope, { original: true })).toMatchObject({ original: true });
    call(scope, "indexedDB", "open", "fixture-sw");
    expect(calls).toEqual(["indexedDB.open fixture-sw"]);
    expect(await call(scope, "indexedDB", "databases")).toEqual([
      { name: "fixture-sw", version: 1 },
    ]);
  });

  test("a scope either mode patched keeps that mode", () => {
    const original = fakeScope().scope;
    const first = installBootstrap(original, { original: true });
    expect(installBootstrap(original, { marker: "m1" })).toBe(first);
    const marked = fakeScope().scope;
    const second = installBootstrap(marked, { marker: "m1" });
    expect(installBootstrap(marked, { original: true })).toBe(second);
  });

  test("rejects options of neither mode before patching anything", () => {
    for (const options of [{}, { original: false }, { marker: "a:b" }, null]) {
      const { scope } = fakeScope();
      const indexedDB = scope.indexedDB;
      expect(() => installBootstrap(scope, options), JSON.stringify(options)).toThrow();
      expect(DIAGNOSTICS_KEY in scope).toBe(false);
      expect(scope.indexedDB).toBe(indexedDB);
    }
  });
});
