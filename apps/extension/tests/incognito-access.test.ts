import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { browserIncognito } from "@/dashboard/incognito-access";

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

test("asks Chrome whether RECnRun may see incognito tabs, and opens an incognito window", async () => {
  const allowed = vi.fn().mockResolvedValue(true);
  Object.assign(fakeBrowser, { extension: { isAllowedIncognitoAccess: allowed } });
  const create = vi.spyOn(fakeBrowser.windows, "create").mockResolvedValue({} as never);
  await expect(browserIncognito.allowed()).resolves.toBe(true);
  await browserIncognito.openWindow();
  expect(create).toHaveBeenCalledWith({ incognito: true });
});

test("opens RECnRun's own details in chrome://extensions, by its runtime id", async () => {
  const create = vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue({} as never);
  await browserIncognito.openSettings();
  expect(create).toHaveBeenCalledWith({ url: `chrome://extensions/?id=${fakeBrowser.runtime.id}` });
});
