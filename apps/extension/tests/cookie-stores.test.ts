import type { SiteCookie } from "@recnrun/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  chromeCookieApi,
  resolveTabStore,
  restoreCookies,
  waitForNoIncognitoStore,
} from "@/background/workspace/cookie-stores";
import { fakeCookieApi } from "./fake-cookies";

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

describe("waitForNoIncognitoStore", () => {
  test("asks again until no listed store is Incognito, and counts the checks", async () => {
    const closing = { id: "1", tabIds: [] };
    const api = fakeCookieApi([[NORMAL, closing], [NORMAL, closing], [NORMAL]], [1, 2]);
    await expect(waitForNoIncognitoStore(api)).resolves.toBe(3);
  });

  test("returns at once when only the normal store is listed", async () => {
    await expect(waitForNoIncognitoStore(fakeCookieApi([[NORMAL]], [1, 2]))).resolves.toBe(1);
  });

  test("fails explicitly when the Incognito store outlives the bound", async () => {
    const api = fakeCookieApi([[NORMAL, { id: "1", tabIds: [] }]], [1, 2]);
    await expect(waitForNoIncognitoStore(api, 0)).rejects.toMatchObject({
      name: "IncognitoNotGone",
    });
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
    const details = { ...session, storeId: "1", url: `${ORIGIN}/` };
    await expect(chromeCookieApi.set(details)).resolves.toBe(true);
    expect(set).toHaveBeenCalledWith(details);
    set.mockResolvedValueOnce(null as never);
    await expect(chromeCookieApi.set(details)).resolves.toBe(false);
  });
});
