import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browserIncognito } from "@/dashboard/incognito-access";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("asks Chrome whether RECnRun may see incognito tabs", async () => {
  const allowed = vi.fn().mockResolvedValue(true);
  Object.assign(fakeBrowser, { extension: { isAllowedIncognitoAccess: allowed } });
  await expect(browserIncognito.allowed()).resolves.toBe(true);
});

test("calls back when a window opens or closes, until unsubscribed", async () => {
  let changes = 0;
  const unwatch = browserIncognito.watchWindows(() => (changes += 1));
  const window = await fakeBrowser.windows.create({});
  await fakeBrowser.windows.remove(window?.id ?? -1);
  expect(changes).toBe(2);
  unwatch();
  await fakeBrowser.windows.create({});
  expect(changes).toBe(2);
  expect(fakeBrowser.windows.onCreated.hasListeners()).toBe(false);
  expect(fakeBrowser.windows.onRemoved.hasListeners()).toBe(false);
});

test("opens RECnRun's own details in chrome://extensions, by its runtime id", async () => {
  const create = vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({} as never);
  await browserIncognito.openSettings();
  expect(create).toHaveBeenCalledWith({ url: `chrome://extensions/?id=${fakeBrowser.runtime.id}` });
});

/** Chrome's permissions events; the fake browser leaves them unimplemented. */
function permissionEvents() {
  const added = new Set<() => void>();
  const removed = new Set<() => void>();
  const event = (listeners: Set<() => void>) => ({
    addListener: (listener: () => void) => listeners.add(listener),
    removeListener: (listener: () => void) => listeners.delete(listener),
  });
  const fire = (listeners: Set<() => void>) => {
    for (const listener of listeners) listener();
  };
  Object.assign(fakeBrowser, {
    permissions: { onAdded: event(added), onRemoved: event(removed) },
  });
  return {
    add: () => fire(added),
    remove: () => fire(removed),
    listening: () => added.size + removed.size,
  };
}

test("calls back when the user withholds or grants site access, until unsubscribed", () => {
  const { permissions } = fakeBrowser;
  const events = permissionEvents();
  try {
    let changes = 0;
    const unwatch = browserIncognito.watchSiteAccess(() => (changes += 1));
    events.remove();
    events.add();
    expect(changes).toBe(2);
    unwatch();
    expect(events.listening()).toBe(0);
  } finally {
    Object.assign(fakeBrowser, { permissions });
  }
});
