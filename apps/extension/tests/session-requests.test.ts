import type { RecordingSession } from "@recnrun/domain";
import { beforeEach, expect, test } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createSessionListener, startSession } from "@/background/session-requests";
import type { SessionStore } from "@/background/session-requests";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import type { SessionReply } from "@/messaging/session-protocol";

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

test("leaves an unreadable session as it is and reports it", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const store = memoryStore(null, true);
  await expect(startSession(shop.id ?? -1, store, 5)).rejects.toThrow("Stored session is invalid");
  await expect(store.read()).rejects.toThrow("Stored session is invalid");
});

function listen(
  message: unknown,
  sender: { id?: string; url?: string; tab?: { id?: number } },
  store = memoryStore(),
) {
  const replies: SessionReply[] = [];
  const listener = createSessionListener(store, EXTENSION_URL);
  const answered = listener(message, sender as never, (reply) => replies.push(reply));
  return { store, answered, replies };
}

const ownPage = { id: fakeBrowser.runtime.id, url: `${EXTENSION_URL}dashboard.html` };

test("starts a session for the extension's own pages and replies once it runs", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const { store, answered, replies } = listen(startSessionMessage(shop.id ?? -1), ownPage);
  expect(answered).toBe(true);
  await expect.poll(() => replies).toEqual([{ ok: true }]);
  expect(await store.read()).toMatchObject({ tabId: shop.id });
});

test("an unreadable stored session is an error reply", async () => {
  const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
  const request = startSessionMessage(shop.id ?? -1);
  const { replies } = listen(request, ownPage, memoryStore(null, true));
  await expect.poll(() => replies).toEqual([{ ok: false, error: "Stored session is invalid" }]);
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
  for (const { store, answered, replies } of ignored) {
    expect(answered).toBe(false);
    expect(replies).toEqual([]);
    expect(await store.read()).toBeNull();
  }
});

test("gives the focus back to the tab framing the dashboard that asks", async () => {
  const site = await fakeBrowser.tabs.create({ url: "https://recnrun.com/" });
  await fakeBrowser.tabs.create({ url: "https://shop.example/", active: true });
  const { replies } = listen(returnToDashboardMessage(), { ...ownPage, tab: { id: site.id } });
  await expect.poll(activeTabId).toBe(site.id);
  await expect.poll(() => replies).toEqual([{ ok: true }]);
  const noTab = listen(returnToDashboardMessage(), ownPage);
  await expect.poll(() => noTab.replies).toEqual([{ ok: true }]);
});

test("a tab that closed meanwhile is an error reply, and no session", async () => {
  const { store, answered, replies } = listen(startSessionMessage(999), ownPage);
  expect(answered).toBe(true);
  await expect.poll(() => replies.length).toBe(1);
  expect(await store.read()).toBeNull();
  expect(replies).toEqual([{ ok: false, error: "The tab to record was closed." }]);
});
