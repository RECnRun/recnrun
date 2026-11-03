import { afterEach, describe, expect, test, vi } from "vite-plus/test";
import {
  clearLikeAPage,
  listStores,
  seedStorage,
  tryReservedNames,
} from "@/background/original/page";
import { OriginalProbe } from "@/background/original/probe";
import type { Injection, InjectionApi } from "@/background/original/probe";

const REFUSAL = "SecurityError: refused";

function fakeInjection(result: unknown = "done") {
  const injected: Injection[] = [];
  const api: InjectionApi = {
    async executeScript(injection) {
      injected.push(injection);
      return [{ result }];
    },
  };
  return { api, injected };
}

function refuse(): never {
  throw new DOMException("refused", "SecurityError");
}

/** A request that settles on its next turn, as IndexedDB's do. */
function settledRequest(): IDBOpenDBRequest {
  const request = {} as IDBOpenDBRequest;
  setTimeout(() => request.onsuccess?.(new Event("success")));
  return request;
}

/** Items are own properties and methods sit on the prototype, as in a real Storage. */
class FakeStorage {
  readonly #guard: (name: string) => void;

  constructor(guard: (name: string) => void, items: Record<string, string>) {
    this.#guard = guard;
    Object.assign(this, items);
  }

  get length(): number {
    return Object.keys(this).length;
  }

  key(index: number): string | null {
    return Object.keys(this)[index] ?? null;
  }

  getItem(key: string): string | null {
    this.#guard(key);
    return Object.hasOwn(this, key) ? String(Reflect.get(this, key)) : null;
  }

  setItem(key: string, value: string): void {
    this.#guard(key);
    Reflect.set(this, key, value);
  }

  removeItem(key: string): void {
    this.#guard(key);
    Reflect.deleteProperty(this, key);
  }

  clear(): void {
    for (const key of Object.keys(this)) Reflect.deleteProperty(this, key);
  }
}

/** Page globals with one store of each kind; names in `refused` throw like the filter does. */
function stubPage(refused: string[] = []) {
  const databases = new Set(["fixture-page"]);
  const caches = new Set(["fixture-page"]);
  const guard = (name: string) => (refused.includes(name) ? refuse() : undefined);
  vi.stubGlobal("indexedDB", {
    databases: async () => [...databases].map((name) => ({ name, version: 1 })),
    open: (name: string) => (guard(name), databases.add(name), settledRequest()),
    deleteDatabase: (name: string) => (guard(name), databases.delete(name), settledRequest()),
  });
  vi.stubGlobal("caches", {
    keys: async () => [...caches],
    open: async (name: string) => (guard(name), caches.add(name)),
    has: async (name: string) => (guard(name), caches.has(name)),
    delete: async (name: string) => (guard(name), caches.delete(name)),
    match: async (_: string, options: { cacheName: string }) => guard(options.cacheName),
  });
  const storage = new FakeStorage(guard, { "fixture:user": "alice" });
  vi.stubGlobal("localStorage", storage);
  return { databases, caches, storage };
}

describe("original-session page probes", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("listStores reports every enumeration a page can make, with the diagnostics", async () => {
    stubPage();
    vi.stubGlobal("__recnrun", { original: true });
    expect(await listStores()).toEqual({
      diagnostics: { original: true },
      databases: ["fixture-page"],
      caches: ["fixture-page"],
      localStorage: {
        keys: ["fixture:user"],
        forIn: ["fixture:user"],
        byIndex: ["fixture:user"],
        length: 1,
        json: '{"fixture:user":"alice"}',
      },
    });
  });

  test("tryReservedNames records each API's refusal, or that it was allowed", async () => {
    stubPage(["__rec:x"]);
    const outcomes = await tryReservedNames("__rec:x");
    expect(Object.keys(outcomes)).toEqual([
      "indexedDB.open",
      "indexedDB.deleteDatabase",
      "caches.open",
      "caches.has",
      "caches.delete",
      "caches.match",
      "localStorage.setItem",
      "localStorage.getItem",
      "localStorage.removeItem",
    ]);
    expect(new Set(Object.values(outcomes))).toEqual(new Set([REFUSAL]));
    stubPage();
    expect(new Set(Object.values(await tryReservedNames("__rec:x")))).toEqual(new Set(["allowed"]));
  });

  test("clearLikeAPage deletes every store the page can list, then clears localStorage", async () => {
    const page = stubPage();
    page.databases.add("second");
    expect(await clearLikeAPage()).toEqual({
      databases: ["fixture-page", "second"],
      caches: ["fixture-page"],
    });
    expect([page.databases.size, page.caches.size, page.storage.length]).toEqual([0, 0, 0]);
  });

  test("seedStorage sets one localStorage item and reads it back", () => {
    const page = stubPage();
    expect(seedStorage("__rec:slot-0:fixture:user", "seeded")).toBe("seeded");
    expect(page.storage.getItem("__rec:slot-0:fixture:user")).toBe("seeded");
  });
});

describe("original-session probe", () => {
  test("probe runs each step's page function in the page's own world and returns its result", async () => {
    const { api, injected } = fakeInjection({ listed: true });
    const probe = new OriginalProbe(() => api);
    expect(await probe.probe({ tabId: 7, step: "list" })).toEqual({ listed: true });
    await probe.probe({ tabId: 7, step: "refuse", name: "__rec:x" });
    await probe.probe({ tabId: 7, step: "clear" });
    expect(injected).toEqual([
      { target: { tabId: 7 }, world: "MAIN", func: listStores, args: [] },
      { target: { tabId: 7 }, world: "MAIN", func: tryReservedNames, args: ["__rec:x"] },
      { target: { tabId: 7 }, world: "MAIN", func: clearLikeAPage, args: [] },
    ]);
  });

  test("seed writes from the isolated world, which no page patch reaches", async () => {
    const { api, injected } = fakeInjection("v");
    const probe = new OriginalProbe(() => api);
    expect(await probe.seed({ tabId: 3, key: "__rec:slot-0:k", value: "v" })).toBe("v");
    expect(injected).toEqual([
      { target: { tabId: 3 }, world: "ISOLATED", func: seedStorage, args: ["__rec:slot-0:k", "v"] },
    ]);
  });

  test.each<[string, unknown]>([
    ["no tab", { step: "list" }],
    ["a negative tab id", { tabId: -1, step: "list" }],
    ["an unknown step", { tabId: 1, step: "eval" }],
    ["a refuse step without a name", { tabId: 1, step: "refuse" }],
    ["a code string instead of a step", "listStores()"],
  ])("probe refuses %s before any injection", async (_, request) => {
    const { api, injected } = fakeInjection();
    await expect(new OriginalProbe(() => api).probe(request)).rejects.toThrow();
    expect(injected).toEqual([]);
  });

  test("seed refuses a value that is not a string before any injection", async () => {
    const { api, injected } = fakeInjection();
    const request = { tabId: 1, key: "k", value: { toString: "x" } };
    await expect(new OriginalProbe(() => api).seed(request)).rejects.toThrow();
    expect(injected).toEqual([]);
  });

  test("a result Chrome did not return is reported, not guessed", async () => {
    const api: InjectionApi = { executeScript: async () => [] };
    await expect(new OriginalProbe(() => api).probe({ tabId: 1, step: "list" })).rejects.toThrow(
      "no result from tab 1",
    );
  });
});
