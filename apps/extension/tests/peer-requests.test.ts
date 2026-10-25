import { describe, expect, test, vi } from "vite-plus/test";
import type { PairingFlow } from "@/background/pairing";
import { handlePeerRequest } from "@/background/peer-requests";
import type { PeerRequestDependencies } from "@/background/peer-requests";
import { peerMessage } from "@/p2p/protocol";
import type { PeerMessage, PeerType, SharedTabs } from "@/p2p/protocol";
import type { AuthorizedPeer, PeerLink, RemoteRecording } from "@/storage/peer-repository";
import { memoryRecordingStore } from "./fake-extension";
import { FINGERPRINT, ME, PEER, fromPeer, memoryRepository } from "./fake-peer";

const identity = { profileId: ME, displayName: "Laptop" };
const peer: AuthorizedPeer = { profileId: PEER, displayName: "Desk", fingerprint: FINGERPRINT };
const VERIFIED: PeerLink = { state: "connected", verified: true };
const TAB = { id: 3, windowId: 1, incognito: false as const, title: "Shop", url: "https://s/" };

const result = (ok: boolean, reason?: string) =>
  fromPeer("COMMAND_RESULT", { requestId: crypto.randomUUID(), ok, ...(reason ? { reason } : {}) });

/** Every dependency in memory; the channel answers each request with `reply`. */
function requests(link: PeerLink | null = VERIFIED, reply: PeerMessage = result(true)) {
  let tabs: SharedTabs | undefined;
  const pairing = {
    createOffer: vi.fn(async () => ({ code: "offer" })),
    inspect: vi.fn(async () => "preview"),
    accept: vi.fn(async () => "accepted"),
  } as unknown as PairingFlow;
  const deps = {
    channel: { request: vi.fn(async (_type: PeerType, _payload: unknown) => reply) },
    hello: vi.fn(async () => {}),
    pairing,
    askLink: vi.fn(async () => "link"),
    identity: async () => identity,
    rename: vi.fn(async () => {}),
    authorized: memoryRepository<AuthorizedPeer>(peer),
    link: memoryRepository(link),
    mirror: memoryRepository<RemoteRecording>({
      profileId: PEER,
      session: null,
      mine: false,
      connected: true,
    }),
    localSession: memoryRecordingStore(),
    tabs: { read: () => tabs, write: vi.fn((next: SharedTabs | undefined) => (tabs = next)) },
  } satisfies PeerRequestDependencies;
  const asked = () => deps.channel.request.mock.calls;
  return { deps, pairing, asked };
}

describe("the link and its peer", () => {
  test("reports identity, peer, and an idle link when none was stored", async () => {
    const { deps } = requests(null);
    expect(await handlePeerRequest(deps, { type: "status" })).toEqual({
      identity,
      peer,
      link: { state: "idle", verified: false },
    });
    await deps.link.write(VERIFIED);
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({ link: VERIFIED });
  });

  test("renames this profile, and tells a verified peer at once", async () => {
    const { deps } = requests();
    deps.hello.mockRejectedValue(new Error("gone"));
    await handlePeerRequest(deps, { type: "rename", displayName: "Studio" });
    expect(deps.rename).toHaveBeenCalledWith({ profileId: ME, displayName: "Studio" });
    expect(deps.hello).toHaveBeenCalledTimes(1);
    const offline = requests({ state: "disconnected", verified: false });
    await handlePeerRequest(offline.deps, { type: "rename", displayName: "Studio" });
    expect(offline.deps.hello).not.toHaveBeenCalled();
  });

  test("hands pairing requests to the pairing flow", async () => {
    const { deps, pairing } = requests();
    expect(await handlePeerRequest(deps, { type: "create-offer" })).toEqual({ code: "offer" });
    expect(await handlePeerRequest(deps, { type: "inspect", code: "c1" })).toBe("preview");
    expect(await handlePeerRequest(deps, { type: "accept", code: "c2" })).toBe("accepted");
    expect(pairing.inspect).toHaveBeenCalledWith("c1");
    expect(pairing.accept).toHaveBeenCalledWith("c2");
  });

  test("closes the link on disconnect and asks it for diagnostics", async () => {
    const { deps } = requests();
    await handlePeerRequest(deps, { type: "disconnect" });
    expect(await handlePeerRequest(deps, { type: "diagnostics" })).toBe("link");
    expect(deps.askLink.mock.calls).toEqual([[{ type: "close" }], [{ type: "info" }]]);
  });

  test("forgets the peer, its session copy, and its tabs, and closes the link", async () => {
    const { deps } = requests();
    deps.tabs.write({ tabs: [TAB] });
    await handlePeerRequest(deps, { type: "forget" });
    expect(await deps.authorized.read()).toBeNull();
    expect(await deps.mirror.read()).toBeNull();
    expect(deps.tabs.read()).toBeUndefined();
    expect(deps.askLink).toHaveBeenCalledWith({ type: "close" });
  });

  test("measures a ping's round trip", async () => {
    const { deps, asked } = requests();
    const { latencyMs } = (await handlePeerRequest(deps, { type: "ping" })) as {
      latencyMs: number;
    };
    expect(latencyMs).toBeGreaterThanOrEqual(0);
    expect(asked()[0]?.[0]).toBe("PING");
  });
});

describe("the peer's tabs", () => {
  test("keeps the last report, even while disconnected, and asks nothing", async () => {
    const { deps, asked } = requests({ state: "disconnected", verified: false });
    deps.tabs.write({ tabs: [TAB], currentId: 3 });
    expect(await handlePeerRequest(deps, { type: "tabs" })).toEqual({ tabs: [TAB], currentId: 3 });
    expect(asked()).toEqual([]);
  });

  test("lists none without a report or a verified link", async () => {
    const { deps, asked } = requests({ state: "connecting", verified: false });
    expect(await handlePeerRequest(deps, { type: "tabs" })).toEqual({ tabs: [] });
    expect(asked()).toEqual([]);
  });

  test("asks a verified peer, and keeps its answer", async () => {
    const requestId = crypto.randomUUID();
    for (const currentId of [3, undefined]) {
      const answer = fromPeer("TABS_SNAPSHOT", { requestId, tabs: [TAB], currentId });
      const { deps, asked } = requests(VERIFIED, answer);
      const expected = currentId === undefined ? { tabs: [TAB] } : { tabs: [TAB], currentId };
      expect(await handlePeerRequest(deps, { type: "tabs" })).toStrictEqual(expected);
      expect(deps.tabs.read()).toStrictEqual(expected);
      expect(asked()[0]?.[0]).toBe("GET_TABS");
    }
  });

  test("lists none, and keeps nothing, when the peer answers something else", async () => {
    const { deps } = requests(VERIFIED, result(true));
    expect(await handlePeerRequest(deps, { type: "tabs" })).toEqual({ tabs: [] });
    expect(deps.tabs.write).not.toHaveBeenCalled();
  });
});

describe("commands to the other profile", () => {
  test("sends each command and resolves when the executor did it", async () => {
    const { deps, asked } = requests();
    await handlePeerRequest(deps, { type: "activate", tabId: 3 });
    await handlePeerRequest(deps, { type: "session-start", tabId: 3 });
    await handlePeerRequest(deps, { type: "session-set", status: "paused" });
    await handlePeerRequest(deps, { type: "session-stop" });
    expect(asked()).toEqual([
      ["ACTIVATE_TAB", { tabId: 3 }],
      ["SESSION_START", { tabId: 3 }],
      ["SESSION_SET_STATUS", { status: "paused" }],
      ["SESSION_STOP", {}],
    ]);
  });

  test("rejects with the executor's reason, or a plain refusal without one", async () => {
    const reasoned = requests(VERIFIED, result(false, "That tab is not open anymore."));
    await expect(handlePeerRequest(reasoned.deps, { type: "activate", tabId: 3 })).rejects.toThrow(
      "That tab is not open anymore.",
    );
    const bare = requests(VERIFIED, result(false));
    await expect(handlePeerRequest(bare.deps, { type: "session-stop" })).rejects.toThrow(
      "Refused.",
    );
  });

  test("resolves on a reply that is not a command result", async () => {
    const pong = peerMessage("PONG", { from: PEER, to: ME }, { requestId: PEER, timestamp: 1 });
    const { deps } = requests(VERIFIED, pong);
    await expect(handlePeerRequest(deps, { type: "session-stop" })).resolves.toBeUndefined();
  });

  test("starts no remote session while one runs in this profile", async () => {
    const { deps, asked } = requests();
    await deps.localSession.write({ tabId: 1, status: "recording", banked: 0, since: 1 });
    await expect(handlePeerRequest(deps, { type: "session-start", tabId: 3 })).rejects.toThrow(
      "A session already runs in this profile.",
    );
    expect(asked()).toEqual([]);
  });
});
