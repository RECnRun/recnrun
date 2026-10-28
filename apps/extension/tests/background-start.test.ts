import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startBackground } from "@/background/start";
import { incognitoStoreMemory } from "@/storage/incognito-stores";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { manageTab } from "./workspace-harness";

const manifest = { manifest_version: 3 as const, name: "RECnRun", version: "0.1.0" };
const ownPage = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/dashboard.html") };
const contentScript = { id: fakeBrowser.runtime.id, url: "https://recnrun.com/" };

/** Delivers a message as Chrome would and collects the one reply. */
async function deliver(message: unknown, sender: { id: string; url: string }) {
  const replies: unknown[] = [];
  // The listener answers through sendResponse; what it returns is Chrome's channel flag.
  void fakeBrowser.runtime.onMessage.trigger(message, sender, (reply: unknown) =>
    replies.push(reply),
  );
  await vi.waitFor(() => expect(replies).toHaveLength(1));
  return replies[0];
}

beforeEach(() => {
  fakeBrowser.reset();
  vi.restoreAllMocks();
  vi.spyOn(fakeBrowser.runtime, "getManifest").mockReturnValue(manifest);
});

test("registers one listener that answers every message family", async () => {
  const added = vi.spyOn(fakeBrowser.runtime.onMessage, "addListener");
  startBackground();
  expect(added).toHaveBeenCalledTimes(1);

  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  await manageTab(shop.id ?? -1);
  expect(await deliver({ type: "ping" }, contentScript)).toEqual({
    ok: true,
    result: { extensionVersion: "0.1.0" },
  });
  expect(await deliver({ type: "start-session", tabId: shop.id }, ownPage)).toEqual({ ok: true });
  expect(await recordingSessionRepository.read()).toMatchObject({ tabId: shop.id });
});

test("tracks the managed Incognito window from the start", async () => {
  startBackground();
  const managed = { generation: 1, windowId: 4, tabId: 40, status: "active" as const };
  await managedWindowRepository.update(() => managed);
  await fakeBrowser.windows.onRemoved.trigger(4);
  await expect.poll(() => managedWindowRepository.read()).toEqual({ ...managed, status: "closed" });
});

test("remembers the cookie store of each new Incognito tab from the start", async () => {
  startBackground();
  const tabs = [
    { id: 1, incognito: false },
    { id: 9, incognito: true },
  ] as Browser.tabs.Tab[];
  vi.spyOn(fakeBrowser.tabs, "query").mockResolvedValue(tabs as never);
  vi.spyOn(fakeBrowser.cookies, "getAllCookieStores").mockResolvedValue([
    { id: "0", tabIds: [1] },
    { id: "1", tabIds: [9] },
  ] as never);
  await fakeBrowser.tabs.onCreated.trigger(tabs[1] as Browser.tabs.Tab);
  await expect.poll(() => incognitoStoreMemory.read()).toEqual(["1"]);
});

test("exposes the POC test handles in test builds only", () => {
  const scope = globalThis as { recnrunPoc?: unknown };
  delete scope.recnrunPoc;
  vi.stubEnv("MODE", "production");
  startBackground();
  expect(scope.recnrunPoc).toBeUndefined();
  vi.stubEnv("MODE", "test");
  startBackground();
  expect(scope.recnrunPoc).toMatchObject({ startWithIdentity: expect.any(Function) });
  vi.unstubAllEnvs();
  delete scope.recnrunPoc;
});
