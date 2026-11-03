import { describe, expect, test } from "vite-plus/test";
import {
  DIAGNOSTICS_KEY,
  installMarker,
  installOriginalFilter,
  isReservedName,
  reservedNameRefusal,
  visibleToOriginal,
} from "../src/index.ts";
import { call, fakeScope } from "./fake-scope.ts";
import { fakeStorage, withLocalStorage } from "./fake-storage.ts";

const REFUSED = (api: string, name: string) =>
  `SecurityError: RECnRun refused ${api}("${name}"): names that start with "__rec:" are reserved`;

function errorOf(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "no error";
}

async function rejectionOf(promise: unknown): Promise<string> {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  return "no error";
}

/** A window-like scope in the original session, with namespaced stores already on the origin. */
function originalScope() {
  const fake = fakeScope({
    databases: ["__rec:m1:fixture-page", "fixture-page", "__rec:m2:other"],
    caches: {
      "__rec:m1:fixture-page": { "/fixture-user": "namespaced" },
      "fixture-page": { "/fixture-user": "original" },
      "__rec:m1:only-there": { "/only-there": "namespaced" },
    },
  });
  const items = fakeStorage({ "__rec:m1:fixture:user": "bob", "fixture:user": "alice" });
  withLocalStorage(fake.scope, items.storage);
  installOriginalFilter(fake.scope);
  return { ...fake, items, localStorage: fake.scope.localStorage as Record<string, unknown> };
}

describe("reserved names", () => {
  test("are the names that start with the reserved prefix", () => {
    expect(["__rec:m1:db", "__rec:", "__rec", "db", "x__rec:"].map(isReservedName)).toEqual([
      true,
      true,
      false,
      false,
      false,
    ]);
  });

  test("are dropped from name lists and from database entries", () => {
    expect(visibleToOriginal(["__rec:m1:a", "a", "b"])).toEqual(["a", "b"]);
    const entries = [
      { name: "__rec:m1:a", version: 1 },
      { name: "a", version: 2 },
    ];
    expect(visibleToOriginal(entries)).toEqual([{ name: "a", version: 2 }]);
    expect(visibleToOriginal(undefined)).toEqual([]);
  });

  test("are refused with a SecurityError that names the call", () => {
    const refusal = reservedNameRefusal("caches.open", "__rec:x");
    expect(refusal).toBeInstanceOf(DOMException);
    expect(`${refusal.name}: ${refusal.message}`).toBe(REFUSED("caches.open", "__rec:x"));
  });
});

describe("installOriginalFilter: indexedDB", () => {
  test("lists only the databases outside the reserved prefix", async () => {
    const { scope } = originalScope();
    expect(await call(scope, "indexedDB", "databases")).toEqual([
      { name: "fixture-page", version: 1 },
    ]);
  });

  test("passes other names through unprefixed and refuses reserved ones before Chrome sees them", () => {
    const { scope, calls } = originalScope();
    call(scope, "indexedDB", "open", "fixture-page", 2);
    call(scope, "indexedDB", "deleteDatabase", "fixture-page");
    expect(errorOf(() => call(scope, "indexedDB", "open", "__rec:x"))).toBe(
      REFUSED("indexedDB.open", "__rec:x"),
    );
    expect(errorOf(() => call(scope, "indexedDB", "deleteDatabase", "__rec:m1:fixture-page"))).toBe(
      REFUSED("indexedDB.deleteDatabase", "__rec:m1:fixture-page"),
    );
    expect(calls).toEqual([
      "indexedDB.open fixture-page 2",
      "indexedDB.deleteDatabase fixture-page",
    ]);
  });
});

describe("installOriginalFilter: caches", () => {
  test("lists only the caches outside the reserved prefix", async () => {
    const { scope } = originalScope();
    expect(await call(scope, "caches", "keys")).toEqual(["fixture-page"]);
  });

  test("rejects open, has, and delete of a reserved name and passes others through", async () => {
    const { scope, calls } = originalScope();
    for (const name of ["open", "has", "delete"]) {
      expect(await rejectionOf(call(scope, "caches", name, "__rec:x"))).toBe(
        REFUSED(`caches.${name}`, "__rec:x"),
      );
    }
    await call(scope, "caches", "has", "fixture-page");
    expect(calls).toEqual(["caches.has fixture-page"]);
  });

  test("match never answers from a namespaced cache", async () => {
    const { scope, calls } = originalScope();
    expect(await call(scope, "caches", "match", "/fixture-user")).toBe("original");
    expect(await call(scope, "caches", "match", "/only-there")).toBeUndefined();
    expect(
      await call(scope, "caches", "match", "/fixture-user", { cacheName: "fixture-page" }),
    ).toBe("original");
    const named = call(scope, "caches", "match", "/only-there", {
      cacheName: "__rec:m1:only-there",
    });
    expect(await rejectionOf(named)).toBe(REFUSED("caches.match", "__rec:m1:only-there"));
    expect(calls.filter((entry) => entry.startsWith("caches.match"))).toEqual([
      "caches.match fixture-page",
    ]);
  });
});

describe("installOriginalFilter: localStorage", () => {
  test("enumeration, length, key(), and JSON hide reserved keys", () => {
    const { localStorage } = originalScope();
    const forIn: string[] = [];
    for (const key in localStorage) if (Object.hasOwn(localStorage, key)) forIn.push(key);
    expect(Object.keys(localStorage)).toEqual(["fixture:user"]);
    expect(forIn).toEqual(["fixture:user"]);
    expect(Reflect.ownKeys(localStorage)).toEqual(["fixture:user"]);
    expect(localStorage.length).toBe(1);
    expect(call(localStorage, "", "key", 0)).toBe("fixture:user");
    expect(call(localStorage, "", "key", 1)).toBeNull();
    expect(JSON.parse(JSON.stringify(localStorage))).toEqual({ "fixture:user": "alice" });
  });

  test("property reads of reserved keys find nothing, other keys read through", () => {
    const { localStorage } = originalScope();
    expect(localStorage["__rec:m1:fixture:user"]).toBeUndefined();
    expect("__rec:m1:fixture:user" in localStorage).toBe(false);
    expect(Object.getOwnPropertyDescriptor(localStorage, "__rec:m1:fixture:user")).toBeUndefined();
    expect(localStorage["fixture:user"]).toBe("alice");
    expect(call(localStorage, "", "getItem", "fixture:user")).toBe("alice");
  });

  test("refuses every write, read, and removal of a reserved key", () => {
    const { localStorage, items } = originalScope();
    for (const name of ["setItem", "getItem", "removeItem"]) {
      expect(errorOf(() => call(localStorage, "", name, "__rec:x", "1"))).toBe(
        REFUSED(`localStorage.${name}`, "__rec:x"),
      );
    }
    expect(errorOf(() => Reflect.set(localStorage, "__rec:x", "1"))).toBe(
      REFUSED("localStorage.setItem", "__rec:x"),
    );
    expect(errorOf(() => Reflect.deleteProperty(localStorage, "__rec:m1:fixture:user"))).toBe(
      REFUSED("localStorage.removeItem", "__rec:m1:fixture:user"),
    );
    const define = () => Reflect.defineProperty(localStorage, "__rec:x", { value: "1" });
    expect(errorOf(define)).toBe(REFUSED("localStorage.setItem", "__rec:x"));
    expect(items.physicalKeys()).toEqual(["__rec:m1:fixture:user", "fixture:user"]);
  });

  test("writes and removals of other keys reach the storage", () => {
    const { localStorage, items } = originalScope();
    call(localStorage, "", "setItem", "a", 1);
    localStorage.b = "2";
    call(localStorage, "", "removeItem", "fixture:user");
    expect(Reflect.deleteProperty(localStorage, "a")).toBe(true);
    expect(items.physicalKeys()).toEqual(["__rec:m1:fixture:user", "b"]);
  });

  test("clear() removes only the keys the original session sees", () => {
    const { localStorage, items } = originalScope();
    call(localStorage, "", "setItem", "other", "x");
    call(localStorage, "", "clear");
    expect(items.physicalKeys()).toEqual(["__rec:m1:fixture:user"]);
    expect(localStorage.length).toBe(0);
  });

  test("is the same object on every read", () => {
    const { scope } = originalScope();
    expect(scope.localStorage).toBe(scope.localStorage);
  });
});

describe("installOriginalFilter: install", () => {
  test("marks nothing: requests and names keep their original form", async () => {
    const { scope, fetched } = originalScope();
    await call(scope, "", "fetch", "http://api.localhost:4601/me");
    expect(fetched).toEqual([["http://api.localhost:4601/me"]]);
  });

  test("exposes read-only diagnostics and is idempotent", () => {
    const { scope } = fakeScope();
    const first = installOriginalFilter(scope);
    expect(first).toEqual({ original: true, installedAt: expect.any(Number) });
    expect(installOriginalFilter(scope)).toBe(first);
    expect(scope[DIAGNOSTICS_KEY]).toBe(first);
    expect(Reflect.set(scope, DIAGNOSTICS_KEY, {})).toBe(false);
  });

  test("leaves a scope a marker already patched as it is", () => {
    const { scope, calls } = fakeScope();
    const marked = installMarker(scope, { marker: "m1" });
    expect(installOriginalFilter(scope)).toBe(marked);
    call(scope, "indexedDB", "open", "__rec:x");
    expect(calls).toEqual(["indexedDB.open __rec:m1:__rec:x"]);
  });

  test("skips the APIs a scope does not have, such as a worker's localStorage", () => {
    const scope: Record<string, unknown> = { indexedDB: null };
    expect(installOriginalFilter(scope).installedAt).toEqual(expect.any(Number));
    expect(Object.keys(scope)).toEqual(["indexedDB"]);
  });

  test("an origin that refuses localStorage still throws on read, as without the filter", () => {
    const scope: Record<string, unknown> = {};
    Object.defineProperty(scope, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("Access is denied for this document.", "SecurityError");
      },
    });
    installOriginalFilter(scope);
    expect(errorOf(() => scope.localStorage)).toBe(
      "SecurityError: Access is denied for this document.",
    );
  });

  test("a localStorage that is not a Storage, or a fixed one, is left alone", () => {
    const empty: Record<string, unknown> = {};
    withLocalStorage(empty, Object.create(null) as object);
    installOriginalFilter(empty);
    expect(Object.keys(empty.localStorage as object)).toEqual([]);
    const fixed: Record<string, unknown> = {};
    Object.defineProperty(fixed, "localStorage", { value: { getItem: "no" } });
    installOriginalFilter(fixed);
    expect(fixed.localStorage).toEqual({ getItem: "no" });
  });
});
