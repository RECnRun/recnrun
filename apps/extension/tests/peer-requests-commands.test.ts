import { describe, expect, test } from "vite-plus/test";
import { handlePeerRequest } from "@/background/peer-requests";
import { peerMessage } from "@/p2p/protocol";
import { ME, PEER, STRANGER, fromPeer } from "./fake-peer";
import { TAB, VERIFIED, requests, result, withOther } from "./peer-requests-fixture";

const recording = { tabId: 1, status: "recording" as const, banked: 0, since: 1 };

describe("each peer's tabs", () => {
  test("keeps the last report, even while disconnected, and asks nothing", async () => {
    const { deps, asked } = requests({ state: "disconnected", verified: false });
    await deps.tabs.set(PEER, { tabs: [TAB], currentId: 3 });
    expect(await handlePeerRequest(deps, { type: "tabs", peer: PEER })).toEqual({
      tabs: [TAB],
      currentId: 3,
    });
    expect(asked()).toEqual([]);
  });

  test("lists none without a report or a verified link, as for a profile never paired", async () => {
    const { deps, asked } = requests({ state: "connecting", verified: false });
    expect(await handlePeerRequest(deps, { type: "tabs", peer: PEER })).toEqual({ tabs: [] });
    expect(await handlePeerRequest(deps, { type: "tabs", peer: STRANGER })).toEqual({ tabs: [] });
    expect(asked()).toEqual([]);
  });

  test("asks the named verified peer, and keeps its answer under it", async () => {
    const requestId = crypto.randomUUID();
    for (const currentId of [3, undefined]) {
      const answer = fromPeer("TABS_SNAPSHOT", { requestId, tabs: [TAB], currentId }, STRANGER);
      const { deps, asked } = await withOther();
      deps.channel.request.mockResolvedValue(answer);
      const expected = currentId === undefined ? { tabs: [TAB] } : { tabs: [TAB], currentId };
      const tabs = await handlePeerRequest(deps, { type: "tabs", peer: STRANGER });
      expect(tabs).toStrictEqual(expected);
      expect(await deps.tabs.all()).toStrictEqual({ [STRANGER]: expected });
      expect(asked()[0]?.slice(0, 2)).toEqual([STRANGER, "GET_TABS"]);
    }
  });

  test("lists none, and keeps nothing, when the peer answers something else", async () => {
    const { deps } = requests(VERIFIED, result(true));
    expect(await handlePeerRequest(deps, { type: "tabs", peer: PEER })).toEqual({ tabs: [] });
    expect(deps.tabs.set).not.toHaveBeenCalled();
  });
});

describe("commands to another profile", () => {
  test("sends each command to the peer it names, and resolves when its executor did it", async () => {
    const { deps, asked } = await withOther();
    await handlePeerRequest(deps, { type: "activate", peer: STRANGER, tabId: 3 });
    await handlePeerRequest(deps, { type: "session-start", peer: PEER, tabId: 3 });
    await handlePeerRequest(deps, { type: "session-set", peer: PEER, status: "paused" });
    await handlePeerRequest(deps, { type: "session-stop", peer: PEER });
    expect(asked()).toEqual([
      [STRANGER, "ACTIVATE_TAB", { tabId: 3 }],
      [PEER, "SESSION_START", { tabId: 3 }],
      [PEER, "SESSION_SET_STATUS", { status: "paused" }],
      [PEER, "SESSION_STOP", {}],
    ]);
  });

  test("rejects with the executor's reason, or a plain refusal without one", async () => {
    const reasoned = requests(VERIFIED, result(false, "That tab is not open anymore."));
    await expect(
      handlePeerRequest(reasoned.deps, { type: "activate", peer: PEER, tabId: 3 }),
    ).rejects.toThrow("That tab is not open anymore.");
    const bare = requests(VERIFIED, result(false));
    await expect(
      handlePeerRequest(bare.deps, { type: "session-stop", peer: PEER }),
    ).rejects.toThrow("Refused.");
  });

  test("resolves on a reply that is not a command result", async () => {
    const snapshot = peerMessage(
      "TABS_SNAPSHOT",
      { from: PEER, to: ME },
      { requestId: PEER, tabs: [] },
    );
    const { deps } = requests(VERIFIED, snapshot);
    await expect(
      handlePeerRequest(deps, { type: "session-stop", peer: PEER }),
    ).resolves.toBeUndefined();
  });

  test("starts no remote session while one runs in this profile", async () => {
    const { deps, asked } = requests();
    await deps.localSession.write(recording);
    await expect(
      handlePeerRequest(deps, { type: "session-start", peer: PEER, tabId: 3 }),
    ).rejects.toThrow("A session already runs in this profile.");
    expect(asked()).toEqual([]);
  });

  test("session-start refuses while a session runs in another peer", async () => {
    const { deps, asked } = await withOther();
    const report = { profileId: STRANGER, session: recording, mine: false, connected: true };
    await deps.mirror.set(STRANGER, report);
    const start = () => handlePeerRequest(deps, { type: "session-start", peer: PEER, tabId: 3 });
    await expect(start()).rejects.toThrow("A session already runs in Studio.");
    // A report from a link that went down tells nothing current, so it blocks nothing.
    await deps.mirror.set(STRANGER, { ...report, connected: false });
    await start();
    expect(asked()).toEqual([[PEER, "SESSION_START", { tabId: 3 }]]);
  });
});
