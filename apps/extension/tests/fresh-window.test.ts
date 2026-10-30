import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { closeRemembering } from "@/background/workspace/fresh-window";
import { fakeCookieApi, memoryStoreMemory } from "./fake-cookies";
import { openIncognitoWindow, openWindowsWithTabs } from "./fake-windows";

beforeEach(() => {
  fakeBrowser.reset();
  openWindowsWithTabs();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const isOpen = async (windowId: number) =>
  (await fakeBrowser.windows.getAll()).some(({ id }) => id === windowId);

test("a store listing that fails does not keep the windows open", async () => {
  const windowId = await openIncognitoWindow();
  const cookies = fakeCookieApi([], []);
  cookies.stores = () => Promise.reject(new Error("Chrome is shutting down"));
  const stores = memoryStoreMemory();
  await closeRemembering([windowId], { cookies, stores });
  expect(await isOpen(windowId)).toBe(false);
  expect(stores.ids).toEqual([]);
});
