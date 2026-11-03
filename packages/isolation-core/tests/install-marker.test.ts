import { describe, expect, test } from "vite-plus/test";
import { DIAGNOSTICS_KEY, installMarker } from "../src/index.ts";
import { call, fakeScope } from "./fake-scope.ts";

const API = "http://api.localhost:4601";

/** The answer's `patches` for a fake scope that has `fetch`, `indexedDB`, and `caches`. */
function patches(status = "installed") {
  return {
    fetch: { status, typeof: "function" },
    indexedDB: { status, typeof: "object" },
    caches: { status, typeof: "object" },
  };
}

describe("installMarker: fetch", () => {
  test("marks string and URL inputs and passes init through", async () => {
    const { scope, fetched } = fakeScope();
    installMarker(scope, { marker: "m1" });
    const init = { credentials: "include" };
    await call(scope, "", "fetch", `${API}/me?from=%2Fsw-main.js`, init);
    await call(scope, "", "fetch", new URL("/index.js", "http://app.localhost:4600"));
    await call(scope, "", "fetch", "/offline.html");
    expect(fetched).toEqual([
      [`${API}/me?from=%2Fsw-main.js&__rec=m1`, init],
      ["http://app.localhost:4600/index.js?__rec=m1"],
      ["http://app.localhost:4600/offline.html?__rec=m1"],
    ]);
  });

  test("rebuilds a Request with the marked URL and keeps its credentials and method", async () => {
    const { scope, fetched } = fakeScope();
    installMarker(scope, { marker: "m1" });
    const original = new Request(`${API}/me`, { credentials: "include", method: "POST" });
    await call(scope, "", "fetch", original);
    const sent = fetched[0]?.[0];
    expect(sent).toBeInstanceOf(Request);
    expect(sent).not.toBe(original);
    const request = sent as Request;
    expect([request.url, request.credentials, request.method]).toEqual([
      `${API}/me?__rec=m1`,
      "include",
      "POST",
    ]);
  });

  test("sends a Request it cannot copy unchanged, such as a navigation", async () => {
    class NavigationRequest {
      readonly url = "http://app.localhost:4600/sw.html";
      constructor(...args: unknown[]) {
        if (args.length > 0) throw new TypeError("mode navigate");
      }
    }
    const { scope, fetched } = fakeScope({ Request: NavigationRequest });
    installMarker(scope, { marker: "m1" });
    const navigation = Reflect.construct(NavigationRequest, []) as NavigationRequest;
    await call(scope, "", "fetch", navigation);
    expect(fetched[0]?.[0]).toBe(navigation);
  });

  test("leaves other inputs and non-http URLs alone", async () => {
    const { scope, fetched } = fakeScope();
    installMarker(scope, { marker: "m1" });
    await call(scope, "", "fetch", "data:text/plain,hi");
    await call(scope, "", "fetch", 42);
    expect(fetched).toEqual([["data:text/plain,hi"], [42]]);
  });
});

describe("installMarker: indexedDB", () => {
  test("prefixes open and deleteDatabase names and keeps the version argument", () => {
    const { scope, calls } = fakeScope();
    installMarker(scope, { marker: "m1" });
    call(scope, "indexedDB", "open", "fixture-sw");
    call(scope, "indexedDB", "open", "fixture-sw", 3);
    call(scope, "indexedDB", "deleteDatabase", "fixture-sw");
    expect(calls).toEqual([
      "indexedDB.open __rec:m1:fixture-sw",
      "indexedDB.open __rec:m1:fixture-sw 3",
      "indexedDB.deleteDatabase __rec:m1:fixture-sw",
    ]);
  });

  test("lists only its own databases, under their logical names", async () => {
    const databases = ["__rec:m1:fixture-sw", "__rec:m2:fixture-sw", "plain"];
    const { scope } = fakeScope({ databases });
    installMarker(scope, { marker: "m1" });
    expect(await call(scope, "indexedDB", "databases")).toEqual([
      { name: "fixture-sw", version: 1 },
    ]);
  });
});

describe("installMarker: caches", () => {
  test("prefixes open, has, and delete names and lists only its own caches", async () => {
    const caches = { "__rec:m1:fixture-shell-v1": {}, "__rec:m2:other": {}, plain: {} };
    const { scope, calls } = fakeScope({ caches });
    installMarker(scope, { marker: "m1" });
    await call(scope, "caches", "open", "fixture-sw");
    await call(scope, "caches", "has", "fixture-sw");
    await call(scope, "caches", "delete", "fixture-sw");
    expect(calls).toEqual([
      "caches.open __rec:m1:fixture-sw",
      "caches.has __rec:m1:fixture-sw",
      "caches.delete __rec:m1:fixture-sw",
    ]);
    expect(await call(scope, "caches", "keys")).toEqual(["fixture-shell-v1"]);
  });

  test("match searches only its own caches, or the named one under its physical name", async () => {
    const caches = {
      plain: { "/index.html": "foreign" },
      "__rec:m2:shell": { "/index.html": "other marker" },
      "__rec:m1:shell": { "/index.html": "own" },
    };
    const { scope, calls } = fakeScope({ caches });
    installMarker(scope, { marker: "m1" });
    expect(await call(scope, "caches", "match", "/index.html")).toBe("own");
    expect(await call(scope, "caches", "match", "/missing")).toBeUndefined();
    expect(await call(scope, "caches", "match", "/index.html", { cacheName: "shell" })).toBe("own");
    expect(calls.filter((entry) => entry.startsWith("caches.match"))).toEqual([
      "caches.match __rec:m1:shell",
    ]);
  });
});

describe("installMarker: install", () => {
  test("exposes read-only diagnostics and is idempotent", async () => {
    const { scope, fetched } = fakeScope();
    const first = installMarker(scope, { marker: "m1" });
    const second = installMarker(scope, { marker: "m2" });
    expect(second).toEqual({ ...first, patches: patches("already-installed") });
    expect(scope[DIAGNOSTICS_KEY]).toEqual(first);
    expect(Reflect.set(scope, DIAGNOSTICS_KEY, {})).toBe(false);
    await call(scope, "", "fetch", `${API}/me`);
    expect(fetched).toEqual([[`${API}/me?__rec=m1`]]);
  });

  test("answers, per patch, that it installed and the typeof it saw", () => {
    const { scope } = fakeScope();
    const answer = installMarker(scope, { marker: "m1" });
    expect(answer).toEqual({ marker: "m1", installedAt: answer.installedAt, patches: patches() });
  });

  test("answers a skipped patch when its global is missing, and keeps it skipped on a re-run", async () => {
    const { scope, calls } = fakeScope();
    const storage = scope.caches;
    delete scope.caches;
    const missing = { status: "skipped", typeof: "undefined" };
    expect(installMarker(scope, { marker: "m1" }).patches.caches).toEqual(missing);
    scope.caches = storage;
    const again = installMarker(scope, { marker: "m1" });
    expect(again.patches.caches).toEqual({ status: "skipped", typeof: "object" });
    await call(scope, "caches", "open", "fixture-sw");
    expect(calls, "a re-run patches nothing late").toEqual(["caches.open fixture-sw"]);
  });

  test("answers how long the realm had run when a performance clock exists", () => {
    const { scope } = fakeScope();
    scope.performance = { now: () => 1234.5 };
    expect(installMarker(scope, { marker: "m1" }).realmAgeMs).toBe(1234.5);
    expect("realmAgeMs" in installMarker(fakeScope().scope, { marker: "m1" })).toBe(false);
  });

  test("rejects an invalid marker before patching anything", () => {
    const { scope } = fakeScope();
    const fetch = scope.fetch;
    expect(() => installMarker(scope, { marker: "a:b" })).toThrow();
    expect(scope.fetch).toBe(fetch);
    expect(DIAGNOSTICS_KEY in scope).toBe(false);
  });

  test("skips the APIs a scope does not have", () => {
    const scope: Record<string, unknown> = { indexedDB: null };
    expect(installMarker(scope, { marker: "m1" }).patches).toEqual({
      fetch: { status: "skipped", typeof: "undefined" },
      indexedDB: { status: "skipped", typeof: "object" },
      caches: { status: "skipped", typeof: "undefined" },
    });
    expect(Object.keys(scope)).toEqual(["indexedDB"]);
  });
});
