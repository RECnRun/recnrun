import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { createBackgroundListener } from "@/background/listener";
import { createRoutes } from "@/background/routes";
import type { BackgroundReply } from "@/messaging/background-reply";
import { linkEventMessage, peerRequestMessage } from "@/messaging/peer-messages";
import { returnToDashboardMessage, startSessionMessage } from "@/messaging/session-protocol";
import { memoryRecordingStore } from "./fake-extension";
import { PEER } from "./fake-peer";

const EXTENSION_URL = "chrome-extension://own-id/";
const identity = { extensionId: "own-id", extensionUrl: EXTENSION_URL };
const ownPage = { id: "own-id", url: `${EXTENSION_URL}dashboard.html` };
const contentScript = { id: "own-id", url: "https://recnrun.com/" };
type RouteDependencies = Pick<Parameters<typeof createRoutes>[0], "showDashboard" | "peers">;

const offscreen = { id: "own-id", url: `${EXTENSION_URL}offscreen.html` };

interface Sender {
  id?: string;
  url?: string;
  tab?: { id?: number; windowId?: number; incognito?: boolean };
}

function listen(
  message: unknown,
  sender: Sender,
  store = memoryRecordingStore(),
  { showDashboard = async () => {}, peers }: Partial<RouteDependencies> = {},
) {
  const routes = createRoutes({ extensionVersion: "0.1.0", store, showDashboard, peers });
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

  test("brings the dashboard forward for the site, from the site tab's window", async () => {
    const shown: unknown[] = [];
    const show = async (from?: { windowId: number; incognito: boolean }) => {
      shown.push(from);
    };
    const siteTab = { ...contentScript, tab: { id: 3, windowId: 2, incognito: false } };
    const { answered, replies } = listen({ type: "open-dashboard" }, siteTab, undefined, {
      showDashboard: show,
    });
    expect(answered).toBe(true);
    await vi.waitFor(() => expect(replies).toEqual([{ ok: true, result: {} }]));
    expect(shown).toEqual([{ windowId: 2, incognito: false }]);

    const untabbed = listen({ type: "open-dashboard" }, contentScript, undefined, {
      showDashboard: show,
    });
    await vi.waitFor(() => expect(untabbed.replies).toEqual([{ ok: true, result: {} }]));
    expect(shown).toEqual([{ windowId: 2, incognito: false }, undefined]);
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
    const { replies } = listen(request, ownPage, memoryRecordingStore(null, true));
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

describe("cross-profile messages", () => {
  const status = peerRequestMessage({ type: "status" });
  const connecting = linkEventMessage({ type: "state", peer: PEER, state: "connecting" });
  const fakePeers = () => ({
    request: vi.fn(async () => "status"),
    link: vi.fn(async () => {}),
  });

  test("routes a page's peer request and the offscreen document's link event", async () => {
    const peers = fakePeers();
    const request = listen(status, ownPage, memoryRecordingStore(), { peers });
    const event = listen(connecting, offscreen, memoryRecordingStore(), { peers });
    await vi.waitFor(() => expect(request.replies).toEqual([{ ok: true, result: "status" }]));
    await vi.waitFor(() => expect(event.replies).toEqual([{ ok: true }]));
    expect(peers.request).toHaveBeenCalledWith({ type: "status" });
    expect(peers.link).toHaveBeenCalledWith({ type: "state", peer: PEER, state: "connecting" });
  });

  test("takes link events only from the offscreen document, and peer requests only from pages", async () => {
    const peers = fakePeers();
    const ignored = [
      listen(connecting, ownPage, memoryRecordingStore(), { peers }),
      listen(connecting, contentScript, memoryRecordingStore(), { peers }),
      listen(connecting, { ...offscreen, id: "other-id" }, memoryRecordingStore(), { peers }),
      listen(status, offscreen, memoryRecordingStore(), { peers }),
      listen(status, contentScript, memoryRecordingStore(), { peers }),
    ];
    for (const { answered, replies } of ignored) {
      expect(answered).toBe(false);
      expect(replies).toEqual([]);
    }
    expect(peers.request).not.toHaveBeenCalled();
    expect(peers.link).not.toHaveBeenCalled();
  });

  test("answers both with an error in a build without the link", async () => {
    const off = { ok: false, error: "This build has no cross-profile link." };
    const request = listen(status, ownPage);
    const event = listen(connecting, offscreen);
    await vi.waitFor(() => expect(request.replies).toEqual([off]));
    await vi.waitFor(() => expect(event.replies).toEqual([off]));
  });
});
