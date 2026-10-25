import type { RecordingSession } from "@recnrun/domain";
import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { execute, sessionStatus, sharedTabs } from "@/background/executor";
import type { ExecutorDependencies } from "@/background/executor";
import type { BrowserTabs, OpenTab } from "@/ports/tabs";
import { memoryRecordingStore } from "./fake-extension";
import { PEER, STRANGER, fromPeer, memoryRepository, recordingChannel } from "./fake-peer";
import { PRIVATE } from "./fake-tabs";

const TAB_CLOSED = "That tab is not open anymore.";

const running = (tabId: number, status: RecordingSession["status"] = "recording") => ({
  tabId,
  status,
  banked: 0,
  since: 1,
});

/** A normal tab open in the fake browser, with the favicon Chrome would report for it. */
async function openTab(url: string): Promise<OpenTab> {
  const tab = await fakeBrowser.tabs.create({ url });
  const id = tab.id ?? -1;
  return { id, windowId: 0, incognito: false, title: url, url, favicon: `${url}favicon.ico` };
}

function executor(tabs: BrowserTabs, session: RecordingSession | null = null, controller?: string) {
  const { channel, sent } = recordingChannel();
  const deps: ExecutorDependencies = {
    channel,
    session: memoryRecordingStore(session),
    controller: memoryRepository(controller ? { profileId: controller } : null),
    tabs: async () => tabs,
  };
  const results = () => sent.filter((each) => each.type === "COMMAND_RESULT");
  return { deps, sent, results };
}

async function activeTabId() {
  const [tab] = await fakeBrowser.tabs.query({ active: true });
  return tab?.id;
}

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("what the executor shares", () => {
  test("never shares incognito tabs or favicons", async () => {
    const shop = await openTab("https://shop.example/");
    const shared = await sharedTabs(async () => ({ tabs: [shop, PRIVATE], currentId: shop.id }));
    const { favicon: _favicon, ...withoutFavicon } = shop;
    expect(shared).toEqual({ tabs: [withoutFavicon], currentId: shop.id });
  });

  test("leaves out the current tab when it is incognito or there is none", async () => {
    const shop = await openTab("https://shop.example/");
    const privateCurrent = await sharedTabs(async () => ({
      tabs: [shop, PRIVATE],
      currentId: PRIVATE.id,
    }));
    expect(privateCurrent).not.toHaveProperty("currentId");
    expect(await sharedTabs(async () => ({ tabs: [shop] }))).not.toHaveProperty("currentId");
  });

  test("names the controller only while a session runs", async () => {
    const idle = executor({ tabs: [] }, null, PEER);
    expect(await sessionStatus(idle.deps)).toEqual({ session: null, controlledBy: null });
    expect(idle.deps.controller.read).not.toHaveBeenCalled();
    const remote = executor({ tabs: [] }, running(4), PEER);
    expect(await sessionStatus(remote.deps)).toEqual({ session: running(4), controlledBy: PEER });
    const local = executor({ tabs: [] }, running(4));
    expect(await sessionStatus(local.deps)).toEqual({ session: running(4), controlledBy: null });
  });
});

describe("queries", () => {
  test("answers PING, GET_TABS, and HELLO, each naming the request", async () => {
    const shop = await openTab("https://shop.example/");
    const { deps, sent } = executor({ tabs: [shop, PRIVATE] }, running(shop.id), PEER);
    const ping = fromPeer("PING", { timestamp: 1 });
    const getTabs = fromPeer("GET_TABS", {});
    const hello = fromPeer("HELLO", { displayName: "Desk", extensionVersion: "0.1.0" });
    for (const message of [ping, getTabs, hello]) await execute(message, deps);
    expect(sent).toEqual([
      { type: "PONG", payload: { requestId: ping.id, timestamp: expect.any(Number) } },
      {
        type: "TABS_SNAPSHOT",
        payload: { requestId: getTabs.id, tabs: [expect.objectContaining({ id: shop.id })] },
      },
      {
        type: "SESSION_STATUS",
        payload: { requestId: hello.id, session: running(shop.id), controlledBy: PEER },
      },
    ]);
  });

  test("ignores reports, which are the controller's to observe", async () => {
    const { deps, sent } = executor({ tabs: [] });
    await execute(fromPeer("TABS_CHANGED", { tabs: [] }), deps);
    await execute(fromPeer("ERROR", { reason: "Invalid message." }), deps);
    expect(sent).toEqual([]);
  });
});

describe("tab commands", () => {
  test("activates a shared tab", async () => {
    const shop = await openTab("https://shop.example/");
    await fakeBrowser.tabs.create({ url: "https://recnrun.com/", active: true });
    const { deps, results } = executor({ tabs: [shop] });
    const command = fromPeer("ACTIVATE_TAB", { tabId: shop.id });
    await execute(command, deps);
    expect(results()).toEqual([
      { type: "COMMAND_RESULT", payload: { requestId: command.id, ok: true } },
    ]);
    expect(await activeTabId()).toBe(shop.id);
  });

  test("refuses to activate an incognito tab, as if it were closed", async () => {
    const { deps, results } = executor({ tabs: [PRIVATE] });
    await execute(fromPeer("ACTIVATE_TAB", { tabId: PRIVATE.id }), deps);
    expect(results()[0]?.payload).toMatchObject({ ok: false, reason: TAB_CLOSED });
    expect(await activeTabId()).toBeUndefined();
  });
});

describe("starting a session", () => {
  test("records a shared tab and marks the peer as its controller", async () => {
    const shop = await openTab("https://shop.example/");
    const { deps, results } = executor({ tabs: [shop] });
    await execute(fromPeer("SESSION_START", { tabId: shop.id }), deps);
    expect(results()[0]?.payload).toMatchObject({ ok: true });
    expect(await deps.session.read()).toMatchObject({ tabId: shop.id, status: "recording" });
    expect(await deps.controller.read()).toEqual({ profileId: PEER });
  });

  test("continues the session the same peer started on that tab", async () => {
    const shop = await openTab("https://shop.example/");
    const session = running(shop.id, "paused");
    const { deps, results } = executor({ tabs: [shop] }, session, PEER);
    await execute(fromPeer("SESSION_START", { tabId: shop.id }), deps);
    expect(results()[0]?.payload).toMatchObject({ ok: true });
    expect(await deps.session.read()).toEqual(session);
  });

  test("refuses while this profile's user or another peer runs a session", async () => {
    const shop = await openTab("https://shop.example/");
    for (const controller of [undefined, STRANGER]) {
      const { deps, results } = executor({ tabs: [shop] }, running(shop.id), controller);
      await execute(fromPeer("SESSION_START", { tabId: shop.id }), deps);
      expect(results()[0]?.payload).toMatchObject({
        ok: false,
        reason: "A session already runs in that profile.",
      });
      expect(await deps.controller.read()).toEqual(controller ? { profileId: controller } : null);
    }
  });

  test("refuses another tab than the one the peer's session records", async () => {
    const shop = await openTab("https://shop.example/");
    const docs = await openTab("https://docs.example/");
    const { deps, results } = executor({ tabs: [shop, docs] }, running(shop.id), PEER);
    await execute(fromPeer("SESSION_START", { tabId: docs.id }), deps);
    expect(results()[0]?.payload).toMatchObject({
      ok: false,
      reason: "That profile records another tab.",
    });
  });

  test("refuses a tab it does not share, and marks no controller", async () => {
    const { deps, results } = executor({ tabs: [PRIVATE] });
    await execute(fromPeer("SESSION_START", { tabId: PRIVATE.id }), deps);
    expect(results()[0]?.payload).toMatchObject({ ok: false, reason: TAB_CLOSED });
    expect(await deps.session.read()).toBeNull();
    expect(deps.controller.write).not.toHaveBeenCalled();
  });

  test("takes the marker back when the tab closed before the session started", async () => {
    const listed: OpenTab = { ...PRIVATE, id: 404, incognito: false };
    const { deps, results } = executor({ tabs: [listed] });
    await execute(fromPeer("SESSION_START", { tabId: listed.id }), deps);
    expect(results()[0]?.payload).toMatchObject({
      ok: false,
      reason: "The tab to record was closed.",
    });
    expect(deps.controller.write).toHaveBeenLastCalledWith(null);
    expect(await deps.session.read()).toBeNull();
  });
});

test("keeps the marker of a continued session when its tab cannot get the focus", async () => {
  const shop = await openTab("https://shop.example/");
  vi.spyOn(fakeBrowser.tabs, "update").mockRejectedValue(new Error("No tab with id: 1."));
  const { deps, results } = executor({ tabs: [shop] }, running(shop.id), PEER);
  await execute(fromPeer("SESSION_START", { tabId: shop.id }), deps);
  expect(results()[0]?.payload).toMatchObject({ ok: false, reason: "No tab with id: 1." });
  expect(await deps.controller.read()).toEqual({ profileId: PEER });
});

describe("changing the session", () => {
  test("pauses and resumes only when the status differs", async () => {
    const { deps, results } = executor({ tabs: [] }, running(4), PEER);
    await execute(fromPeer("SESSION_SET_STATUS", { status: "recording" }), deps);
    expect(await deps.session.read()).toEqual(running(4));
    await execute(fromPeer("SESSION_SET_STATUS", { status: "paused" }), deps);
    expect(await deps.session.read()).toMatchObject({ tabId: 4, status: "paused" });
    expect(results().map((each) => each.payload)).toMatchObject([{ ok: true }, { ok: true }]);
  });

  test("stops the session and clears the controller marker", async () => {
    const { deps, results } = executor({ tabs: [] }, running(4), PEER);
    await execute(fromPeer("SESSION_STOP", {}), deps);
    expect(results()[0]?.payload).toMatchObject({ ok: true });
    expect(await deps.session.read()).toBeNull();
    expect(await deps.controller.read()).toBeNull();
  });

  test("refuses without a session, or for a session it does not control", async () => {
    const none = executor({ tabs: [] });
    await execute(fromPeer("SESSION_STOP", {}), none.deps);
    expect(none.results()[0]?.payload).toMatchObject({
      ok: false,
      reason: "No session runs in that profile.",
    });
    for (const controller of [undefined, STRANGER]) {
      const other = executor({ tabs: [] }, running(4), controller);
      await execute(fromPeer("SESSION_SET_STATUS", { status: "paused" }), other.deps);
      expect(other.results()[0]?.payload).toMatchObject({
        ok: false,
        reason: "That session is controlled in its own profile.",
      });
      expect(await other.deps.session.read()).toEqual(running(4));
    }
  });

  test("answers a failure with its message, cut to what the protocol carries", async () => {
    const { deps, results } = executor({ tabs: [] }, running(4), PEER);
    vi.mocked(deps.controller.read).mockRejectedValue(new Error("x".repeat(300)));
    await execute(fromPeer("SESSION_STOP", {}), deps);
    expect(results()[0]?.payload).toMatchObject({ ok: false, reason: "x".repeat(200) });
  });
});
