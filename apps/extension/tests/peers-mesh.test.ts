import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  authorizedPeersRepository,
  peerLinksRepository,
  peerTabsRepository,
  remoteRecordingsRepository,
} from "@/storage/peer-repository";
import { ME, PEER, STRANGER, fromPeer } from "./fake-peer";
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
    const pending = routes.request({ type: "tabs" });
    await vi.waitFor(() => expect(link.sentTypes()).toContain("GET_TABS"));
    await routes.link({ type: "state", peer: STRANGER, state: "disconnected" });
    expect(await peerLinksRepository.get(PEER)).toEqual({ state: "connected", verified: true });
    expect(await peerLinksRepository.get(STRANGER)).toMatchObject({ verified: false });
    expect(await remoteRecordingsRepository.get(PEER)).toMatchObject({ connected: true });
    expect(await remoteRecordingsRepository.get(STRANGER)).toMatchObject({ connected: false });
    const ask = link.frames().at(-1) as unknown as { id: string; to: string };
    expect(ask.to).toBe(PEER);
    await receive(fromPeer("TABS_SNAPSHOT", { requestId: ask.id, tabs: [] }));
    expect(await pending).toEqual({ tabs: [] });
    // A new link to one peer starts from its next report; the other's stays.
    await connect(OTHER_FINGERPRINT, STRANGER);
    const hello = { displayName: "Lab", extensionVersion: "0.1.0" };
    await receive(fromPeer("HELLO", hello, STRANGER), STRANGER);
    expect(await peerTabsRepository.all()).toEqual({ [PEER]: { tabs: [] } });
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
    expect(link.sentTypes()).toEqual(["HELLO", "HELLO"]);
  });
});
