import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { panelTab } from "@/dashboard/panel/panel-tab";

const DASHBOARD = "chrome-extension://test-id/dashboard.html";

beforeEach(() => {
  fakeBrowser.reset();
});

/** The tab fakeBrowser starts with; its query ignores splitViewId, so this is the dashboard's partner. */
async function theOtherTab() {
  const [tab] = await fakeBrowser.tabs.query({});
  if (!tab) throw new Error("fakeBrowser has no tab.");
  return tab;
}

/** fakeBrowser has no Split View, so these stand in for Chrome's. */
function fakeSplitView() {
  const unsplit = vi.fn(async (_splitViewId: number) => {});
  const createSplit = vi.fn(async (_tabIds: [number, number]) => 7);
  Object.assign(fakeBrowser.tabs, { unsplit, createSplit });
  return { unsplit, createSplit };
}

test("focuses the dashboard's own tab and window", async () => {
  const dashboard = await fakeBrowser.tabs.create({ url: DASHBOARD });
  await fakeBrowser.tabs.create({ url: "https://shop.example/", active: true });
  const focusWindow = vi.spyOn(fakeBrowser.windows, "update");

  await panelTab(async () => dashboard).focus();

  expect((await fakeBrowser.tabs.get(dashboard.id ?? -1)).active).toBe(true);
  expect(focusWindow).toHaveBeenCalledWith(dashboard.windowId, { focused: true });
});

test("leaves the Split View for the page beside it, and splits with it again on focus", async () => {
  const { unsplit, createSplit } = fakeSplitView();
  const site = await theOtherTab();
  const dashboard = { ...(await fakeBrowser.tabs.create({ url: DASHBOARD })), splitViewId: 7 };
  let current = dashboard;
  const tab = panelTab(async () => current);

  await tab.leaveSplit();
  expect(unsplit).toHaveBeenCalledWith(7);
  current = { ...dashboard, splitViewId: -1 };
  expect((await fakeBrowser.tabs.get(site.id ?? -1)).active).toBe(true);

  await tab.focus();
  expect(createSplit).toHaveBeenCalledWith([site.id, dashboard.id]);
  expect((await fakeBrowser.tabs.get(dashboard.id ?? -1)).active).toBe(true);
});

test("still focuses the dashboard when splitting again fails", async () => {
  const { createSplit } = fakeSplitView();
  createSplit.mockRejectedValue(new Error("No tab with id"));
  const dashboard = { ...(await fakeBrowser.tabs.create({ url: DASHBOARD })), splitViewId: 7 };
  const tab = panelTab(async () => dashboard);

  await tab.leaveSplit();
  await tab.focus();
  expect((await fakeBrowser.tabs.get(dashboard.id ?? -1)).active).toBe(true);
});

test("does not split again once the dashboard moved into another Split View", async () => {
  const { createSplit } = fakeSplitView();
  const dashboard = { ...(await fakeBrowser.tabs.create({ url: DASHBOARD })), splitViewId: 7 };
  let current = dashboard;
  const tab = panelTab(async () => current);

  await tab.leaveSplit();
  current = { ...dashboard, splitViewId: 8 };
  await tab.focus();
  expect(createSplit).not.toHaveBeenCalled();
  expect((await fakeBrowser.tabs.get(dashboard.id ?? -1)).active).toBe(true);
});

test("outside a Split View or a tab it changes nothing", async () => {
  const { unsplit } = fakeSplitView();
  const update = vi.spyOn(fakeBrowser.tabs, "update");
  const dashboard = await fakeBrowser.tabs.create({ url: DASHBOARD });
  await panelTab(async () => dashboard).leaveSplit();
  await panelTab(async () => undefined).focus();
  expect(unsplit).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});
