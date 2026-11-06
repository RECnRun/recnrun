import { beforeEach, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { startBackground } from "@/background/start";
import { recordingSessionRepository } from "@/storage/recording-session-repository";

// The POC's own wiring has its own tests; here only its route and its start-up count.
const peers = vi.hoisted(() => ({ request: vi.fn(async () => "peer reply"), link: vi.fn() }));
const started = vi.hoisted(() => ({
  peers: vi.fn(() => peers),
  publisher: vi.fn(),
  relay: vi.fn(),
}));
vi.mock("@/background/peers", () => ({ startPeers: started.peers }));
vi.mock("@/background/downloads-publisher", () => ({ startDownloadsPublisher: started.publisher }));
vi.mock("@/background/poc-file-read", () => ({ startPocFileReadRelay: started.relay }));

/** The module read again under another build mode, as WXT builds it. */
async function startIn(mode: string) {
  vi.stubEnv("MODE", mode);
  vi.resetModules();
  const start = await import("@/background/start");
  start.startBackground();
}

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
  vi.unstubAllEnvs();
  started.peers.mockClear();
  started.publisher.mockClear();
  started.relay.mockClear();
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

test.each(["poc-d0", "poc-d1", "poc-d2"])(
  "starts the mesh, the Downloads publisher, and the file-read relay in the %s build",
  async (mode) => {
    await startIn(mode);
    expect(started.peers).toHaveBeenCalledTimes(1);
    expect(started.publisher).toHaveBeenCalledTimes(1);
    expect(started.relay).toHaveBeenCalledTimes(1);
    expect(await deliver({ type: "peer", request: { type: "status" } }, ownPage)).toEqual({
      ok: true,
      result: "peer reply",
    });
  },
);

test.each(["poc-d0", "poc-d1", "poc-d2"])(
  "starts the %s peers on Downloads silently: no dashboard on install, start-up, or a new window",
  async (mode) => {
    await startIn(mode);
    expect(started.peers).toHaveBeenCalledWith({ transport: "downloads" });
    const url = fakeBrowser.runtime.getURL("/dashboard.html");
    const dashboards = async () =>
      (await fakeBrowser.tabs.query({})).filter((each) => each.url === url);

    await fakeBrowser.runtime.onInstalled.trigger({ reason: "install" });
    await fakeBrowser.runtime.onStartup.trigger();
    const window = await fakeBrowser.windows.create({});
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await dashboards()).toEqual([]);

    // The toolbar icon still opens it.
    await fakeBrowser.action.onClicked.trigger({ windowId: window?.id, incognito: false } as never);
    await vi.waitFor(async () => expect(await dashboards()).toHaveLength(1));
  },
);

test("starts the mesh but no POC wiring in a test build", async () => {
  await startIn("test");
  expect(started.peers).toHaveBeenCalledTimes(1);
  expect(started.peers).toHaveBeenCalledWith({ transport: "folder" });
  expect(started.publisher).not.toHaveBeenCalled();
  expect(started.relay).not.toHaveBeenCalled();
});

test("starts neither the mesh nor the POC wiring in a production build", async () => {
  await startIn("production");
  expect(started.peers).not.toHaveBeenCalled();
  expect(started.publisher).not.toHaveBeenCalled();
  expect(started.relay).not.toHaveBeenCalled();
  expect(await deliver({ type: "ping" }, contentScript)).toEqual({
    ok: true,
    result: { extensionVersion: "0.1.0" },
  });
});
