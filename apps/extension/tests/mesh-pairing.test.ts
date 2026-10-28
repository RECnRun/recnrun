import { describe, expect, test, vi } from "vite-plus/test";
import { createMeshPairing } from "@/background/mesh-pairing";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import type { Pairing } from "@/p2p/pairing-code";
import { peerMessage } from "@/p2p/protocol";
import type { Member, PeerPayload, PeerType } from "@/p2p/protocol";
import type {
  AuthorizedPeer,
  FolderActed,
  FolderPairing,
  PeerLink,
  PendingOffer,
} from "@/storage/peer-repository";
import { ME, PEER, STRANGER, memoryRecords, memoryRepository, recordingChannel } from "./fake-peer";

const NOW = 1_700_000_000_000;
const PAIRING_ID = "44444444-4444-4444-8444-444444444444";
const member = (profileId: string): Member => ({
  profileId,
  displayName: `Profile ${profileId.slice(0, 1)}`,
  fingerprint: `${profileId.slice(0, 1)}${profileId.slice(0, 1)}:AA`,
});
const VERIFIED: PeerLink = { state: "connected", verified: true };
const FAILED: PeerLink = { state: "failed", verified: false };

/** A code `from` made, announcing its own certificate unless told otherwise. */
const codeOf = (kind: Pairing["kind"], from: string, fingerprint = member(from).fingerprint) =>
  encodePairing({
    kind,
    pairingId: PAIRING_ID,
    profileId: from,
    displayName: "Profile",
    expiresAt: NOW + PAIRING_TTL_MS,
    sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`,
  });

interface Setup {
  me?: string;
  links?: Record<string, PeerLink>;
  authorized?: Record<string, AuthorizedPeer>;
  members?: Record<string, Member[]>;
  state?: FolderPairing | null;
  pending?: Record<string, PendingOffer>;
}

/** `me`'s mesh pairing, linked to PEER, which reaches STRANGER, unless told otherwise. */
function meshOf(setup: Setup = {}) {
  const me = setup.me ?? ME;
  const { channel, sent } = recordingChannel();
  const pairing = {
    createOffer: vi.fn(async (to: string) => ({ code: `new offer to ${to}` })),
    accept: vi.fn(async (_code: string): Promise<{ code?: string }> => ({ code: "answer" })),
  };
  const acted = memoryRecords<FolderActed>();
  const members = memoryRecords(setup.members ?? { [PEER]: [member(STRANGER)] });
  const log = vi.fn();
  const flow = createMeshPairing({
    channel,
    identity: async () => ({ profileId: me, displayName: "Laptop" }),
    pairing,
    authorized: memoryRecords(setup.authorized ?? { [PEER]: member(PEER) }),
    link: memoryRecords(setup.links ?? { [PEER]: VERIFIED }),
    pending: memoryRecords(setup.pending ?? {}),
    acted,
    members,
    state: memoryRepository(setup.state === undefined ? {} : setup.state),
    exclusive: (work) => work(),
    log,
    now: () => NOW,
  });
  /** A frame that came over the link to PEER. */
  const fromRelay = <T extends PeerType>(type: T, payload: PeerPayload<T>, from = PEER) =>
    flow.receive(peerMessage(type, { from, to: me }, payload));
  return { flow, sent, pairing, acted, members, log, fromRelay };
}

describe("what each profile tells its peers", () => {
  test("each linked peer learns the others this profile's links reach", async () => {
    const { flow, sent } = meshOf({
      links: { [PEER]: VERIFIED, [STRANGER]: VERIFIED, [ME]: FAILED },
      authorized: { [PEER]: member(PEER), [STRANGER]: member(STRANGER) },
    });
    await flow.announce();
    expect(sent).toEqual([
      { to: PEER, type: "MEMBERS", payload: { members: [member(STRANGER)] } },
      { to: STRANGER, type: "MEMBERS", payload: { members: [member(PEER)] } },
    ]);
  });

  test("a link that goes down forgets what it reached and tells the others", async () => {
    const { flow, sent, members } = meshOf({ links: { [STRANGER]: VERIFIED } });
    await flow.dropped(STRANGER);
    expect(sent).toEqual([]);
    await flow.dropped(PEER);
    expect(await members.all()).toEqual({});
    expect(sent).toEqual([{ to: STRANGER, type: "MEMBERS", payload: { members: [] } }]);
  });
});

describe("pairing with a profile a peer reaches", () => {
  test("the lower id offers through the peer, and the higher asks it to", async () => {
    const lower = meshOf();
    await lower.fromRelay("MEMBERS", { members: [member(STRANGER)] });
    expect(lower.sent).toEqual([
      {
        to: PEER,
        type: "SIGNAL",
        payload: { origin: ME, target: STRANGER, code: `new offer to ${STRANGER}` },
      },
    ]);
    const higher = meshOf({ me: STRANGER, members: {} });
    await higher.fromRelay("MEMBERS", { members: [member(ME)] });
    expect(higher.sent).toEqual([
      { to: PEER, type: "INVITE", payload: { origin: STRANGER, target: ME } },
    ]);
    expect(await higher.members.all()).toEqual({ [PEER]: [member(ME)] });
  });

  test("an offer still waiting goes again instead of a new one", async () => {
    const offer = { pairingId: PAIRING_ID, to: STRANGER, code: "waiting offer" };
    const waiting = meshOf({ pending: { [STRANGER]: { ...offer, expiresAt: NOW + 1 } } });
    await waiting.flow.look("new");
    expect(waiting.sent[0]?.payload).toMatchObject({ code: "waiting offer" });
    expect(waiting.pairing.createOffer).not.toHaveBeenCalled();
    const expired = meshOf({ pending: { [STRANGER]: { ...offer, expiresAt: NOW } } });
    await expired.flow.look("new");
    expect(expired.pairing.createOffer).toHaveBeenCalledWith(STRANGER);
  });

  test("a profile met already waits for Reconnect, which asks again", async () => {
    const { flow, sent } = meshOf({
      links: { [PEER]: VERIFIED, [STRANGER]: FAILED },
      authorized: { [PEER]: member(PEER), [STRANGER]: member(STRANGER) },
    });
    await flow.look("new");
    expect(sent).toEqual([]);
    await flow.look("all");
    expect(sent.map(({ type }) => type)).toEqual(["SIGNAL"]);
  });

  test("leaves alone paused and linked profiles, and pairs with none without the folder", async () => {
    const cases: Setup[] = [
      { state: { paused: [STRANGER] } },
      { state: null },
      { links: { [PEER]: VERIFIED, [STRANGER]: VERIFIED } },
      // Only a verified link vouches.
      { links: { [PEER]: FAILED } },
      // A relay cannot swap the certificate of a profile pinned already.
      { authorized: { [STRANGER]: { ...member(STRANGER), fingerprint: "99:99" } } },
    ];
    for (const setup of cases) {
      const { flow, sent } = meshOf(setup);
      await flow.look("all");
      expect(sent).toEqual([]);
    }
  });
});

describe("signals through the mesh", () => {
  test("a peer carries another's own signal on, and drops one sent for someone else", async () => {
    const { sent, log, fromRelay } = meshOf();
    await fromRelay("SIGNAL", { origin: PEER, target: STRANGER, code: "offer" });
    await fromRelay("INVITE", { origin: PEER, target: STRANGER });
    expect(sent).toEqual([
      { to: STRANGER, type: "SIGNAL", payload: { origin: PEER, target: STRANGER, code: "offer" } },
      { to: STRANGER, type: "INVITE", payload: { origin: PEER, target: STRANGER } },
    ]);
    await fromRelay("SIGNAL", { origin: ME, target: STRANGER, code: "offer" });
    expect(sent).toHaveLength(2);
    expect(log).toHaveBeenCalledWith("dropped a SIGNAL relayed for another");
  });

  test("the higher id answers a vouched offer once, back through the same peer", async () => {
    const { sent, pairing, acted, fromRelay } = meshOf({
      me: STRANGER,
      members: { [PEER]: [member(ME)] },
    });
    const offer = { origin: ME, target: STRANGER, code: codeOf("offer", ME) };
    await fromRelay("SIGNAL", offer);
    await fromRelay("SIGNAL", offer);
    expect(pairing.accept).toHaveBeenCalledTimes(1);
    expect(await acted.get(ME)).toEqual({ pairingId: PAIRING_ID, at: NOW });
    expect(sent).toEqual([
      { to: PEER, type: "SIGNAL", payload: { origin: STRANGER, target: ME, code: "answer" } },
    ]);
  });

  test("the lower id connects with the answer", async () => {
    const { sent, pairing, acted, fromRelay } = meshOf();
    const answer = codeOf("answer", STRANGER);
    await fromRelay("SIGNAL", { origin: STRANGER, target: ME, code: answer });
    expect(pairing.accept).toHaveBeenCalledWith(answer);
    expect(await acted.get(STRANGER)).toEqual({ pairingId: PAIRING_ID, at: NOW });
    expect(sent).toEqual([]);
  });

  test("drops a signal its peer did not vouch for, or an offer to the lower id", async () => {
    const codes = [
      codeOf("offer", STRANGER, "99:99"),
      codeOf("offer", PEER),
      "not a code",
      codeOf("offer", STRANGER),
    ];
    const { pairing, log, fromRelay } = meshOf();
    for (const code of codes) await fromRelay("SIGNAL", { origin: STRANGER, target: ME, code });
    expect(pairing.accept).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(3);
  });

  test("an invitation makes the lower id offer, and only it", async () => {
    const lower = meshOf();
    await lower.fromRelay("INVITE", { origin: STRANGER, target: ME });
    expect(lower.sent.map(({ type, to }) => [type, to])).toEqual([["SIGNAL", PEER]]);
    const higher = meshOf({ me: STRANGER, members: { [PEER]: [member(ME)] } });
    await higher.fromRelay("INVITE", { origin: ME, target: STRANGER });
    await higher.fromRelay("TABS_CHANGED", { tabs: [] });
    expect(higher.sent).toEqual([]);
  });
});
