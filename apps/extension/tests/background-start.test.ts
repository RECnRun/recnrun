import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startBackground } from "@/background/start";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

// The POC's own wiring has its own tests; here only its route counts.
const peers = vi.hoisted(() => ({ request: vi.fn(async () => "peer reply"), link: vi.fn() }));
vi.mock("@/background/peers", () => ({ startPeers: () => peers }));

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
  expect(await deliver({ type: "ping" }, contentScript)).toEqual({
    ok: true,
    result: { extensionVersion: "0.1.0" },
  });
  expect(await deliver({ type: "start-session", tabId: shop.id }, ownPage)).toEqual({ ok: true });
  expect(await recordingSessionRepository.read()).toMatchObject({ tabId: shop.id });
});

test("keeps one dashboard in front on install, start-up, a new window, and the toolbar icon", async () => {
  startBackground();
  const url = fakeBrowser.runtime.getURL("/dashboard.html");
  const dashboards = async () =>
    (await fakeBrowser.tabs.query({})).filter((each) => each.url === url);
  const focused = vi.spyOn(fakeBrowser.tabs, "update");

  await fakeBrowser.runtime.onInstalled.trigger({ reason: "install" });
  await vi.waitFor(async () => expect(await dashboards()).toHaveLength(1));
  const [dashboard] = await dashboards();
  await fakeBrowser.runtime.onStartup.trigger();
  await fakeBrowser.windows.create({});
  if (dashboard) await fakeBrowser.action.onClicked.trigger(dashboard);

  await vi.waitFor(() => expect(focused).toHaveBeenCalledTimes(3));
  expect(await dashboards()).toHaveLength(1);
});

test("routes the cross-profile POC's page requests in a test build", async () => {
  startBackground();
  expect(await deliver({ type: "peer", request: { type: "status" } }, ownPage)).toEqual({
    ok: true,
    result: "peer reply",
  });
  expect(peers.request).toHaveBeenCalledWith({ type: "status" });
});
