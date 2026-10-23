import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  openDashboard,
  openDashboardFrom,
  PAGE_MENU_ITEM,
  placeDashboard,
} from "@/background/open-dashboard";

const DASHBOARD = "chrome-extension://test-id/dashboard.html";

beforeEach(() => {
  fakeBrowser.reset();
});

const dashboardTabs = () => fakeBrowser.tabs.query({ url: DASHBOARD });

function tab(properties: Pick<Browser.tabs.Tab, "id" | "url" | "splitViewId">): Browser.tabs.Tab {
  return {
    id: 7,
    index: 2,
    windowId: 1,
    pinned: false,
    highlighted: true,
    active: true,
    incognito: false,
    selected: true,
    discarded: false,
    autoDiscardable: true,
    groupId: -1,
    frozen: false,
    lastAccessed: 0,
    ...properties,
  };
}

test("opens the dashboard in a new tab when none is open", async () => {
  await openDashboard(DASHBOARD);
  expect(await dashboardTabs()).toHaveLength(1);
});

test("focuses an open dashboard tab instead of opening another", async () => {
  await openDashboard(DASHBOARD);
  const other = await fakeBrowser.tabs.create({ url: "https://example.com/" });
  expect((await dashboardTabs())[0]?.active).toBe(false);

  await openDashboard(DASHBOARD);
  const tabs = await dashboardTabs();
  expect(tabs).toHaveLength(1);
  expect(tabs[0]?.active).toBe(true);
  expect((await fakeBrowser.tabs.get(other.id ?? -1)).active).toBe(false);
});

test("splits a web page's tab with the dashboard of the page's workspace", () => {
  const page = tab({ url: "https://shop.example/cart?step=2", splitViewId: -1 });
  expect(placeDashboard(page, true)).toEqual({
    kind: "split",
    tab: page,
    workspace: "https://shop.example",
  });
});

test("splits a tab whose address is hidden with the dashboard of every workspace", () => {
  const blank = tab({ url: undefined, splitViewId: -1 });
  expect(placeDashboard(blank, true)).toEqual({ kind: "split", tab: blank });
  expect(placeDashboard(tab({ url: undefined, splitViewId: 4 }), true)).toEqual({
    kind: "partner",
    splitViewId: 4,
  });
});

test("focuses the split's other side when the page is already split", () => {
  const page = tab({ url: "https://shop.example/", splitViewId: 4 });
  expect(placeDashboard(page, true)).toEqual({ kind: "partner", splitViewId: 4 });
});

test("keeps the dedicated dashboard tab without Split View, a tab, or a web page", () => {
  expect(placeDashboard(tab({ url: "https://shop.example/" }), false)).toEqual({ kind: "tab" });
  expect(placeDashboard(undefined, true)).toEqual({ kind: "tab" });
  expect(placeDashboard(tab({ url: `${DASHBOARD}#/` }), true)).toEqual({ kind: "tab" });
  expect(placeDashboard(tab({ url: "file:///tmp/a.html" }), true)).toEqual({ kind: "tab" });
});

test("creates the split dashboard next to the page, with its workspace", async () => {
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  await openDashboardFrom(tab({ url: "http://localhost:3000/login" }), DASHBOARD, true);
  expect(create).toHaveBeenCalledWith({
    url: `${DASHBOARD}?workspace=http%3A%2F%2Flocalhost%3A3000`,
    splitWithTabId: 7,
    windowId: 1,
    index: 3,
  });
});

test("falls back to the dedicated tab when Chrome refuses the split", async () => {
  vi.spyOn(fakeBrowser.tabs, "create").mockRejectedValueOnce(new Error("Split View is off"));
  await openDashboardFrom(tab({ url: "https://shop.example/" }), DASHBOARD, true);
  expect(await dashboardTabs()).toHaveLength(1);
});

test("creates the dashboard of every workspace next to a tab whose address is hidden", async () => {
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  await openDashboardFrom(tab({ url: undefined }), DASHBOARD, true);
  expect(create).toHaveBeenCalledWith({
    url: DASHBOARD,
    splitWithTabId: 7,
    windowId: 1,
    index: 3,
  });
});

test("opens the dedicated tab when Chrome has no Split View", async () => {
  await openDashboardFrom(tab({ url: "https://shop.example/" }), DASHBOARD, false);
  expect(await dashboardTabs()).toHaveLength(1);
});

test("offers Open RECnRun on every page and frame, the dashboard frame on recnrun.com included", () => {
  expect(PAGE_MENU_ITEM).toEqual({
    id: "open-recnrun",
    title: "Open RECnRun",
    contexts: ["page", "frame"],
  });
});
