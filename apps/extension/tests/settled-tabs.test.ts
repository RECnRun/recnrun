import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { settledTabs } from "@/background/workspace/windows";

type TabState = Pick<Browser.tabs.Tab, "status" | "pendingUrl">;

let tabs: TabState[];

beforeEach(() => {
  fakeBrowser.reset();
  tabs = [];
  // One Incognito window holding `tabs` as they are when Chrome is asked.
  vi.spyOn(fakeBrowser.windows, "getAll").mockImplementation((async () => [
    {
      id: 1,
      type: "normal",
      incognito: true,
      focused: true,
      alwaysOnTop: false,
      tabs: tabs.map((tab, index) => ({ id: 10 + index, index, ...tab })),
    },
  ]) as never);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const listeners = () =>
  [fakeBrowser.tabs.onUpdated, fakeBrowser.tabs.onRemoved].filter((event) =>
    (event as unknown as { hasListeners: () => boolean }).hasListeners(),
  );

test("resolves at once when no tab is loading, an unloaded one included", async () => {
  tabs = [{ status: "complete" }, { status: "unloaded" }];
  await settledTabs(3_000);
  expect(fakeBrowser.windows.getAll).toHaveBeenCalledOnce();
  expect(listeners()).toEqual([]);
});

test("waits for a tab that loads, or still runs the page its navigation replaces, to finish", async () => {
  tabs = [{ status: "loading" }, { status: "complete", pendingUrl: "about:blank" }];
  let settled = false;
  const settling = settledTabs(3_000).then(() => (settled = true));
  await vi.waitFor(() => expect(fakeBrowser.windows.getAll).toHaveBeenCalledOnce());
  tabs = [{ status: "complete" }, { status: "loading" }];
  await fakeBrowser.tabs.onUpdated.trigger(10, { status: "complete" }, {} as Browser.tabs.Tab);
  await vi.waitFor(() => expect(fakeBrowser.windows.getAll).toHaveBeenCalledTimes(2));
  expect(settled).toBe(false);
  tabs = [{ status: "complete" }];
  await fakeBrowser.tabs.onRemoved.trigger(11, { windowId: 1, isWindowClosing: false });
  await settling;
  expect(fakeBrowser.windows.getAll).toHaveBeenCalledTimes(3);
  expect(listeners()).toEqual([]);
});

test("gives up at the bound, leaving a tab that still loads as it is", async () => {
  vi.useFakeTimers();
  tabs = [{ status: "loading" }];
  let settled = false;
  const settling = settledTabs(3_000).then(() => (settled = true));
  await vi.advanceTimersByTimeAsync(2_999);
  expect(settled).toBe(false);
  await vi.advanceTimersByTimeAsync(1);
  await settling;
  expect(fakeBrowser.windows.getAll).toHaveBeenCalledOnce();
  expect(listeners()).toEqual([]);
});
