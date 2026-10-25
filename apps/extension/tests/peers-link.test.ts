import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { NOT_CONNECTED } from "@/background/peer-channel";
import { startPeers } from "@/background/peers";
import {
  identityRepository,
  peerLinkRepository,
  remoteRecordingRepository,
} from "@/storage/peer-repository";
import { ME, PEER, STRANGER, fromPeer } from "./fake-peer";
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
      expect(await peerLinkRepository.read()).toEqual(MISMATCH);
    }
    expect(link.commands).toEqual([{ type: "close" }, { type: "close" }]);
    expect(link.sentTypes()).toEqual([]);
  });

  test("closes any link before a peer is authorized", async () => {
    const { connect, link } = await peerBackground({ authorized: false });
    await connect();
    expect(await peerLinkRepository.read()).toEqual(MISMATCH);
    expect(link.commands).toEqual([{ type: "close" }]);
  });

  test("verifies the accepted certificate and introduces this profile", async () => {
    const { connect, link } = await peerBackground();
    await connect();
    expect(await peerLinkRepository.read()).toEqual({ state: "connected", verified: true });
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
    await routes.link({ type: "state", state: "connecting" });
    expect(await peerLinkRepository.read()).toEqual({ state: "connecting", verified: false });
    expect(link.notices).toHaveLength(1);
  });
});

describe("frames", () => {
  test("executes what the verified peer asks, and keeps each frame in the tap", async () => {
    const { connect, receive, link } = await peerBackground();
    await connect();
    const ping = fromPeer("PING", { timestamp: 1 });
    await receive(ping);
    expect(link.frames().at(-1)).toMatchObject({ type: "PONG", requestId: ping.id });
    expect(tappedFrames()).toContain(JSON.stringify(ping));
  });

  test("drops a frame from an unauthorized profile without an answer", async () => {
    const { connect, receive, link } = await peerBackground();
    await connect();
    await receive(fromPeer("PING", { timestamp: 1 }, STRANGER));
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
    await remoteRecordingRepository.write(copy);
    const pending = routes.request({ type: "ping" });
    await vi.waitFor(() => expect(link.sentTypes()).toContain("PING"));
    await routes.link({ type: "state", state: "disconnected" });
    await expect(pending).rejects.toThrow(NOT_CONNECTED);
    expect(await peerLinkRepository.read()).toEqual({ state: "disconnected", verified: false });
    expect(await remoteRecordingRepository.read()).toEqual({ ...copy, connected: false });
  });

  test("writes no copy when there was none, or when it is unreadable", async () => {
    const { routes } = await peerBackground();
    await routes.link({ type: "state", state: "failed" });
    expect(await remoteRecordingRepository.read()).toBeNull();
    await fakeBrowser.storage.session.set({ remoteRecording: "unreadable" });
    await routes.link({ type: "state", state: "failed" });
    expect(await fakeBrowser.storage.session.get("remoteRecording")).toEqual({
      remoteRecording: "unreadable",
    });
    expect(await peerLinkRepository.read()).toEqual({ state: "failed", verified: false });
  });
});

describe("an intended close", () => {
  test("a BYE from the verified peer closes the link as closed by the peer, until it reconnects", async () => {
    const { routes, connect, receive, link } = await peerBackground();
    await connect();
    await receive(fromPeer("BYE", {}));
    const closed = { state: "disconnected", verified: false, reason: "closed-by-peer" };
    expect(await peerLinkRepository.read()).toEqual(closed);
    expect(link.commands.at(-1)).toEqual({ type: "close" });
    await routes.link({ type: "state", state: "failed" });
    expect(await peerLinkRepository.read()).toEqual({ ...closed, state: "failed" });
    await routes.link({ type: "state", state: "connecting" });
    expect(await peerLinkRepository.read()).toEqual({ state: "connecting", verified: false });
  });

  test.each(["disconnect", "forget"] as const)(
    "%s says BYE to the verified peer before closing, and marks the close as this profile's",
    async (type) => {
      const { routes, connect, link } = await peerBackground();
      await connect();
      await routes.request({ type });
      expect(link.sentTypes()).toEqual(["HELLO", "BYE"]);
      expect(link.commands.at(-1)).toEqual({ type: "close" });
      await routes.link({ type: "state", state: "disconnected" });
      expect(await peerLinkRepository.read()).toEqual({
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
    expect(link.commands).toEqual([{ type: "close" }]);
  });
});

describe("the peer's tabs", () => {
  test("are kept in session storage, so a worker that wakes again still lists them", async () => {
    const tab = { id: 3, windowId: 1, incognito: false as const, title: "Shop", url: "https://s/" };
    const { routes, connect, receive } = await peerBackground();
    await connect();
    await receive(fromPeer("TABS_CHANGED", { tabs: [tab], currentId: 3 }));
    await routes.link({ type: "state", state: "disconnected" });
    // A worker that slept starts again with nothing in memory and the same storage.
    const woken = startPeers();
    expect(await woken.request({ type: "tabs" })).toEqual({ tabs: [tab], currentId: 3 });
    // A new link starts from the peer's next report.
    await connect();
    await receive(fromPeer("HELLO", { displayName: "Desk", extensionVersion: "0.1.0" }));
    expect(await fakeBrowser.storage.session.get("peerTabs")).toEqual({});
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
