import { afterEach, beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { chromeCaptureApi } from "@/background/workspace/capture-api";
import { chromeHelperTabApi } from "@/background/workspace/helper-tab";

const URL_ = "http://app.localhost:5192/app/";

beforeEach(() => {
  fakeBrowser.reset();
});

// The Node projects share a worker, so a spy left on the fake browser would reach other files.
afterEach(() => {
  vi.restoreAllMocks();
});

const tab = (fields: Partial<Browser.tabs.Tab>) => fields as Browser.tabs.Tab;

test("lists each Incognito window's tabs in index order, leaving RECnRun's helper tabs out", async () => {
  vi.spyOn(fakeBrowser.tabs, "create").mockResolvedValue(tab({ id: 30 }) as never);
  vi.spyOn(fakeBrowser.tabs, "get").mockResolvedValue(tab({ id: 30, status: "complete" }) as never);
  const helper = await chromeHelperTabApi.open(3);
  const windows = [
    {
      id: 3,
      focused: true,
      incognito: true,
      tabs: [
        tab({ id: 32, index: 2, active: false }),
        tab({ id: helper, index: 1, active: false }),
        tab({ id: 31, index: 0, active: true }),
        tab({ index: 3, active: false }),
      ],
    },
    { id: 4, focused: false, incognito: true },
    { id: 5, focused: false, incognito: false, tabs: [tab({ id: 50, index: 0, active: true })] },
  ];
  vi.spyOn(fakeBrowser.windows, "getAll").mockResolvedValue(windows as never);
  await expect(chromeCaptureApi.windows()).resolves.toEqual([
    {
      id: 3,
      focused: true,
      tabs: [
        { id: 31, active: true },
        { id: 32, active: false },
      ],
    },
    { id: 4, focused: false, tabs: [] },
  ]);
  await chromeHelperTabApi.close(helper).catch(() => undefined);
});

test("reads the tab's top frame and injects the agent into that document only", async () => {
  const frame = { url: URL_, documentId: "doc-1", frameId: 0, parentFrameId: -1 };
  const getFrame = vi
    .spyOn(fakeBrowser.webNavigation, "getFrame")
    .mockResolvedValue(frame as never);
  await expect(chromeCaptureApi.topFrame(7)).resolves.toEqual({ url: URL_, documentId: "doc-1" });
  expect(getFrame).toHaveBeenCalledWith({ tabId: 7, frameId: 0 });
  getFrame.mockResolvedValue(null as never);
  await expect(chromeCaptureApi.topFrame(7)).resolves.toBeNull();

  const executeScript = vi
    .spyOn(fakeBrowser.scripting, "executeScript")
    .mockResolvedValue([] as never);
  await chromeCaptureApi.inject(7, "doc-1");
  expect(executeScript).toHaveBeenCalledWith({
    target: { tabId: 7, documentIds: ["doc-1"] },
    files: ["/content-scripts/origin-agent.js"],
  });
  expect(chromeCaptureApi.onConnect).toBe(fakeBrowser.runtime.onConnect);
});

test("discards a tab under the id Chrome returns, refuses one without, and navigates a tab", async () => {
  const discard = vi.spyOn(fakeBrowser.tabs, "discard").mockResolvedValueOnce({ id: 8 } as never);
  await expect(chromeCaptureApi.discard(7)).resolves.toBe(8);
  expect(discard).toHaveBeenCalledWith(7);
  discard.mockResolvedValueOnce(undefined as never);
  await expect(chromeCaptureApi.discard(7)).rejects.toThrow("Chrome did not unload the tab.");
  const update = vi.spyOn(fakeBrowser.tabs, "update").mockResolvedValue({} as never);
  await chromeCaptureApi.navigate(8, URL_);
  expect(update).toHaveBeenCalledWith(8, { url: URL_ });
});
