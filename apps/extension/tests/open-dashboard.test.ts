import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  openDashboard,
  openDashboardFrom,
  openForTrigger,
  PAGE_MENU_ITEM,
  placeDashboard,
} from "@/background/open-dashboard";
import { showWorkspaceMessage } from "@/messaging/dashboard-protocol";

const DASHBOARD = "chrome-extension://test-id/dashboard.html";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

const dashboardTabs = () => fakeBrowser.tabs.query({ url: DASHBOARD });

function tab(
  properties: Partial<Pick<Browser.tabs.Tab, "id" | "url" | "splitViewId" | "index" | "windowId">>,
): Browser.tabs.Tab {
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
});

test("splits a browser page, such as a new tab, with the dashboard of every workspace", () => {
  for (const url of ["chrome://newtab/", "about:blank", "file:///tmp/a.html"]) {
    const page = tab({ url, splitViewId: -1 });
    expect(placeDashboard(page, true)).toEqual({ kind: "split", tab: page });
  }
});

test("focuses the open dashboard whatever workspace its address shows", async () => {
  const open = await fakeBrowser.tabs.create({
    url: `${DASHBOARD}?workspace=https%3A%2F%2Fa.example`,
  });
  await fakeBrowser.tabs.create({ url: "https://example.com/", active: true });
  const create = vi.spyOn(fakeBrowser.tabs, "create");

  await openDashboard(DASHBOARD);
  expect(create).not.toHaveBeenCalled();
  expect((await fakeBrowser.tabs.get(open.id ?? -1)).active).toBe(true);
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

/** fakeBrowser has no Split View or tab moves, so these stand in for Chrome's. */
function fakeTabMoves() {
  const unsplit = vi.fn(async (_splitViewId: number) => {});
  const createSplit = vi.fn(async (_tabIds: [number, number]) => 9);
  const move = vi.fn(async (_tabId: number, _properties: object) => ({}));
  Object.assign(fakeBrowser.tabs, { unsplit, createSplit, move });
  const sendMessage = vi.spyOn(fakeBrowser.runtime, "sendMessage").mockResolvedValue(undefined);
  return { unsplit, createSplit, move, sendMessage };
}

/** The open dashboard tab as Chrome reports it, split with another page when splitViewId is set. */
async function openDashboardTab(properties: Partial<Browser.tabs.Tab>) {
  const { id = -1 } = await fakeBrowser.tabs.create({
    url: `${DASHBOARD}?workspace=https%3A%2F%2Fa.example`,
  });
  // fakeBrowser keeps whatever an update passes, so this sets Chrome's read-only tab state.
  await fakeBrowser.tabs.update(id, properties as Browser.tabs.UpdateProperties);
  return id;
}

test("moves the open dashboard beside the page and tells it the page's workspace", async () => {
  const { unsplit, createSplit, move, sendMessage } = fakeTabMoves();
  const dashboard = await openDashboardTab({ index: 0, windowId: 1, splitViewId: 4 });
  const create = vi.spyOn(fakeBrowser.tabs, "create");

  await openDashboardFrom(tab({ id: 30, url: "https://b.example/x", index: 5 }), DASHBOARD, true);
  expect(create).not.toHaveBeenCalled();
  expect(unsplit).toHaveBeenCalledWith(4);
  expect(move).toHaveBeenCalledWith(dashboard, { windowId: 1, index: 5 });
  expect(createSplit).toHaveBeenCalledWith([30, dashboard]);
  expect(sendMessage).toHaveBeenCalledWith(showWorkspaceMessage(dashboard, "https://b.example"));
  expect((await fakeBrowser.tabs.get(dashboard)).active).toBe(true);
});

test("moves the dashboard from another window to the right of the page", async () => {
  const { unsplit, move, sendMessage } = fakeTabMoves();
  const dashboard = await openDashboardTab({ index: 0, windowId: 1, splitViewId: -1 });

  await openDashboardFrom(tab({ id: 30, url: undefined, index: 0, windowId: 2 }), DASHBOARD, true);
  expect(unsplit).not.toHaveBeenCalled();
  expect(move).toHaveBeenCalledWith(dashboard, { windowId: 2, index: 1 });
  expect(sendMessage).toHaveBeenCalledWith(showWorkspaceMessage(dashboard));
});

test("still focuses the open dashboard when Chrome refuses to move it", async () => {
  const { move } = fakeTabMoves();
  move.mockRejectedValue(new Error("Tabs cannot be edited right now"));
  const dashboard = await openDashboardTab({ index: 0, windowId: 1, splitViewId: -1 });
  const focusWindow = vi.spyOn(fakeBrowser.windows, "update");

  await openDashboardFrom(tab({ id: 30, url: "https://b.example/" }), DASHBOARD, true);
  expect((await fakeBrowser.tabs.get(dashboard)).active).toBe(true);
  expect(focusWindow).toHaveBeenCalledWith(1, { focused: true });
});

test("opens the dedicated tab when Chrome has no Split View", async () => {
  await openDashboardFrom(tab({ url: "https://shop.example/" }), DASHBOARD, false);
  expect(await dashboardTabs()).toHaveLength(1);
});

test("a trigger opens nothing while a PiP recording panel floats", async () => {
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  await openForTrigger(tab({ url: "https://shop.example/" }), DASHBOARD, async () => true);
  expect(create).not.toHaveBeenCalled();
  await openForTrigger(undefined, DASHBOARD, async () => false);
  expect(await dashboardTabs()).toHaveLength(1);
});

test("offers Open RECnRun on every page and frame, the dashboard frame on recnrun.com included", () => {
  expect(PAGE_MENU_ITEM).toEqual({
    id: "open-recnrun",
    title: "Open RECnRun",
    contexts: ["page", "frame"],
  });
});
