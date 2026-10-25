import type { RecordingSession } from "@recnrun/domain";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import type { SessionStore } from "@/background/session-requests";
import type { BackgroundReply } from "@/messaging/background-messages";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";

const EXTENSION_URL = "chrome-extension://own-id/";
const identity = { extensionId: "own-id", extensionUrl: EXTENSION_URL };
const ownPage = { id: "own-id", url: `${EXTENSION_URL}dashboard.html` };
const contentScript = { id: "own-id", url: "https://recnrun.com/" };

function memoryStore(initial: RecordingSession | null = null, unreadable = false): SessionStore {
  let session = initial;
  return {
    read: async () => {
      if (unreadable) throw new Error("Stored session is invalid");
      return session;
    },
    write: async (next) => {
      session = next;
    },
  };
}

interface Sender {
  id?: string;
  url?: string;
  tab?: { id?: number };
}

function listen(message: unknown, sender: Sender, store = memoryStore()) {
  const routes = createRoutes({ extensionVersion: "0.1.0", store });
  const replies: BackgroundReply[] = [];
  const listener = createBackgroundListener(routes, identity);
  const answered = listener(message, sender as never, (reply) => replies.push(reply));
  return { store, answered, replies };
}

async function activeTabId() {
  const [tab] = await fakeBrowser.tabs.query({ active: true });
  return tab?.id;
}

beforeEach(() => {
  fakeBrowser.reset();
});

describe("bridge requests", () => {
  test("answers ping from the content script and from its own pages", async () => {
    for (const sender of [contentScript, ownPage]) {
      const { answered, replies } = listen({ type: "ping" }, sender);
      expect(answered).toBe(true);
      await vi.waitFor(() =>
        expect(replies).toEqual([{ ok: true, result: { extensionVersion: "0.1.0" } }]),
      );
    }
  });

  test("ignores other extensions and unknown messages", () => {
    const ignored = [
      listen({ type: "ping" }, { id: "another-extension", url: "https://recnrun.com/" }),
      listen({ type: "ping" }, { url: "https://recnrun.com/" }),
      listen({ type: "deleteEverything" }, ownPage),
      listen("ping", ownPage),
    ];
    for (const { answered, replies } of ignored) {
      expect(answered).toBe(false);
      expect(replies).toEqual([]);
    }
  });
});

describe("session requests", () => {
  test("starts a session for the extension's own pages and replies once it runs", async () => {
    const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
    const { store, answered, replies } = listen(startSessionMessage(shop.id ?? -1), ownPage);
    expect(answered).toBe(true);
    await vi.waitFor(() => expect(replies).toEqual([{ ok: true }]));
    expect(await store.read()).toMatchObject({ tabId: shop.id });
    expect(await activeTabId()).toBe(shop.id);
  });

  test("refuses content scripts, other extensions, and invalid requests", async () => {
    const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
    const request = startSessionMessage(shop.id ?? -1);
    const ignored = [
      listen(request, contentScript),
      listen(request, { id: "own-id" }),
      listen(request, { id: "other-id", url: ownPage.url }),
      listen({ type: "start-session", tabId: -1 }, ownPage),
      listen({ type: "open-dashboard" }, ownPage),
      listen(returnToDashboardMessage(), { ...contentScript, tab: { id: shop.id } }),
    ];
    await new Promise((resolve) => setTimeout(resolve, 10));
    for (const { store, answered, replies } of ignored) {
      expect(answered).toBe(false);
      expect(replies).toEqual([]);
      expect(await store.read()).toBeNull();
    }
  });

  test("an unreadable stored session is an error reply", async () => {
    const shop = await fakeBrowser.tabs.create({ url: "https://shop.example/" });
    const request = startSessionMessage(shop.id ?? -1);
    const { replies } = listen(request, ownPage, memoryStore(null, true));
    await vi.waitFor(() =>
      expect(replies).toEqual([{ ok: false, error: "Stored session is invalid" }]),
    );
  });

  test("a tab that closed meanwhile is an error reply, and no session", async () => {
    const { store, replies } = listen(startSessionMessage(999), ownPage);
    await vi.waitFor(() => expect(replies).toHaveLength(1));
    expect(await store.read()).toBeNull();
    expect(replies).toEqual([{ ok: false, error: "The tab to record was closed." }]);
  });

  test("gives the focus back to the tab framing the dashboard that asks", async () => {
    const site = await fakeBrowser.tabs.create({ url: "https://recnrun.com/" });
    await fakeBrowser.tabs.create({ url: "https://shop.example/", active: true });
    const { replies } = listen(returnToDashboardMessage(), { ...ownPage, tab: { id: site.id } });
    await vi.waitFor(() => expect(replies).toEqual([{ ok: true }]));
    expect(await activeTabId()).toBe(site.id);
    const noTab = listen(returnToDashboardMessage(), ownPage);
    await vi.waitFor(() => expect(noTab.replies).toEqual([{ ok: true }]));
  });
});
