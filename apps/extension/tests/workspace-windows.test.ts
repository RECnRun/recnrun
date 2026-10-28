import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { MockInstance } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import type { ManagedWindowState } from "@recnrun/domain";
import {
  BLANK_BOUND_MS,
  closeWindows,
  createNeutralWindow,
  inventory,
  trackManagedWindow,
} from "@/background/workspace/windows";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { openIncognitoWindow, openWindowsWithTabs, stubRemove } from "./fake-windows";

let create: MockInstance<typeof fakeBrowser.windows.create>;

beforeEach(() => {
  fakeBrowser.reset();
  create = openWindowsWithTabs();
});

// The Node projects share a worker, so a spy left on the fake browser would reach other files.
afterEach(() => {
  vi.restoreAllMocks();
});

const browserWindow = (fields: Partial<Browser.windows.Window>) =>
  ({ focused: false, alwaysOnTop: false, incognito: true, ...fields }) as Browser.windows.Window;

describe("inventory", () => {
  test("lists the Incognito windows with their tabs, and no normal window", async () => {
    await fakeBrowser.windows.create({ url: "https://shop.example/" });
    const incognito = await openIncognitoWindow("https://app.example/");
    const windows = await inventory();
    expect(windows.map((each) => each.id)).toEqual([incognito]);
    expect(windows[0]?.tabs?.map((tab) => tab.url)).toEqual(["https://app.example/"]);
  });

  test("asks Chrome for normal and popup windows, keeps Incognito PiP, and leaves out DevTools and id-less ones", async () => {
    const getAll = vi
      .spyOn(fakeBrowser.windows, "getAll")
      .mockResolvedValue([
        browserWindow({ id: 1, type: "normal" }),
        browserWindow({ id: 2, type: "popup" }),
        browserWindow({ id: 3, type: "devtools" }),
        browserWindow({ id: 4, type: "normal", alwaysOnTop: true }),
        browserWindow({ type: "normal" }),
      ] as never);
    expect((await inventory()).map((each) => each.id)).toEqual([1, 2, 4]);
    expect(getAll).toHaveBeenCalledWith({ populate: true, windowTypes: ["normal", "popup"] });
  });
});

describe("closeWindows", () => {
  test("closes every window it is given and leaves the others open", async () => {
    const first = await openIncognitoWindow();
    const second = await openIncognitoWindow();
    const kept = await openIncognitoWindow();
    await closeWindows([first, second]);
    expect((await inventory()).map((each) => each.id)).toEqual([kept]);
  });

  test("listens for removals before it removes, and stops listening once done", async () => {
    const id = await openIncognitoWindow();
    const added = vi.spyOn(fakeBrowser.windows.onRemoved, "addListener");
    const removed = vi.spyOn(fakeBrowser.windows, "remove");
    await closeWindows([id]);
    expect(added.mock.invocationCallOrder[0]).toBeLessThan(
      removed.mock.invocationCallOrder[0] ?? 0,
    );
    expect(fakeBrowser.windows.onRemoved.hasListeners()).toBe(false);
  });

  test("waits for Chrome to report each removal, not for remove() to resolve", async () => {
    const id = await openIncognitoWindow();
    const remove = fakeBrowser.windows.remove.bind(fakeBrowser.windows);
    let finishRemoval = () => Promise.resolve();
    stubRemove(async (windowId) => {
      finishRemoval = () => remove(windowId);
    });
    let closed = false;
    const closing = closeWindows([id]).then(() => {
      closed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(closed).toBe(false);
    await finishRemoval();
    await closing;
    expect(await inventory()).toEqual([]);
  });

  test("fails with a named error when a removal is never reported", async () => {
    const id = await openIncognitoWindow();
    vi.spyOn(fakeBrowser.windows, "remove").mockResolvedValue(undefined);
    await expect(closeWindows([id], 20)).rejects.toMatchObject({
      name: "WindowsNotClosed",
      message: "Chrome did not close the Incognito windows in time.",
    });
    expect(fakeBrowser.windows.onRemoved.hasListeners()).toBe(false);
  });

  test("fails when a window Chrome reported removed is still listed", async () => {
    const id = await openIncognitoWindow();
    stubRemove(async (windowId) => {
      await fakeBrowser.windows.onRemoved.trigger(windowId);
    });
    await expect(closeWindows([id])).rejects.toMatchObject({
      name: "WindowsNotClosed",
      message: "Some Incognito windows are still open.",
    });
  });

  test("accepts a window that closed before RECnRun could remove it", async () => {
    vi.spyOn(fakeBrowser.windows, "remove").mockRejectedValue(new Error("No window with id: 9."));
    await expect(closeWindows([9])).resolves.toBeUndefined();
    await expect(closeWindows([])).resolves.toBeUndefined();
  });
});

describe("createNeutralWindow", () => {
  test("opens a blank Incognito window and records it as the next generation", async () => {
    const first = await createNeutralWindow();
    expect(create).toHaveBeenCalledWith({ incognito: true, url: "about:blank" });
    expect(first).toMatchObject({ generation: 1, status: "active" });
    expect(await managedWindowRepository.read()).toEqual(first);

    await closeWindows([first.windowId]);
    const second = await createNeutralWindow();
    expect(second).toMatchObject({ generation: 2, status: "active" });
    expect(second.windowId).not.toBe(first.windowId);
    const [window] = await inventory();
    expect(window?.id).toBe(second.windowId);
    expect(window?.tabs?.map((tab) => [tab.id, tab.url])).toEqual([[second.tabId, "about:blank"]]);
  });

  test("returns once the new tab's blank page finished loading, so no navigation races it", async () => {
    const get = vi.spyOn(fakeBrowser.tabs, "get");
    get.mockImplementation((async (id: number) => ({ id, status: "loading" })) as never);
    let opened: ManagedWindowState | undefined;
    void createNeutralWindow().then((state) => (opened = state));
    await vi.waitFor(() => expect(create).toHaveBeenCalled());
    const created = (await create.mock.results[0]?.value) as Browser.windows.Window;
    const tabId = created.tabs?.[0]?.id ?? -1;
    const update = (id: number, change: Browser.tabs.OnUpdatedInfo) =>
      fakeBrowser.tabs.onUpdated.trigger(id, change, {} as Browser.tabs.Tab);
    await update(tabId + 1, { status: "complete" });
    await update(tabId, { title: "" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(opened).toBeUndefined();
    await update(tabId, { status: "complete" });
    await vi.waitFor(() => expect(opened).toMatchObject({ tabId, status: "active" }));
  });

  test("goes on after a bound when the blank page never reports loaded, or the tab is gone", async () => {
    vi.useFakeTimers();
    try {
      const get = vi.spyOn(fakeBrowser.tabs, "get");
      get.mockImplementation((async (id: number) => ({ id, status: "loading" })) as never);
      const opened = createNeutralWindow();
      await vi.advanceTimersByTimeAsync(BLANK_BOUND_MS);
      await expect(opened).resolves.toMatchObject({ generation: 1 });

      await closeWindows([(await opened).windowId]);
      get.mockRejectedValueOnce(new Error("No tab with id: 2."));
      await expect(createNeutralWindow()).resolves.toMatchObject({ generation: 2 });
    } finally {
      vi.useRealTimers();
    }
  });

  test("refuses while any Incognito window is open, and opens none", async () => {
    await openIncognitoWindow();
    create.mockClear();
    await expect(createNeutralWindow()).rejects.toMatchObject({
      name: "IncognitoWindowsOpen",
      message: "Close every Incognito window before RECnRun opens its own.",
    });
    expect(create).not.toHaveBeenCalled();
    expect(await managedWindowRepository.read()).toBeNull();
  });

  test("records nothing when Chrome opens no window with a tab", async () => {
    create.mockResolvedValueOnce(browserWindow({ id: 3 }) as never);
    await expect(createNeutralWindow()).rejects.toMatchObject({ name: "WindowNotCreated" });
    expect(await managedWindowRepository.read()).toBeNull();
  });

  test("leaves an unreadable stored state as it is and opens no window", async () => {
    await fakeBrowser.storage.local.set({ "managed-window": { generation: "x" } });
    await expect(createNeutralWindow()).rejects.toThrow(/current schema/);
    expect(create).not.toHaveBeenCalled();
  });
});

describe("trackManagedWindow", () => {
  test("marks the managed window closed when it goes, and ignores other windows", async () => {
    trackManagedWindow();
    const managed = await createNeutralWindow();
    const other = await fakeBrowser.windows.create({ incognito: true });
    await fakeBrowser.windows.remove(other?.id ?? -1);
    await expect.poll(() => managedWindowRepository.read()).toEqual(managed);

    await fakeBrowser.windows.remove(managed.windowId);
    await expect
      .poll(() => managedWindowRepository.read())
      .toEqual({ ...managed, status: "closed" });
  });

  test("marks it closed when the browser starts, since Incognito windows never survive a restart", async () => {
    trackManagedWindow();
    const managed = await createNeutralWindow();
    await fakeBrowser.runtime.onStartup.trigger();
    await expect
      .poll(() => managedWindowRepository.read())
      .toEqual({ ...managed, status: "closed" });
  });

  test("ignores a removal with nothing stored or an unreadable state", async () => {
    trackManagedWindow();
    const id = await openIncognitoWindow();
    await fakeBrowser.windows.remove(id);
    expect(await managedWindowRepository.read()).toBeNull();

    const unreadable = { "managed-window": { status: "lost" } };
    await fakeBrowser.storage.local.set(unreadable);
    await fakeBrowser.runtime.onStartup.trigger();
    expect(await fakeBrowser.storage.local.get("managed-window")).toEqual(unreadable);
  });
});
