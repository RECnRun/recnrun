import type { RecordingSession } from "@recnrun/domain";
import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startSession } from "@/background/session-requests";
import { memoryRecordingStore } from "./fake-extension";

const running = (tabId: number): RecordingSession => ({
  tabId,
  status: "recording",
  banked: 0,
  since: 1,
});

async function activeTabId() {
  const [tab] = await fakeBrowser.tabs.query({ active: true });
  return tab?.id;
}

beforeEach(() => {
  fakeBrowser.reset();
});

test("records the tab when no session runs, and focuses it", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  await fakeBrowser.tabs.create({ url: "https://recnrun.com/", active: true });
  const store = memoryRecordingStore();
  await startSession(shop.id ?? -1, store, 5);
  expect(await store.read()).toEqual({ tabId: shop.id, status: "recording", banked: 0, since: 5 });
  expect(await activeTabId()).toBe(shop.id);
});

test("keeps the running session and focuses the tab it records", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const docs = await fakeBrowser.tabs.create({ url: "https://docs.example/", active: true });
  const session = { ...running(shop.id ?? -1), status: "paused" as const, banked: 42 };
  const store = memoryRecordingStore(session);
  await startSession(docs.id ?? -1, store);
  expect(await store.read()).toEqual(session);
  expect(await activeTabId()).toBe(shop.id);
});

test("leaves an unreadable session as it is and reports it", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const store = memoryRecordingStore(null, true);
  await expect(startSession(shop.id ?? -1, store, 5)).rejects.toThrow("Stored session is invalid");
  await expect(store.read()).rejects.toThrow("Stored session is invalid");
});

test("starts no session on a tab that is gone", async () => {
  const store = memoryRecordingStore();
  await expect(startSession(999, store)).rejects.toThrow("The tab to record was closed.");
  expect(await store.read()).toBeNull();
});
