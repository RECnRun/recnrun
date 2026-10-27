import { describe, expect, test, vi } from "vite-plus/test";
import { createFolderPairing, decideFolderSteps } from "@/background/folder-pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import type { FolderActed, FolderPairing, PeerLink, PendingOffer } from "@/storage/peer-repository";
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
  skip: [] as string[],
  pending: {} as Record<string, PendingOffer>,
  acted: {} as Record<string, FolderActed>,
  now: NOW,
});

describe("decideFolderSteps", () => {
  test("does nothing while no other profile is in the folder", () => {
    expect(decideFolderSteps(situation(ME, seen([])))).toEqual([]);
  });

  test("offers to every profile in the folder whose id is higher", () => {
    const sighting = seen([presence(PEER, NOW - 10), presence(STRANGER, NOW - 20)]);
    expect(decideFolderSteps(situation(ME, sighting))).toEqual([
      { type: "offer", to: presence(PEER, NOW - 10) },
      { type: "offer", to: presence(STRANGER, NOW - 20) },
    ]);
  });

  test("leaves alone the profiles it skips, as linked or paused", () => {
    const sighting = seen([presence(PEER), presence(STRANGER)]);
    const linked = { ...situation(ME, sighting), skip: [PEER] };
    expect(decideFolderSteps(linked)).toEqual([{ type: "offer", to: presence(STRANGER) }]);
  });

  test("waits for the answer to its current offer, then connects with it", () => {
    const pending = { [PEER]: pendingFor(PEER) };
    const waiting = { ...situation(ME, seen([presence(PEER)])), pending };
    expect(decideFolderSteps(waiting)).toEqual([]);
    const answer = signal("answer", PEER, ME);
    const answered = { ...waiting, seen: seen([presence(PEER)], [answer]) };
    expect(decideFolderSteps(answered)).toEqual([{ type: "connect", answer }]);
  });

  test("offers again when its offer expired, and an offer to another profile does not count", () => {
    const sighting = seen([presence(PEER)]);
    const expired = { ...situation(ME, sighting), pending: { [PEER]: pendingFor(PEER, NOW) } };
    expect(decideFolderSteps(expired)).toEqual([{ type: "offer", to: presence(PEER) }]);
    const elsewhere = { ...situation(ME, sighting), pending: { [STRANGER]: pendingFor(STRANGER) } };
    expect(decideFolderSteps(elsewhere)).toEqual([{ type: "offer", to: presence(PEER) }]);
  });

  test("answers an offer made for it when the other profile's id is lower", () => {
    const offer = signal("offer", PEER, STRANGER);
    const sighting = seen([presence(PEER)], [offer]);
    expect(decideFolderSteps(situation(STRANGER, sighting))).toEqual([{ type: "answer", offer }]);
    expect(decideFolderSteps(situation(STRANGER, seen([presence(PEER)])))).toEqual([]);
  });

  test("answers B's offer and offers to D in the same sighting", () => {
    // PEER sits between ME and STRANGER: it answers the lower id and offers to the higher.
    const offer = signal("offer", ME, PEER);
    const sighting = seen([presence(ME), presence(STRANGER)], [offer]);
    expect(decideFolderSteps(situation(PEER, sighting))).toEqual([
      { type: "answer", offer },
      { type: "offer", to: presence(STRANGER) },
    ]);
  });

  test("answers an offer once, and a newer one at once, since the offerer gave up the last", () => {
    const offer = signal("offer", PEER, STRANGER);
    const sighting = seen([presence(PEER)], [offer]);
    const acted = { [PEER]: { pairingId: OFFER_ID, at: NOW - 1 } };
    const answered = { ...situation(STRANGER, sighting), acted };
    expect(decideFolderSteps(answered)).toEqual([]);
    const newer = signal("offer", PEER, STRANGER, { pairingId: OTHER_ID });
    const again = { ...answered, seen: seen([presence(PEER)], [newer]) };
    expect(decideFolderSteps(again)).toEqual([{ type: "answer", offer: newer }]);
  });

  test("gives the link time after connecting before it offers again", () => {
    const sighting = seen([presence(PEER)]);
    const acted = { [PEER]: { pairingId: OFFER_ID, at: NOW - 29_999 } };
    const connected = { ...situation(ME, sighting), acted };
    expect(decideFolderSteps(connected)).toEqual([]);
    const later = { ...connected, acted: { [PEER]: { pairingId: OFFER_ID, at: NOW - 30_000 } } };
    expect(decideFolderSteps(later)).toEqual([{ type: "offer", to: presence(PEER) }]);
  });

  test("the retry for one pair does not hold back another", () => {
    const sighting = seen([presence(PEER), presence(STRANGER)]);
    const acted = { [PEER]: { pairingId: OFFER_ID, at: NOW - 1 } };
    expect(decideFolderSteps({ ...situation(ME, sighting), acted })).toEqual([
      { type: "offer", to: presence(STRANGER) },
    ]);
  });

  test.each([
    ["announces another certificate than the presence", { fingerprint: "99:99" }],
    ["was made by another profile than its file says", { codeFrom: ME }],
    ["holds an expired code", { expiresAt: NOW }],
  ])("ignores a signal whose code %s", (_, options: SignalOptions) => {
    const answer = signal("answer", PEER, ME, options);
    const pending = { [PEER]: pendingFor(PEER) };
    const answered = { ...situation(ME, seen([presence(PEER)], [answer])), pending };
    expect(decideFolderSteps(answered)).toEqual([]);
  });

  test("ignores a signal whose code is another kind than its file", () => {
    const offer = { ...signal("answer", PEER, STRANGER), kind: "offer" as const };
    expect(decideFolderSteps(situation(STRANGER, seen([presence(PEER)], [offer])))).toEqual([]);
  });
});

/** The background's folder pairing over fakes, as profile `me`, whose link is idle. */
function folderPairing(
  initial: FolderPairing | null = {},
  me = ME,
  initialActed: Record<string, FolderActed> = {},
) {
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
  const acted = memoryRecords<FolderActed>(initialActed);
  const link = memoryRecords<PeerLink>();
  const log = vi.fn();
  const flow = createFolderPairing({
    askLink,
    identity: async () => ({ profileId: me, displayName: "Laptop" }),
    pairing,
    pending,
    link,
    acted,
    state,
    log,
    now: () => NOW,
  });
  return { flow, commands, pairing, state, acted, link, pending, log, offer, answer };
}

describe("createFolderPairing", () => {
  test("starts and resumes waiting in the folder as this profile", async () => {
    const { flow, commands, state } = folderPairing(null);
    await flow.pause(PEER);
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
    const { flow, commands, pairing, acted, answer } = folderPairing({}, STRANGER);
    const made = signal("offer", PEER, STRANGER);
    await flow.seen(seen([presence(PEER)], [made]));
    expect(pairing.accept).toHaveBeenCalledWith(made.code);
    expect(commands).toEqual([{ type: "folder-publish", signal: answer }]);
    expect(await acted.all()).toEqual({ [PEER]: { pairingId: OFFER_ID, at: NOW } });
  });

  test("connects with the answer to its offer", async () => {
    const { flow, commands, pairing, acted, pending } = folderPairing();
    await pending.set(PEER, pendingFor(PEER));
    const answer = signal("answer", PEER, ME);
    await flow.seen(seen([presence(PEER)], [answer]));
    expect(pairing.accept).toHaveBeenCalledWith(answer.code);
    expect(commands).toEqual([]);
    expect(await acted.all()).toEqual({ [PEER]: { pairingId: OFFER_ID, at: NOW } });
  });

  test("offers again at once when a link that came up drops, with no wait for it", async () => {
    const { flow, pairing } = folderPairing({}, ME, { [PEER]: { pairingId: OFFER_ID, at: NOW } });
    await flow.seen(seen([presence(PEER)]));
    expect(pairing.createOffer).not.toHaveBeenCalled();
    await flow.linked(STRANGER);
    await flow.seen(seen([presence(PEER)]));
    expect(pairing.createOffer).not.toHaveBeenCalled();
    await flow.linked(PEER);
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
    // The presence stays in the folder, so the peer finds this profile after a restart.
    expect(await state.read()).toEqual({});
    expect(commands).toEqual([]);
    expect(pairing.createOffer).not.toHaveBeenCalled();
  });

  test("offers to C while linked to B", async () => {
    const { flow, pairing, link } = folderPairing();
    await link.set(PEER, { state: "connected", verified: true });
    await flow.seen(seen([presence(PEER), presence(STRANGER)]));
    expect(pairing.createOffer.mock.calls).toEqual([[STRANGER]]);
  });

  test("leaves a paused profile alone until it is unpaused, then looks again at once", async () => {
    const { flow, pairing, commands } = folderPairing();
    const both = seen([presence(PEER), presence(STRANGER)]);
    for (const id of [PEER, STRANGER]) await flow.pause(id);
    await flow.start();
    await flow.seen(both);
    expect(pairing.createOffer).not.toHaveBeenCalled();
    await flow.unpause(PEER);
    expect(commands.map(({ type }) => type)).toEqual(["folder-watch", "folder-watch"]);
    await flow.seen(both);
    expect(pairing.createOffer.mock.calls).toEqual([[PEER]]);
    await flow.unpauseAll();
    expect([await flow.paused(), commands.at(-1)?.type]).toEqual([[], "folder-watch"]);
  });

  test("a step that fails leaves the others in the same sighting", async () => {
    const { flow, pairing, log } = folderPairing();
    pairing.createOffer.mockRejectedValueOnce(new Error("No link."));
    await flow.seen(seen([presence(PEER), presence(STRANGER)]));
    expect(log).toHaveBeenCalledWith("folder pairing: No link.");
    expect(pairing.createOffer.mock.calls).toEqual([[PEER], [STRANGER]]);
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
