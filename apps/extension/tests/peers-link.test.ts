import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { NOT_CONNECTED } from "@/background/peer-channel";
import {
  identityRepository,
  peerLinkRepository,
  remoteRecordingRepository,
} from "@/storage/peer-repository";
import { ME, PEER, STRANGER, fromPeer } from "./fake-peer";
import { peerBackground, tappedFrames } from "./peer-background";

const session = { tabId: 4, status: "recording" as const, banked: 0, since: 1 };

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
      expect(await peerLinkRepository.read()).toEqual({ state: "failed", verified: false });
    }
    expect(link.commands).toEqual([{ type: "close" }, { type: "close" }]);
    expect(link.sentTypes()).toEqual([]);
  });

  test("closes any link before a peer is authorized", async () => {
    const { connect, link } = await peerBackground({ authorized: false });
    await connect();
    expect(await peerLinkRepository.read()).toEqual({ state: "failed", verified: false });
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
