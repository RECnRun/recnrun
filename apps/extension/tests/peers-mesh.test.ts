import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  authorizedPeersRepository,
  folderPairingRepository,
  peerLinksRepository,
  peerTabsRepository,
  remoteRecordingsRepository,
} from "@/storage/peer-repository";
import { FINGERPRINT, ME, PEER, STRANGER, fromPeer } from "./fake-peer";
import { peerBackground } from "./peer-background";

const session = { tabId: 4, status: "recording" as const, banked: 0, since: 1 };

beforeEach(() => {
  fakeBrowser.reset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("two peers", () => {
  const tab = { id: 3, windowId: 1, incognito: false as const, title: "Shop", url: "https://s/" };
  const OTHER_FINGERPRINT = "12:34";

  test("a link that drops leaves the other peer's link, waiters, and tabs alone", async () => {
    const { routes, connect, receive, link } = await peerBackground();
    await authorizedPeersRepository.set(STRANGER, {
      profileId: STRANGER,
      displayName: "Lab",
      fingerprint: OTHER_FINGERPRINT,
    });
    await connect();
    await connect(OTHER_FINGERPRINT, STRANGER);
    const mine = { session, controlledBy: ME };
    await receive(fromPeer("SESSION_STATUS", mine));
    await receive(fromPeer("SESSION_STATUS", mine, STRANGER), STRANGER);
    await receive(fromPeer("TABS_CHANGED", { tabs: [tab] }, STRANGER), STRANGER);
    const pending = routes.request({ type: "tabs", peer: PEER });
    await vi.waitFor(() => expect(link.sentTypes()).toContain("GET_TABS"));
    await routes.link({ type: "state", peer: STRANGER, state: "disconnected" });
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
    expect(await peerLinksRepository.get(STRANGER)).toMatchObject({ verified: false });
    expect(await remoteRecordingsRepository.get(PEER)).toMatchObject({ connected: true });
    expect(await remoteRecordingsRepository.get(STRANGER)).toMatchObject({ connected: false });
    // Found by type: a report from an earlier file's timer may follow it (isolate: false).
    const ask = link.frames().find(({ type }) => type === "GET_TABS") as unknown as {
      id: string;
      to: string;
    };
    expect(ask.to).toBe(PEER);
    await receive(fromPeer("TABS_SNAPSHOT", { requestId: ask.id, tabs: [] }));
    expect(await pending).toEqual({ tabs: [] });
    // A new link to one peer starts from its next report; the other's stays.
    await connect(OTHER_FINGERPRINT, STRANGER);
    const hello = { displayName: "Lab", extensionVersion: "0.1.0" };
    await receive(fromPeer("HELLO", hello, STRANGER), STRANGER);
    expect(await peerTabsRepository.all()).toEqual({ [PEER]: { tabs: [] } });
  });

  const lab = { profileId: STRANGER, displayName: "Lab", fingerprint: OTHER_FINGERPRINT };
  const desk = { profileId: PEER, displayName: "Desk", fingerprint: FINGERPRINT };
  const membersSent = (frames: { type: string; to?: string; members?: unknown }[]) =>
    frames.filter((frame) => frame.type === "MEMBERS").map(({ to, members }) => ({ to, members }));

  test("each new link introduces the linked peers to each other, and a drop updates the rest", async () => {
    const { routes, connect, receive, link } = await peerBackground();
    await authorizedPeersRepository.set(STRANGER, lab);
    await connect();
    await receive(fromPeer("MEMBERS", { members: [] }));
    await connect(OTHER_FINGERPRINT, STRANGER);
    await receive(fromPeer("MEMBERS", { members: [] }, STRANGER), STRANGER);
    await routes.link({ type: "state", peer: STRANGER, state: "disconnected" });
    expect(membersSent(link.frames())).toEqual([
      { to: PEER, members: [] },
      { to: PEER, members: [lab] },
      { to: STRANGER, members: [desk] },
      { to: PEER, members: [] },
    ]);
  });

  test("Reconnect pairs again through a peer that reaches the paused profile", async () => {
    const { routes, connect, receive, link } = await peerBackground();
    await authorizedPeersRepository.set(STRANGER, lab);
    await folderPairingRepository.write({ paused: [STRANGER] });
    await connect();
    await receive(fromPeer("MEMBERS", { members: [lab] }));
    expect(link.commands).not.toContainEqual({ type: "offer", peer: STRANGER });
    await routes.request({ type: "reconnect", peer: STRANGER });
    expect(link.commands).toContainEqual({ type: "offer", peer: STRANGER });
  });

  test("a frame claiming one peer's id over the other's link is dropped", async () => {
    const { connect, receive, link } = await peerBackground();
    await authorizedPeersRepository.set(STRANGER, {
      profileId: STRANGER,
      displayName: "Lab",
      fingerprint: OTHER_FINGERPRINT,
    });
    await connect();
    await connect(OTHER_FINGERPRINT, STRANGER);
    await receive(fromPeer("GET_TABS", {}), STRANGER);
    expect(link.sentTypes().filter((type) => type !== "MEMBERS")).toEqual(["HELLO", "HELLO"]);
  });
});
