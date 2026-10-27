import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { NOT_CONNECTED } from "@/background/peer-channel";
import { startPeers } from "@/background/peers";
import {
  authorizedPeersRepository,
  folderPairingRepository,
  identityRepository,
  peerLinksRepository,
  pendingOffersRepository,
  remoteRecordingsRepository,
} from "@/storage/peer-repository";
import { FINGERPRINT, ME, PEER, STRANGER, fromPeer } from "./fake-peer";
import { peerBackground, tappedFrames } from "./peer-background";

const session = { tabId: 4, status: "recording" as const, banked: 0, since: 1 };
const MISMATCH = { state: "failed", verified: false, reason: "certificate" };

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a new link", () => {
  test("closes a link whose certificate is not the accepted one, and never verifies it", async () => {
    const { connect, link } = await peerBackground();
    for (const fingerprint of ["00:11:22", null]) {
      await connect(fingerprint);
      expect(await peerLinksRepository.get(PEER)).toEqual(MISMATCH);
    }
    expect(link.commands).toEqual([
      { type: "close", peer: PEER },
      { type: "close", peer: PEER },
    ]);
    expect(link.sentTypes()).toEqual([]);
  });

  test("closes any link before a peer is authorized", async () => {
    const { connect, link } = await peerBackground({ authorized: false });
    await connect();
    expect(await peerLinksRepository.get(PEER)).toEqual(MISMATCH);
    expect(link.commands).toEqual([{ type: "close", peer: PEER }]);
  });

  test("verifies the accepted certificate, ends the folder's wait, and introduces this profile", async () => {
    const { connect, link } = await peerBackground();
    const pairingId = "44444444-4444-4444-8444-444444444444";
    await folderPairingRepository.write({ acted: { pairingId, at: 5 } });
    await connect();
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
    expect(await folderPairingRepository.read()).toEqual({ acted: { pairingId, at: 0 } });
    expect(link.frames()).toEqual([
      expect.objectContaining({
        type: "HELLO",
        from: ME,
        to: PEER,
        displayName: "Laptop",
        extensionVersion: "0.1.0",
      }),
    ]);
    expect(link.notices).toContainEqual({ target: "pages", type: "peer-changed" });
    expect(tappedFrames()).toHaveLength(1);
  });

  test("stores a connecting link as unverified and tells the pages", async () => {
    const { routes, link } = await peerBackground();
    await routes.link({ type: "state", peer: PEER, state: "connecting" });
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connecting", verified: false });
    expect(link.notices).toHaveLength(1);
  });
});

describe("frames", () => {
  test("executes what the verified peer asks, and keeps each frame in the tap", async () => {
    const { connect, receive, link } = await peerBackground();
    await connect();
    const ask = fromPeer("GET_TABS", {});
    await receive(ask);
    expect(link.frames().at(-1)).toMatchObject({ type: "TABS_SNAPSHOT", requestId: ask.id });
    expect(tappedFrames()).toContain(JSON.stringify(ask));
  });

  test("drops a frame from an unauthorized profile without an answer", async () => {
    const { connect, receive, link } = await peerBackground();
    await connect();
    await receive(fromPeer("GET_TABS", {}, STRANGER));
    expect(link.sentTypes()).toEqual(["HELLO"]);
  });

  test("tells only a verified peer that a frame was invalid", async () => {
    const { connect, receive, link } = await peerBackground();
    await receive("not json");
    expect(link.sentTypes()).toEqual([]);
    await connect();
    await receive("not json");
    expect(link.frames().at(-1)).toMatchObject({ type: "ERROR", reason: "Invalid message." });
  });
});

describe("a link that went down", () => {
  test("fails pending requests and keeps the session copy, marked disconnected", async () => {
    const { routes, connect, link } = await peerBackground();
    await connect();
    const copy = { profileId: PEER, session, mine: true, connected: true };
    await remoteRecordingsRepository.set(PEER, copy);
    const pending = routes.request({ type: "tabs" });
    await vi.waitFor(() => expect(link.sentTypes()).toContain("GET_TABS"));
    await routes.link({ type: "state", peer: PEER, state: "disconnected" });
    await expect(pending).rejects.toThrow(NOT_CONNECTED);
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "disconnected", verified: false });
    expect(await remoteRecordingsRepository.get(PEER)).toEqual({ ...copy, connected: false });
  });

  test("writes no copy when there was none, or when it is unreadable", async () => {
    const { routes } = await peerBackground();
    await routes.link({ type: "state", peer: PEER, state: "failed" });
    expect(await remoteRecordingsRepository.get(PEER)).toBeNull();
    await fakeBrowser.storage.session.set({ remoteRecordings: "unreadable" });
    await routes.link({ type: "state", peer: PEER, state: "failed" });
    expect(await fakeBrowser.storage.session.get("remoteRecordings")).toEqual({
      remoteRecordings: "unreadable",
    });
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "failed", verified: false });
  });
});

describe("an intended close", () => {
  test("a BYE from the verified peer closes the link as closed by the peer, until it reconnects", async () => {
    const { routes, connect, receive, link } = await peerBackground();
    await connect();
    await receive(fromPeer("BYE", {}));
    const closed = { state: "disconnected", verified: false, reason: "closed-by-peer" };
    expect(await peerLinksRepository.get(PEER)).toEqual(closed);
    expect(link.commands.at(-1)).toEqual({ type: "close", peer: PEER });
    await routes.link({ type: "state", peer: PEER, state: "failed" });
    expect(await peerLinksRepository.get(PEER)).toEqual({ ...closed, state: "failed" });
    await routes.link({ type: "state", peer: PEER, state: "connecting" });
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connecting", verified: false });
  });

  test("a BYE keeps its reason when the channel's close arrives right behind it", async () => {
    const { routes, connect, receive } = await peerBackground();
    await connect();
    // The BYE's own read of the link is slow, as in a busy worker.
    const get = peerLinksRepository.get.bind(peerLinksRepository);
    vi.spyOn(peerLinksRepository, "get").mockImplementationOnce(async (peer) => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      return get(peer);
    });
    await Promise.all([
      receive(fromPeer("BYE", {})),
      routes.link({ type: "state", peer: PEER, state: "disconnected" }),
    ]);
    expect(await peerLinksRepository.get(PEER)).toEqual({
      state: "disconnected",
      verified: false,
      reason: "closed-by-peer",
    });
  });

  test.each(["disconnect", "forget"] as const)(
    "%s says BYE to the verified peer before closing, and marks the close as this profile's",
    async (type) => {
      const { routes, connect, link } = await peerBackground();
      await connect();
      await routes.request({ type });
      expect(link.sentTypes()).toEqual(["HELLO", "BYE"]);
      expect(link.commands.at(-1)).toEqual({ type: "close", peer: PEER });
      await routes.link({ type: "state", peer: PEER, state: "disconnected" });
      expect(await peerLinksRepository.get(PEER)).toEqual({
        state: "disconnected",
        verified: false,
        reason: "closed-here",
      });
    },
  );

  test("disconnect says nothing over a link that is not verified", async () => {
    const { routes, link } = await peerBackground();
    await routes.request({ type: "disconnect" });
    expect(link.sentTypes()).toEqual([]);
    expect(link.commands).toEqual([{ type: "folder-stop" }, { type: "close", peer: PEER }]);
  });
});

describe("the peer's tabs", () => {
  test("are kept in session storage, so a worker that wakes again still lists them", async () => {
    const tab = { id: 3, windowId: 1, incognito: false as const, title: "Shop", url: "https://s/" };
    const { routes, connect, receive } = await peerBackground();
    await connect();
    await receive(fromPeer("TABS_CHANGED", { tabs: [tab], currentId: 3 }));
    await routes.link({ type: "state", peer: PEER, state: "disconnected" });
    // A worker that slept starts again with nothing in memory and the same storage.
    const woken = startPeers();
    expect(await woken.request({ type: "tabs" })).toEqual({ tabs: [tab], currentId: 3 });
    // A new link starts from the peer's next report.
    await connect();
    await receive(fromPeer("HELLO", { displayName: "Desk", extensionVersion: "0.1.0" }));
    expect(await fakeBrowser.storage.session.get("peerTabs")).toEqual({ peerTabs: {} });
  });
});

describe("page requests", () => {
  test("reports the status and renames this profile, telling the verified peer", async () => {
    const { routes, connect, link } = await peerBackground();
    await connect();
    expect(await routes.request({ type: "status" })).toMatchObject({
      identity: { profileId: ME, displayName: "Laptop" },
      peer: { profileId: PEER },
      link: { state: "connected", verified: true },
    });
    await routes.request({ type: "rename", displayName: "Studio" });
    expect(await identityRepository.read()).toEqual({ profileId: ME, displayName: "Studio" });
    expect(link.frames().at(-1)).toMatchObject({ type: "HELLO", displayName: "Studio" });
  });
});

describe("the folder", () => {
  const presence = {
    profileId: PEER,
    displayName: "Desk",
    fingerprint: FINGERPRINT,
    createdAt: 1,
    expiresAt: Date.now() + 60_000,
  };

  test("waits in the folder again when the worker starts, if it waited before", async () => {
    await folderPairingRepository.write({});
    const { link } = await peerBackground();
    // Chrome starts the worker as the browser starts only for a startup listener.
    expect(fakeBrowser.runtime.onStartup.hasListeners()).toBe(true);
    await vi.waitFor(() =>
      expect(link.commands).toContainEqual({
        type: "folder-watch",
        profileId: ME,
        displayName: "Laptop",
      }),
    );
  });

  test("tells the pages when this profile starts waiting in the folder, until it forgets", async () => {
    const { routes, link } = await peerBackground();
    await routes.request({ type: "folder-pair" });
    expect(await folderPairingRepository.read()).toEqual({});
    expect(link.notices).toEqual([{ target: "pages", type: "peer-changed" }]);
    await routes.request({ type: "forget" });
    expect(await folderPairingRepository.read()).toBeNull();
    expect(link.commands).toContainEqual({ type: "folder-stop" });
  });

  test("stops waiting in the folder when the user disconnects, so nothing reconnects", async () => {
    const { routes, link } = await peerBackground();
    await routes.request({ type: "folder-pair" });
    await routes.request({ type: "disconnect" });
    expect(await folderPairingRepository.read()).toBeNull();
    expect(link.commands.slice(-2)).toEqual([
      { type: "folder-stop" },
      { type: "close", peer: PEER },
    ]);
  });

  test("tells the pages when a tab closes, since Chrome may have ended the folder's grant", async () => {
    const { link } = await peerBackground();
    await fakeBrowser.tabs.onRemoved.trigger(7, { windowId: 1, isWindowClosing: true });
    expect(link.notices).toEqual([{ target: "pages", type: "peer-changed" }]);
  });

  test("closes the offscreen document before the folder is allowed again, unless connected", async () => {
    const { routes, connect } = await peerBackground();
    vi.spyOn(fakeBrowser.runtime, "getContexts").mockResolvedValue([{}] as never);
    const close = vi.spyOn(fakeBrowser.offscreen, "closeDocument").mockResolvedValue(undefined);
    await routes.request({ type: "folder-release" });
    expect(close).toHaveBeenCalledOnce();
    await connect();
    await routes.request({ type: "folder-release" });
    expect(close).toHaveBeenCalledOnce();
  });

  test("keeps waiting once the link is verified, and offers again once it goes down", async () => {
    const { routes, connect, link } = await peerBackground({ authorized: false });
    await folderPairingRepository.write({});
    const sighting = { type: "folder" as const, presences: [presence], signals: [] };
    await routes.link(sighting);
    expect(link.commands).toContainEqual({ type: "offer", peer: PEER });
    const { displayName, fingerprint } = presence;
    await authorizedPeersRepository.set(PEER, { profileId: PEER, displayName, fingerprint });
    // Accepting the answer ends the pending offer before the link comes up.
    await pendingOffersRepository.set(PEER, null);
    await connect();
    const offers = () => link.commands.filter(({ type }) => type === "offer").length;
    await routes.link(sighting);
    expect(offers()).toBe(1);
    expect(await folderPairingRepository.read()).toEqual({});
    expect(link.commands).not.toContainEqual({ type: "folder-stop" });
    await routes.link({ type: "state", peer: PEER, state: "disconnected" });
    await routes.link(sighting);
    expect(offers()).toBe(2);
  });
});
