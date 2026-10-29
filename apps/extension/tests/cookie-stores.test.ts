import type { SiteCookie } from "@recnrun/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  chromeCookieApi,
  noteIncognitoStores,
  resolveTabStore,
  restoreCookies,
  trackIncognitoStores,
  waitForIncognitoGone,
} from "@/background/workspace/cookie-stores";
import { fakeCookieApi, memoryStoreMemory } from "./fake-cookies";

const NORMAL = { id: "0", tabIds: [1, 2] };
const ORIGIN = "http://app.localhost:5192";
const session: SiteCookie = {
  name: "sid",
  value: "abc",
  path: "/",
  secure: false,
  httpOnly: true,
  sameSite: "strict",
};

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("waitForIncognitoGone", () => {
  test("asks again until no listed store is Incognito, and counts the checks", async () => {
    const closing = { id: "1", tabIds: [] };
    const api = fakeCookieApi([[NORMAL, closing], [NORMAL, closing], [NORMAL]], [1, 2]);
    await expect(waitForIncognitoGone(api, memoryStoreMemory())).resolves.toBe(3);
  });

  test("returns at once when only the normal store is listed and no known store lives", async () => {
    const api = fakeCookieApi([[NORMAL]], [1, 2]);
    await expect(waitForIncognitoGone(api, memoryStoreMemory(["1"]))).resolves.toBe(1);
    expect(api.probes).toEqual(["1"]);
  });

  test("waits until Chrome no longer knows a remembered store, not only until it is unlisted", async () => {
    // Chrome lists a store only while it has a tab (cookies_api.cc:895-904), but destroys the
    // Incognito profile later (profile_destroyer.cc:340-343, 395-411).
    const api = fakeCookieApi([[NORMAL]], [1, 2]);
    api.alive.set("1", [true, true, false]);
    await expect(waitForIncognitoGone(api, memoryStoreMemory(["1"]))).resolves.toBe(3);
    expect(api.probes).toEqual(["1", "1", "1"]);
  });

  test("remembers an Incognito store it sees listed, then waits for Chrome to forget it", async () => {
    const api = fakeCookieApi([[NORMAL, { id: "1", tabIds: [9] }], [NORMAL]], [1, 2], [9]);
    api.alive.set("1", [true, false]);
    const memory = memoryStoreMemory();
    await expect(waitForIncognitoGone(api, memory)).resolves.toBe(3);
    expect(memory.ids).toEqual(["1"]);
  });

  test("fails explicitly when an Incognito store outlives the bound, listed or not", async () => {
    const listed = fakeCookieApi([[NORMAL, { id: "1", tabIds: [] }]], [1, 2]);
    await expect(waitForIncognitoGone(listed, memoryStoreMemory(), 0)).rejects.toMatchObject({
      name: "IncognitoNotGone",
    });
    const unlisted = fakeCookieApi([[NORMAL]], [1, 2]);
    unlisted.alive.set("1", [true]);
    await expect(waitForIncognitoGone(unlisted, memoryStoreMemory(["1"]), 0)).rejects.toMatchObject(
      { name: "IncognitoNotGone" },
    );
  });
});

describe("noteIncognitoStores", () => {
  test("remembers only stores whose every tab is a known Incognito tab", async () => {
    const stores = [NORMAL, { id: "1", tabIds: [9, 10] }, { id: "7", tabIds: [9, 11] }];
    const api = fakeCookieApi([stores], [1, 2], [9, 10]);
    const memory = memoryStoreMemory();
    // Tab 11 closed between the two reads: its store is not proven Incognito, so it is not kept.
    await expect(noteIncognitoStores(api, memory)).resolves.toEqual(["1"]);
    expect(memory.ids).toEqual(["1"]);
  });
});

describe("resolveTabStore", () => {
  test("names the store whose tabs include the managed tab", async () => {
    const api = fakeCookieApi([[NORMAL, { id: "1", tabIds: [9] }]], [1, 2]);
    await expect(resolveTabStore(api, 9)).resolves.toBe("1");
  });

  test("refuses when no store lists the tab, never falling back to another store", async () => {
    const api = fakeCookieApi([[NORMAL, { id: "1", tabIds: [] }]], [1, 2]);
    await expect(resolveTabStore(api, 9)).rejects.toMatchObject({ name: "CookieStoreNotFound" });
  });

  test("refuses a store that also holds normal tabs", async () => {
    const api = fakeCookieApi([[{ id: "0", tabIds: [1, 9] }]], [1]);
    await expect(resolveTabStore(api, 9)).rejects.toMatchObject({ name: "CookieStoreNotFound" });
  });
});

describe("restoreCookies", () => {
  test("sets each cookie in the given store, host-only ones on the target's host", async () => {
    const api = fakeCookieApi([[]], []);
    const lasting: SiteCookie = {
      ...session,
      name: "theme",
      domain: ".localhost",
      path: "/app",
      expirationDate: 4_102_444_800,
    };
    await expect(restoreCookies(api, "1", ORIGIN, [session, lasting])).resolves.toBe(2);
    expect(api.written).toEqual([
      { ...session, storeId: "1", url: `${ORIGIN}/` },
      { ...lasting, storeId: "1", url: "http://localhost:5192/app" },
    ]);
    expect(api.written[0]).not.toHaveProperty("domain");
    expect(api.written[0]).not.toHaveProperty("expirationDate");
  });

  test("sets a host-only cookie of another host on that host, never passing the host to Chrome", async () => {
    const api = fakeCookieApi([[]], []);
    const sso: SiteCookie = { ...session, host: "sso.localhost", path: "/login" };
    await expect(restoreCookies(api, "1", ORIGIN, [sso])).resolves.toBe(1);
    const { host: _host, ...asSet } = sso;
    expect(api.written).toEqual([
      { ...asSet, storeId: "1", url: "http://sso.localhost:5192/login" },
    ]);
  });

  test("leaves out a cookie that expired since its capture, as the browser would have", async () => {
    // Chrome answers such a set with no cookie, which would read as a refusal (cookies_api.cc).
    const api = fakeCookieApi([[]], []);
    const expired: SiteCookie = { ...session, name: "old", expirationDate: Date.now() / 1000 - 1 };
    await expect(restoreCookies(api, "1", ORIGIN, [expired, session])).resolves.toBe(1);
    expect(api.written.map(({ name }) => name)).toEqual(["sid"]);
  });

  test("fails on a refused cookie, naming it but never its value", async () => {
    for (const refusal of ["null", "reject"] as const) {
      const api = fakeCookieApi([[]], []);
      api.refuse.set("sid", refusal);
      const failure = restoreCookies(api, "1", ORIGIN, [session]);
      await expect(failure).rejects.toMatchObject({ name: "CookieNotSet" });
      await expect(failure).rejects.toThrow('"sid"');
      await expect(failure).rejects.not.toThrow("abc");
    }
  });
});

/** A tab as `tabs.onCreated` reports it, with only the fields the tracker reads. */
const createdTab = (id: number, incognito: boolean) => ({ id, incognito }) as Browser.tabs.Tab;

describe("trackIncognitoStores", () => {
  test("remembers the store of each new Incognito tab, and asks nothing for a normal one", async () => {
    // A window opened and closed between two commands is otherwise never listed while RECnRun looks.
    const api = fakeCookieApi([[NORMAL, { id: "1", tabIds: [9] }]], [1, 2], [9]);
    const stores = vi.spyOn(api, "stores");
    const memory = memoryStoreMemory();
    trackIncognitoStores(api, memory);
    await fakeBrowser.tabs.onCreated.trigger(createdTab(3, false));
    expect(stores).not.toHaveBeenCalled();
    await fakeBrowser.tabs.onCreated.trigger(createdTab(9, true));
    await expect.poll(() => memory.ids).toEqual(["1"]);
  });

  test("drops a failed listing, and the next Incognito tab asks again", async () => {
    const api = fakeCookieApi([[NORMAL, { id: "1", tabIds: [9, 10] }]], [1, 2], [9, 10]);
    vi.spyOn(api, "stores").mockRejectedValueOnce(new Error("No cookies permission."));
    const memory = memoryStoreMemory();
    trackIncognitoStores(api, memory);
    await fakeBrowser.tabs.onCreated.trigger(createdTab(9, true));
    await fakeBrowser.tabs.onCreated.trigger(createdTab(10, true));
    await expect.poll(() => memory.ids).toEqual(["1"]);
  });
});

describe("chromeCookieApi", () => {
  test("lists stores and normal tabs, and sets cookies through Chrome", async () => {
    vi.spyOn(fakeBrowser.cookies, "getAllCookieStores").mockResolvedValue([
      { id: "0", tabIds: [1], incognito: false },
    ] as never);
    const tabs = [{ id: 1, incognito: false }, { id: 2, incognito: true }, { incognito: false }];
    vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue(tabs as never);
    const set = vi.spyOn(fakeBrowser.cookies, "set").mockResolvedValueOnce({} as never);

    await expect(chromeCookieApi.stores()).resolves.toEqual([{ id: "0", tabIds: [1] }]);
    await expect(chromeCookieApi.normalTabIds()).resolves.toEqual([1]);
    await expect(chromeCookieApi.incognitoTabIds()).resolves.toEqual([2]);
    const details = { ...session, storeId: "1", url: `${ORIGIN}/` };
    await expect(chromeCookieApi.set(details)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(details);
    set.mockResolvedValueOnce(null as never);
    await expect(chromeCookieApi.set(details)).resolves.toBe(false);
    // Chrome answers with no cookie at all when it stored none, as for one already expired.
    set.mockResolvedValueOnce(undefined as never);
    await expect(chromeCookieApi.set(details)).resolves.toBe(false);
    const getAll = vi.spyOn(fakeBrowser.cookies, "getAll").mockResolvedValue([] as never);
    await expect(chromeCookieApi.all("1")).resolves.toEqual([]);
    // An empty partition key asks for every partition, and for unpartitioned cookies too.
    expect(getAll).toHaveBeenCalledWith({ storeId: "1", partitionKey: {} });
  });
});

describe("chromeCookieApi.probe", () => {
  test("answers whether Chrome still knows the store, and fails on any other error", async () => {
    const getAll = vi.spyOn(fakeBrowser.cookies, "getAll").mockResolvedValueOnce([] as never);
    await expect(chromeCookieApi.probe("1")).resolves.toBe(true);
    expect(getAll).toHaveBeenCalledWith({ storeId: "1", domain: "recnrun.invalid" });
    // Chrome rejects an id once its profile is gone (cookies_api.cc:63, 103-115).
    getAll.mockRejectedValueOnce(new Error('Invalid cookie store id: "1".'));
    await expect(chromeCookieApi.probe("1")).resolves.toBe(false);
    getAll.mockRejectedValueOnce(new Error("No host permissions."));
    await expect(chromeCookieApi.probe("1")).rejects.toThrow("No host permissions.");
  });
});
