import { vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";

/**
 * Chrome's windows.create opens the window with its first tab and returns both; the fake browser
 * opens no tab, so this spy adds one. `vi.restoreAllMocks()` removes it.
 */
export function openWindowsWithTabs() {
  const create = fakeBrowser.windows.create.bind(fakeBrowser.windows);
  const withTab = async (data?: Browser.windows.CreateData) => {
    const window = await create(data);
    const url = [data?.url].flat()[0];
    const tab = await fakeBrowser.tabs.create({ windowId: window?.id, url });
    return { ...window, tabs: [tab] };
  };
  // The spy takes the callback overload's type; the promise overload is the one called.
  return vi.spyOn(fakeBrowser.windows, "create").mockImplementation(withTab as never);
}

/** Replaces windows.remove, to delay or drop the removal event Chrome would send. */
export function stubRemove(remove: (windowId: number) => Promise<void>) {
  return vi.spyOn(fakeBrowser.windows, "remove").mockImplementation(remove as never);
}

/** An Incognito window the user opened, as the tests' foreign window. */
export async function openIncognitoWindow(url = "https://private.example/"): Promise<number> {
  const window = await fakeBrowser.windows.create({ incognito: true, url });
  return window?.id ?? -1;
}
