import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { focusCurrentTab } from "@/dashboard/panel/focus-tab";

beforeEach(() => {
  fakeBrowser.reset();
});

test("focuses the dashboard's own tab and window", async () => {
  const dashboard = await fakeBrowser.tabs.create({
    url: "chrome-extension://test-id/dashboard.html",
  });
  await fakeBrowser.tabs.create({ url: "https://shop.example/", active: true });
  const focusWindow = vi.spyOn(fakeBrowser.windows, "update");

  await focusCurrentTab(async () => dashboard);

  expect((await fakeBrowser.tabs.get(dashboard.id ?? -1)).active).toBe(true);
  expect(focusWindow).toHaveBeenCalledWith(dashboard.windowId, { focused: true });
});

test("does nothing outside a tab", async () => {
  const update = vi.spyOn(fakeBrowser.tabs, "update");
  await focusCurrentTab(async () => undefined);
  expect(update).not.toHaveBeenCalled();
});
