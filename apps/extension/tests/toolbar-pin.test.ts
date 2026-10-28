import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browserToolbarPin } from "@/dashboard/toolbar-pin";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("reads whether RECnRun is on the toolbar, and hears the user pin or unpin it", async () => {
  const listeners = new Set<(change: { isOnToolbar?: boolean }) => void>();
  const onUserSettingsChanged = {
    addListener: (listener: (change: { isOnToolbar?: boolean }) => void) => listeners.add(listener),
    removeListener: (listener: (change: { isOnToolbar?: boolean }) => void) =>
      listeners.delete(listener),
  };
  const getUserSettings = vi.fn().mockResolvedValue({ isOnToolbar: false });
  Object.assign(fakeBrowser.action, { getUserSettings, onUserSettingsChanged });

  await expect(browserToolbarPin.pinned()).resolves.toBe(false);
  const seen: boolean[] = [];
  const stop = browserToolbarPin.watch((pinned) => seen.push(pinned));
  for (const listener of listeners) listener({ isOnToolbar: true });
  // A change to another setting says nothing about the toolbar.
  for (const listener of listeners) listener({});
  stop();
  expect(seen).toEqual([true]);
  expect(listeners.size).toBe(0);
});
