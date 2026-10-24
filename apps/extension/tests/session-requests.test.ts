import type { RecordingSession } from "@recnrun/domain";
import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createSessionListener, endSessionOf, startSession } from "@/background/session-requests";
import type { SessionStore } from "@/background/session-requests";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";

const EXTENSION_URL = "chrome-extension://own-id/";

function memoryStore(initial: RecordingSession | null = null, unreadable = false): SessionStore {
  let session = initial;
  let broken = unreadable;
  return {
    read: async () => {
      if (broken) throw new Error("Stored session is invalid");
      return session;
    },
    write: async (next) => {
      broken = false;
      session = next;
    },
  };
}

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
  const store = memoryStore();
  await startSession(shop.id ?? -1, store, 5);
  expect(await store.read()).toEqual({ tabId: shop.id, status: "recording", banked: 0, since: 5 });
  expect(await activeTabId()).toBe(shop.id);
});

test("keeps the running session and focuses the tab it records", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const docs = await fakeBrowser.tabs.create({ url: "https://docs.example/", active: true });
  const session = { ...running(shop.id ?? -1), status: "paused" as const, banked: 42 };
  const store = memoryStore(session);
  await startSession(docs.id ?? -1, store);
  expect(await store.read()).toEqual(session);
  expect(await activeTabId()).toBe(shop.id);
});

test("replaces an unreadable session with a new one", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const store = memoryStore(null, true);
  await startSession(shop.id ?? -1, store, 5);
  expect(await store.read()).toMatchObject({ tabId: shop.id, status: "recording" });
});

test("ends the session only when the tab it records closes", async () => {
  const store = memoryStore(running(7));
  await endSessionOf(8, store);
  expect(await store.read()).toEqual(running(7));
  await endSessionOf(7, store);
  expect(await store.read()).toBeNull();
  await expect(endSessionOf(7, memoryStore(null, true))).resolves.toBeUndefined();
});

function listen(message: unknown, sender: { id?: string; url?: string; tab?: { id?: number } }) {
  const store = memoryStore();
  const listener = createSessionListener(store, EXTENSION_URL);
  const answered = listener(message, sender as never);
  return { store, answered };
}

const ownPage = { id: fakeBrowser.runtime.id, url: `${EXTENSION_URL}dashboard.html` };

test("starts a session for the extension's own pages, replying nothing", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const { store, answered } = listen(startSessionMessage(shop.id ?? -1), ownPage);
  expect(answered).toBe(false);
  await expect.poll(() => store.read()).toMatchObject({ tabId: shop.id });
});

test("ignores content scripts, other extensions, and invalid requests", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const request = startSessionMessage(shop.id ?? -1);
  const senders = [
    { id: fakeBrowser.runtime.id, url: "https://recnrun.com/" },
    { id: fakeBrowser.runtime.id },
    { id: "other-id", url: ownPage.url },
  ];
  const ignored = [
    ...senders.map((sender) => listen(request, sender)),
    listen({ type: "start-session", tabId: -1 }, ownPage),
    listen({ type: "open-dashboard" }, ownPage),
  ];
  await new Promise((resolve) => setTimeout(resolve, 10));
  for (const { store, answered } of ignored) {
    expect(answered).toBe(false);
    expect(await store.read()).toBeNull();
  }
});

test("gives the focus back to the tab framing the dashboard that asks", async () => {
  const site = await fakeBrowser.tabs.create({ url: "https://recnrun.com/" });
  await fakeBrowser.tabs.create({ url: "https://shop.example/", active: true });
  listen(returnToDashboardMessage(), { ...ownPage, tab: { id: site.id } });
  await expect.poll(activeTabId).toBe(site.id);
  expect(listen(returnToDashboardMessage(), ownPage).answered).toBe(false);
});

test("a tab that closed meanwhile fails quietly", async () => {
  const { answered } = listen(startSessionMessage(999), ownPage);
  expect(answered).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 10));
});
