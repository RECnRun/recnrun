import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { chromeDashboardBrowser } from "@/background/chrome-dashboard-browser";

const DASHBOARD = "chrome-extension://id/dashboard.html";
const chrome = chromeDashboardBrowser(DASHBOARD);

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
});

/** A normal window the user just focused, by id. */
async function focusedWindow(): Promise<number> {
  const created = await fakeBrowser.windows.create({ focused: true });
  return created?.id ?? -1;
}

const tab = (fields: Partial<Browser.tabs.Tab>) =>
  ({ windowId: 1, index: 0, incognito: false, ...fields }) as Browser.tabs.Tab;

test("lists a loading tab by the address it is loading, and leaves out tabs with no id", async () => {
  const listed = [
    tab({ id: 1, url: "https://shop.example/" }),
    tab({ id: 2, index: 1, url: "", pendingUrl: DASHBOARD }),
    tab({ id: 3, index: 2 }),
    tab({ url: "devtools://devtools/" }),
  ];
  // The callback overload types these APIs as returning void.
  vi.spyOn(fakeBrowser.tabs, "query").mockReturnValue(Promise.resolve(listed) as never);
  expect(await chrome.tabs()).toEqual([
    { id: 1, windowId: 1, index: 0, url: "https://shop.example/", incognito: false },
    { id: 2, windowId: 1, index: 1, url: DASHBOARD, incognito: false },
    { id: 3, windowId: 1, index: 2, url: "", incognito: false },
  ]);
});

test("reads the normal windows, and no last focused one before any window opens", async () => {
  expect(await chrome.lastFocused()).toBeUndefined();
  vi.spyOn(fakeBrowser.windows, "getLastFocused").mockRejectedValue(new Error("No window."));
  expect(await chrome.lastFocused()).toBeUndefined();
  vi.restoreAllMocks();

  const id = await focusedWindow();
  const all = vi.spyOn(fakeBrowser.windows, "getAll");
  expect(await chrome.windows()).toContainEqual({ id, incognito: false });
  expect(all).toHaveBeenCalledWith({ windowTypes: ["normal"] });
  vi.spyOn(fakeBrowser.windows, "getLastFocused").mockReturnValue(
    Promise.resolve({ id, incognito: true }) as never,
  );
  expect(await chrome.lastFocused()).toEqual({ id, incognito: true });
});

test("opens the dashboard as an active tab or in a focused window", async () => {
  const windowId = await focusedWindow();
  const create = vi.spyOn(fakeBrowser.tabs, "create");
  const opened = await chrome.open(windowId, 0);
  expect(create).toHaveBeenCalledWith({
    windowId,
    index: 0,
    url: DASHBOARD,
    active: true,
  });
  expect(opened).toMatchObject({ windowId, url: DASHBOARD, incognito: false });

  const createWindow = vi.spyOn(fakeBrowser.windows, "create");
  await chrome.openWindow();
  expect(createWindow).toHaveBeenCalledWith({ url: DASHBOARD, focused: true });
});

test("moves a tab, and focuses it with its window", async () => {
  const move = vi.spyOn(fakeBrowser.tabs, "move").mockReturnValue(Promise.resolve([]) as never);
  const update = vi.spyOn(fakeBrowser.tabs, "update");
  const focus = vi.spyOn(fakeBrowser.windows, "update");
  const windowId = await focusedWindow();
  const dashboard = await chrome.open(windowId);
  await chrome.move(dashboard, 0);
  await chrome.focus(dashboard);
  expect(move).toHaveBeenCalledWith(dashboard.id, { index: 0 });
  expect(update).toHaveBeenCalledWith(dashboard.id, { active: true });
  expect(focus).toHaveBeenCalledWith(windowId, { focused: true });
});
