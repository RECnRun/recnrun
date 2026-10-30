import { beforeEach, expect, test, vi } from "vite-plus/test";
import type { Browser } from "wxt/browser";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startBackground } from "@/background/start";
import { incognitoStoreMemory } from "@/storage/incognito-stores";
import { managedWindowRepository } from "@/storage/managed-window-repository";
import { recordingSessionRepository } from "@/storage/recording-session-repository";
import { responseUrlStore } from "@/storage/response-urls";
import { fakePort } from "./fake-port";
import { manageTab } from "./workspace-harness";

const manifest = { manifest_version: 3 as const, name: "RECnRun", version: "0.1.0" };
const ownPage = { id: fakeBrowser.runtime.id, url: fakeBrowser.runtime.getURL("/dashboard.html") };
const contentScript = { id: fakeBrowser.runtime.id, url: "https://recnrun.com/" };

/** Delivers a message as Chrome would and collects the one reply. */
async function deliver(message: unknown, sender: { id: string; url: string; origin?: string }) {
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
  // fakeBrowser implements no in-memory onReplaced.
  vi.spyOn(fakeBrowser.tabs.onReplaced, "addListener").mockImplementation(() => undefined);
  // Nor an in-memory runtime.onConnect.
  vi.spyOn(fakeBrowser.runtime.onConnect, "addListener").mockImplementation(() => undefined);
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

test("ends at once an agent link that no wait asked for, and leaves other ports alone", () => {
  const added = vi.spyOn(fakeBrowser.runtime.onConnect, "addListener");
  startBackground();
  const stray = fakePort({
    tab: { id: 7 },
    frameId: 0,
    documentId: "doc-7",
    origin: "https://app.example",
  });
  const other = { ...fakePort(), name: "another-port" };
  for (const [listener] of added.mock.calls) {
    listener(stray as unknown as Browser.runtime.Port);
    listener(other as unknown as Browser.runtime.Port);
  }
  expect([stray.disconnected, other.disconnected]).toEqual([true, false]);
});

test("answers a relay with the URLs kept for its frame's origin in the open session", async () => {
  startBackground();
  const origin = "https://app.example";
  const pairs = [[`${origin}/a`, `${origin}/a?via=redirect`]] satisfies [string, string][];
  const managed = { generation: 3, windowId: 4, tabId: 40, status: "active" as const };
  await managedWindowRepository.update(() => managed);
  await responseUrlStore.write(3, { [origin]: pairs });
  const relay = { ...contentScript, url: `${origin}/`, origin, tab: { id: 40, incognito: true } };
  expect(await deliver({ type: "response-urls" }, relay)).toEqual({ ok: true, result: pairs });
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
