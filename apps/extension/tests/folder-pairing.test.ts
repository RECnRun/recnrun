import { describe, expect, test, vi } from "vite-plus/test";
import { createFolderPairing, decideFolderStep } from "@/background/folder-pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import type { FolderPairing, PeerLink, PendingOffer } from "@/storage/peer-repository";
import { ME, PEER, STRANGER, memoryRecords, memoryRepository } from "./fake-peer";

const NOW = 1_700_000_000_000;
const OFFER_ID = "44444444-4444-4444-8444-444444444444";
const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const FINGERPRINTS: Record<string, string> = {
  [ME]: "11:11",
  [PEER]: "22:22",
  [STRANGER]: "33:33",
};

const presence = (profileId: string, createdAt = NOW - 1000): Presence => ({
  profileId,
  displayName: `Profile ${profileId.slice(0, 1)}`,
  fingerprint: FINGERPRINTS[profileId] ?? "",
  createdAt,
  expiresAt: NOW + 60_000,
});

interface SignalOptions {
  pairingId?: string;
  fingerprint?: string;
  codeFrom?: string;
  expiresAt?: number;
}

/** A signal `from` made for `to`, whose code announces `from`'s certificate unless told otherwise. */
function signal(kind: SignalFile["kind"], from: string, to: string, options: SignalOptions = {}) {
  const { pairingId = OFFER_ID, codeFrom = from, expiresAt = NOW + PAIRING_TTL_MS } = options;
  const fingerprint = options.fingerprint ?? FINGERPRINTS[from] ?? "";
  const code = encodePairing({
    kind,
    pairingId,
    profileId: codeFrom,
    displayName: "Profile",
    expiresAt,
    sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`,
  });
  return { kind, pairingId, profileId: from, to, expiresAt, code } satisfies SignalFile;
}

const seen = (presences: Presence[], signals: SignalFile[] = []): Seen => ({ presences, signals });
const pendingFor = (to: string, expiresAt = NOW + 1000): PendingOffer => ({
  pairingId: OFFER_ID,
  expiresAt,
  to,
});
const situation = (me: string, sighting: Seen) => ({
  me,
  seen: sighting,
  peers: [] as string[],
  pending: {} as Record<string, PendingOffer>,
  state: {},
  now: NOW,
});

describe("decideFolderStep", () => {
  test("waits while no other profile is in the folder", () => {
    expect(decideFolderStep(situation(ME, seen([])))).toEqual({ type: "wait" });
  });

  test("offers to the profile that has waited longest, when this one's id is lower", () => {
    const sighting = seen([presence(PEER, NOW - 10), presence(STRANGER, NOW - 20)]);
    expect(decideFolderStep(situation(ME, sighting))).toEqual({
      type: "offer",
      to: presence(STRANGER, NOW - 20),
    });
  });

  test("once a peer is pinned, pairs only with it", () => {
    const older = presence(STRANGER, NOW - 50);
    const pinned = { ...situation(ME, seen([older, presence(PEER)])), peers: [PEER] };
    expect(decideFolderStep(pinned)).toEqual({ type: "offer", to: presence(PEER) });
    expect(decideFolderStep({ ...pinned, seen: seen([older]) })).toEqual({ type: "wait" });
  });

  test("waits for the answer to its current offer, then connects with it", () => {
    const pending = { [PEER]: pendingFor(PEER) };
    const waiting = { ...situation(ME, seen([presence(PEER)])), pending };
    expect(decideFolderStep(waiting)).toEqual({ type: "wait" });
    const answer = signal("answer", PEER, ME);
    const answered = { ...waiting, seen: seen([presence(PEER)], [answer]) };
    expect(decideFolderStep(answered)).toEqual({ type: "connect", answer });
  });

  test("offers again when its offer expired or was for another profile", () => {
    const sighting = seen([presence(PEER)]);
    const expired = { ...situation(ME, sighting), pending: { [PEER]: pendingFor(PEER, NOW) } };
    expect(decideFolderStep(expired).type).toBe("offer");
    const elsewhere = { ...situation(ME, sighting), pending: { [STRANGER]: pendingFor(STRANGER) } };
    expect(decideFolderStep(elsewhere).type).toBe("offer");
  });

  test("answers an offer made for it when the other profile's id is lower", () => {
    const offer = signal("offer", PEER, STRANGER);
    const sighting = seen([presence(PEER)], [offer]);
    expect(decideFolderStep(situation(STRANGER, sighting))).toEqual({ type: "answer", offer });
    expect(decideFolderStep(situation(STRANGER, seen([presence(PEER)])))).toEqual({
      type: "wait",
    });
  });

  test("answers an offer once, and a newer one at once, since the offerer gave up the last", () => {
    const offer = signal("offer", PEER, STRANGER);
    const sighting = seen([presence(PEER)], [offer]);
    const acted = { pairingId: OFFER_ID, at: NOW - 1 };
    const answered = { ...situation(STRANGER, sighting), state: { acted } };
    expect(decideFolderStep(answered)).toEqual({ type: "wait" });
    const newer = signal("offer", PEER, STRANGER, { pairingId: OTHER_ID });
    const again = { ...answered, seen: seen([presence(PEER)], [newer]) };
    expect(decideFolderStep(again)).toEqual({ type: "answer", offer: newer });
  });

  test("gives the link time after connecting before it offers again", () => {
    const sighting = seen([presence(PEER)]);
    const acted = { pairingId: OFFER_ID, at: NOW - 29_999 };
    const connected = { ...situation(ME, sighting), state: { acted } };
    expect(decideFolderStep(connected)).toEqual({ type: "wait" });
    const later = { ...connected, state: { acted: { ...acted, at: NOW - 30_000 } } };
    expect(decideFolderStep(later)).toEqual({ type: "offer", to: presence(PEER) });
  });

  test.each([
    ["announces another certificate than the presence", { fingerprint: "99:99" }],
    ["was made by another profile than its file says", { codeFrom: ME }],
    ["holds an expired code", { expiresAt: NOW }],
  ])("ignores a signal whose code %s", (_, options: SignalOptions) => {
    const answer = signal("answer", PEER, ME, options);
    const pending = { [PEER]: pendingFor(PEER) };
    const answered = { ...situation(ME, seen([presence(PEER)], [answer])), pending };
    expect(decideFolderStep(answered)).toEqual({ type: "wait" });
  });

  test("ignores a signal whose code is another kind than its file", () => {
    const offer = { ...signal("answer", PEER, STRANGER), kind: "offer" as const };
    expect(decideFolderStep(situation(STRANGER, seen([presence(PEER)], [offer])))).toEqual({
      type: "wait",
    });
  });
});

/** The background's folder pairing over fakes, as profile `me`, whose link is idle. */
function folderPairing(initial: FolderPairing | null = {}, me = ME) {
  const commands: LinkCommand[] = [];
  const askLink = vi.fn(async (command: LinkCommand) => void commands.push(command));
  const pending = memoryRecords<PendingOffer>();
  const offer = signal("offer", me, PEER);
  const answer = signal("answer", me, PEER);
  const pairing = {
    createOffer: vi.fn(async (to: string) => {
      await pending.set(to, { pairingId: OFFER_ID, expiresAt: NOW + PAIRING_TTL_MS, to });
      return { code: offer.code };
    }),
    accept: vi.fn(async (_code: string): Promise<{ code?: string }> => ({ code: answer.code })),
  };
  const state = memoryRepository<FolderPairing>(initial);
  const link = memoryRecords<PeerLink>();
  const log = vi.fn();
  const flow = createFolderPairing({
    askLink,
    identity: async () => ({ profileId: me, displayName: "Laptop" }),
    pairing,
    authorized: memoryRecords(),
    pending,
    link,
    state,
    log,
    now: () => NOW,
  });
  return { flow, commands, pairing, state, link, pending, log, offer, answer };
}

describe("createFolderPairing", () => {
  test("starts and resumes waiting in the folder as this profile", async () => {
    const { flow, commands, state } = folderPairing(null);
    await flow.resume();
    expect(commands).toEqual([]);
    await flow.start();
    expect(await state.read()).toEqual({});
    await flow.resume();
    const watch = { type: "folder-watch", profileId: ME, displayName: "Laptop" };
    expect(commands).toEqual([watch, watch]);
  });

  test("publishes its offer for the partner, one at a time", async () => {
    const { flow, commands, pairing, offer } = folderPairing();
    await Promise.all([flow.seen(seen([presence(PEER)])), flow.seen(seen([presence(PEER)]))]);
    expect(pairing.createOffer).toHaveBeenCalledOnce();
    expect(pairing.createOffer).toHaveBeenCalledWith(PEER);
    expect(commands).toEqual([{ type: "folder-publish", signal: offer }]);
  });

  test("answers an offer, publishing the answer for the offerer", async () => {
    const { flow, commands, pairing, state, answer } = folderPairing({}, STRANGER);
    const made = signal("offer", PEER, STRANGER);
    await flow.seen(seen([presence(PEER)], [made]));
    expect(pairing.accept).toHaveBeenCalledWith(made.code);
    expect(commands).toEqual([{ type: "folder-publish", signal: answer }]);
    expect(await state.read()).toEqual({ acted: { pairingId: OFFER_ID, at: NOW } });
  });

  test("connects with the answer to its offer", async () => {
    const { flow, commands, pairing, state, pending } = folderPairing();
    await pending.set(PEER, pendingFor(PEER));
    const answer = signal("answer", PEER, ME);
    await flow.seen(seen([presence(PEER)], [answer]));
    expect(pairing.accept).toHaveBeenCalledWith(answer.code);
    expect(commands).toEqual([]);
    expect(await state.read()).toEqual({ acted: { pairingId: OFFER_ID, at: NOW } });
  });

  test("offers again at once when a link that came up drops, with no wait for it", async () => {
    const { flow, pairing } = folderPairing({ acted: { pairingId: OFFER_ID, at: NOW } });
    await flow.seen(seen([presence(PEER)]));
    expect(pairing.createOffer).not.toHaveBeenCalled();
    await flow.linked();
    await flow.seen(seen([presence(PEER)]));
    expect(pairing.createOffer).toHaveBeenCalledWith(PEER);
  });

  test("ignores sightings unless waiting, and keeps waiting while the link is verified", async () => {
    const idle = folderPairing(null);
    await idle.flow.seen(seen([presence(PEER)]));
    expect(idle.pairing.createOffer).not.toHaveBeenCalled();
    const { flow, commands, state, link, pairing } = folderPairing();
    await link.set(PEER, { state: "connected", verified: true });
    await flow.seen(seen([presence(PEER)]));
    // The presence stays in the folder, so the pinned peer finds this profile after a restart.
    expect(await state.read()).toEqual({});
    expect(commands).toEqual([]);
    expect(pairing.createOffer).not.toHaveBeenCalled();
  });

  test("logs a step that fails, and handles the next sighting", async () => {
    const { flow, pairing, log } = folderPairing();
    pairing.createOffer.mockRejectedValueOnce(new Error("No link."));
    await flow.seen(seen([presence(PEER)]));
    expect(log).toHaveBeenCalledWith("folder pairing: No link.");
    await flow.seen(seen([presence(PEER)]));
    expect(pairing.createOffer).toHaveBeenCalledTimes(2);
  });
});
