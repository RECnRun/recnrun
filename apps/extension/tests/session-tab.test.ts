import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { sessionTab } from "@/session/session-tab";

const SESSION = "chrome-extension://test-id/session.html";

beforeEach(() => {
  fakeBrowser.reset();
});

/** The tab fakeBrowser starts with; its query ignores splitViewId, so this is the pane's partner. */
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

test("focuses the pane's own tab and window", async () => {
  const pane = await fakeBrowser.tabs.create({ url: SESSION });
  await fakeBrowser.tabs.create({ url: "https://shop.example/", active: true });
  const focusWindow = vi.spyOn(fakeBrowser.windows, "update");

  await sessionTab(async () => pane).focus();

  expect((await fakeBrowser.tabs.get(pane.id ?? -1)).active).toBe(true);
  expect(focusWindow).toHaveBeenCalledWith(pane.windowId, { focused: true });
});

test("leaves the Split View for the page beside it, and splits with it again on focus", async () => {
  const { unsplit, createSplit } = fakeSplitView();
  const site = await theOtherTab();
  const pane = { ...(await fakeBrowser.tabs.create({ url: SESSION })), splitViewId: 7 };
  let current = pane;
  const tab = sessionTab(async () => current);

  await tab.leaveSplit();
  expect(unsplit).toHaveBeenCalledWith(7);
  current = { ...pane, splitViewId: -1 };
  expect((await fakeBrowser.tabs.get(site.id ?? -1)).active).toBe(true);

  await tab.focus();
  expect(createSplit).toHaveBeenCalledWith([site.id, pane.id]);
  expect((await fakeBrowser.tabs.get(pane.id ?? -1)).active).toBe(true);
});

test("still focuses the pane when splitting again fails", async () => {
  const { createSplit } = fakeSplitView();
  createSplit.mockRejectedValue(new Error("No tab with id"));
  const pane = { ...(await fakeBrowser.tabs.create({ url: SESSION })), splitViewId: 7 };
  const tab = sessionTab(async () => pane);

  await tab.leaveSplit();
  await tab.focus();
  expect((await fakeBrowser.tabs.get(pane.id ?? -1)).active).toBe(true);
});

test("does not split again once the pane moved into another Split View", async () => {
  const { createSplit } = fakeSplitView();
  const pane = { ...(await fakeBrowser.tabs.create({ url: SESSION })), splitViewId: 7 };
  let current = pane;
  const tab = sessionTab(async () => current);

  await tab.leaveSplit();
  current = { ...pane, splitViewId: 8 };
  await tab.focus();
  expect(createSplit).not.toHaveBeenCalled();
  expect((await fakeBrowser.tabs.get(pane.id ?? -1)).active).toBe(true);
});

test("outside a Split View or a tab it changes nothing", async () => {
  const { unsplit } = fakeSplitView();
  const update = vi.spyOn(fakeBrowser.tabs, "update");
  const pane = await fakeBrowser.tabs.create({ url: SESSION });
  await sessionTab(async () => pane).leaveSplit();
  await sessionTab(async () => undefined).focus();
  expect(unsplit).not.toHaveBeenCalled();
  expect(update).not.toHaveBeenCalled();
});

test("closes its own tab, and nothing outside a tab", async () => {
  // fakeBrowser's remove looks the window up by the tab's id, so this stands in for Chrome's.
  const remove = vi.spyOn(fakeBrowser.tabs, "remove").mockResolvedValue();
  const pane = await fakeBrowser.tabs.create({ url: SESSION });
  await sessionTab(async () => pane).close();
  await sessionTab(async () => undefined).close();
  expect(remove).toHaveBeenCalledExactlyOnceWith(pane.id);
});
