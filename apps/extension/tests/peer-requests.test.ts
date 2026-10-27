import { describe, expect, test } from "vite-plus/test";
import { handlePeerRequest } from "@/background/peer-requests";
import { ME, PEER, STRANGER } from "./fake-peer";
import { TAB, VERIFIED, identity, other, peer, requests, withOther } from "./peer-requests-fixture";

const IDLE = { state: "idle", verified: false };
/** A profile in the folder never paired with. */
const ME_TOO = "66666666-6666-4666-8666-666666666666";

describe("the status", () => {
  test("reports identity, the peer, and an idle link when none was stored", async () => {
    const { deps } = requests(null);
    expect(await handlePeerRequest(deps, { type: "status" })).toEqual({
      identity,
      peers: [{ peer, link: IDLE, peerSession: null }],
      controlledBy: null,
      paused: [],
      folder: "granted",
      folderPairing: false,
      unpaired: [],
    });
    await deps.link.set(PEER, VERIFIED);
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({
      peers: [{ link: VERIFIED }],
    });
  });

  test("status lists every peer, each with its own link and session", async () => {
    const { deps } = await withOther({ state: "disconnected", verified: false });
    const session = { tabId: 3, status: "recording" as const, banked: 0, since: 1 };
    await deps.mirror.set(STRANGER, { profileId: STRANGER, session, mine: true, connected: true });
    const status = await handlePeerRequest(deps, { type: "status" });
    expect(status).toMatchObject({
      peers: [
        { peer, link: { state: "disconnected", verified: false }, peerSession: null },
        {
          peer: other,
          link: VERIFIED,
          peerSession: { status: "recording", mine: true, live: true },
        },
      ],
    });
  });

  test("reports which peer controls the session that runs here, while its link holds", async () => {
    const { deps } = await withOther();
    await deps.controller.write({ profileId: STRANGER });
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({ controlledBy: null });
    await deps.localSession.write({ tabId: 1, status: "recording", banked: 0, since: 1 });
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({
      controlledBy: STRANGER,
    });
    await deps.link.set(STRANGER, { state: "failed", verified: false });
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({ controlledBy: null });
  });

  test("reports the peer's session from its last report, live only over a verified link", async () => {
    const session = { tabId: 3, status: "paused" as const, banked: 0, since: 1 };
    const { deps } = requests();
    const peerSession = async () =>
      ((await handlePeerRequest(deps, { type: "status" })) as { peers: { peerSession: unknown }[] })
        .peers[0]?.peerSession;
    await deps.mirror.set(PEER, { profileId: PEER, session, mine: true, connected: true });
    expect(await peerSession()).toEqual({ status: "paused", mine: true, live: true });
    await deps.mirror.set(PEER, { profileId: PEER, session, mine: false, connected: false });
    expect(await peerSession()).toEqual({ status: "paused", mine: false, live: false });
    await deps.mirror.set(PEER, { profileId: PEER, session, mine: true, connected: true });
    await deps.link.set(PEER, { state: "disconnected", verified: false });
    expect(await peerSession()).toMatchObject({ live: false });
  });

  test("reports the folder, as none when it cannot be asked, and starts waiting in it", async () => {
    const { deps } = requests();
    deps.folder.waiting.mockResolvedValue(true);
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({
      folder: "granted",
      folderPairing: true,
    });
    // A profile in the folder counts as unpaired until linked, or paused by the user.
    deps.folder.present.mockResolvedValue([PEER, STRANGER, ME_TOO]);
    await deps.folder.pause(STRANGER);
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({ unpaired: [ME_TOO] });
    deps.folder.access.mockRejectedValue(new Error("No offscreen document."));
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({ folder: "none" });
    await handlePeerRequest(deps, { type: "folder-pair" });
    expect(deps.folder.start).toHaveBeenCalledOnce();
  });
});

describe("one peer at a time", () => {
  test("renames this profile, and tells each verified peer at once", async () => {
    const { deps } = await withOther();
    deps.hello.mockRejectedValueOnce(new Error("gone"));
    await handlePeerRequest(deps, { type: "rename", displayName: "Home" });
    expect(deps.rename).toHaveBeenCalledWith({ profileId: ME, displayName: "Home" });
    expect(deps.hello.mock.calls).toEqual([[PEER], [STRANGER]]);
    const offline = requests({ state: "disconnected", verified: false });
    await handlePeerRequest(offline.deps, { type: "rename", displayName: "Home" });
    expect(offline.deps.hello).not.toHaveBeenCalled();
  });

  test("disconnect closes one peer's link and keeps waiting for the others", async () => {
    const { deps } = await withOther();
    await handlePeerRequest(deps, { type: "disconnect", peer: PEER });
    expect(deps.askLink.mock.calls).toEqual([[{ type: "close", peer: PEER }]]);
    expect(await deps.link.get(PEER)).toEqual({
      state: "disconnected",
      verified: false,
      reason: "closed-here",
    });
    expect(await deps.link.get(STRANGER)).toEqual(VERIFIED);
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({ paused: [PEER] });
    expect(deps.folder.start).not.toHaveBeenCalled();
  });

  test("reconnect lets that peer pair through the folder again", async () => {
    const { deps } = await withOther();
    await handlePeerRequest(deps, { type: "disconnect", peer: PEER });
    await handlePeerRequest(deps, { type: "disconnect", peer: STRANGER });
    await handlePeerRequest(deps, { type: "reconnect", peer: PEER });
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({
      paused: [STRANGER],
    });
  });

  test("forget removes one peer and keeps it paused", async () => {
    const { deps } = await withOther();
    await deps.tabs.set(PEER, { tabs: [TAB] });
    await deps.tabs.set(STRANGER, { tabs: [TAB] });
    await handlePeerRequest(deps, { type: "forget", peer: PEER });
    expect(await deps.authorized.all()).toEqual({ [STRANGER]: other });
    expect(await deps.mirror.get(PEER)).toBeNull();
    expect(Object.keys(await deps.tabs.all())).toEqual([STRANGER]);
    expect(deps.askLink.mock.calls).toEqual([[{ type: "close", peer: PEER }]]);
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({
      peers: [{ peer: other }],
      paused: [PEER],
    });
  });

  test("pair-again lets every paused profile pair again", async () => {
    const { deps } = await withOther();
    await handlePeerRequest(deps, { type: "disconnect", peer: STRANGER });
    await handlePeerRequest(deps, { type: "forget", peer: PEER });
    await handlePeerRequest(deps, { type: "pair-again" });
    expect(await handlePeerRequest(deps, { type: "status" })).toMatchObject({ paused: [] });
  });

  test("releases the folder's handles before it is allowed again, only while no link holds", async () => {
    const { deps } = await withOther();
    await deps.link.set(PEER, { state: "disconnected", verified: false });
    await handlePeerRequest(deps, { type: "folder-release" });
    expect(deps.folder.release).not.toHaveBeenCalled();
    await deps.link.set(STRANGER, { state: "failed", verified: false });
    await handlePeerRequest(deps, { type: "folder-release" });
    expect(deps.folder.release).toHaveBeenCalledOnce();
  });
});
