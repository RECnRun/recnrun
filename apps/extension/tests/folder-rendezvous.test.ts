import { describe, expect, test, vi } from "vite-plus/test";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import { PRESENCE_TTL_MS, folderRendezvous, signalFileOf } from "@/p2p/folder-rendezvous";
import type { Presence, SignalFile } from "@/p2p/folder-rendezvous";
import { ME, PEER, STRANGER } from "./fake-peer";
import { MemoryDirectory } from "./memory-directory";

type Directory = Parameters<typeof folderRendezvous>[0];

const NOW = 1_700_000_000_000;
const PAIRING = "44444444-4444-4444-8444-444444444444";
const OTHER_PAIRING = "55555555-5555-4555-8555-555555555555";

function presence(overrides: Partial<Presence> = {}): Presence {
  return {
    profileId: PEER,
    displayName: "Desk",
    fingerprint: "AB:CD:EF",
    createdAt: NOW - 1000,
    expiresAt: NOW + PRESENCE_TTL_MS,
    ...overrides,
  };
}

function signal(overrides: Partial<SignalFile> = {}): SignalFile {
  return {
    kind: "offer",
    pairingId: PAIRING,
    profileId: PEER,
    to: ME,
    expiresAt: NOW + PAIRING_TTL_MS,
    code: "RECNRUN-PAIR-1.code",
    ...overrides,
  };
}

/** The pairing area of a shared folder, as this profile sees it. */
function sharedFolder() {
  const pairing = new MemoryDirectory();
  const rendezvous = folderRendezvous(pairing as unknown as Directory, ME, () => NOW);
  const names = (owner: string) => [...pairing.folder(owner).files.keys()];
  const stored = (owner: string, name: string) =>
    JSON.parse(pairing.folder(owner).files.get(name) ?? "null") as unknown;
  return { pairing, rendezvous, names, stored };
}

describe("signalFileOf", () => {
  test("names the file from the code's own fields, for the one profile it is for", () => {
    const pairing = {
      kind: "answer" as const,
      pairingId: PAIRING,
      profileId: ME,
      displayName: "Laptop",
      expiresAt: NOW + PAIRING_TTL_MS,
      sdp: "v=0\r\n",
    };
    const code = encodePairing(pairing);
    expect(signalFileOf(code, PEER, NOW)).toEqual({
      kind: "answer",
      pairingId: PAIRING,
      profileId: ME,
      to: PEER,
      expiresAt: pairing.expiresAt,
      code,
    });
    expect(() => signalFileOf(code, PEER, pairing.expiresAt)).toThrow("expired");
  });
});

describe("announce and publish", () => {
  test("write whole files into this profile's own folder only", async () => {
    const { pairing, rendezvous, stored } = sharedFolder();
    const mine = presence({ profileId: ME });
    await rendezvous.announce(mine);
    const offer = signal({ profileId: ME, to: PEER });
    await rendezvous.publish(offer);
    expect([...pairing.folders.keys()]).toEqual([ME]);
    expect(stored(ME, "presence.json")).toEqual(mine);
    expect(stored(ME, `offer-${PEER}.json`)).toEqual(offer);
  });

  test("a new signal replaces this profile's earlier one of the same kind for the same profile", async () => {
    const { rendezvous, names, stored } = sharedFolder();
    await rendezvous.announce(presence({ profileId: ME }));
    await rendezvous.publish(signal({ profileId: ME, to: PEER }));
    await rendezvous.publish(signal({ kind: "answer", profileId: ME, to: PEER }));
    const newer = signal({ profileId: ME, to: PEER, pairingId: OTHER_PAIRING });
    await rendezvous.publish(newer);
    // Answers to two offerers in one sighting both stay, each until its offerer reads it.
    await rendezvous.publish(signal({ kind: "answer", profileId: ME, to: STRANGER }));
    expect(names(ME).toSorted()).toEqual(
      [
        `answer-${PEER}.json`,
        `answer-${STRANGER}.json`,
        `offer-${PEER}.json`,
        "presence.json",
      ].toSorted(),
    );
    expect(stored(ME, `offer-${PEER}.json`)).toEqual(newer);
  });
});

describe("look", () => {
  test("sees the other profiles' presences and the signals addressed to this one", async () => {
    const { pairing, rendezvous } = sharedFolder();
    pairing.folder(PEER).drop("presence.json", presence());
    pairing.folder(PEER).drop(`offer-${PAIRING}.json`, signal());
    pairing.folder(STRANGER).drop("presence.json", presence({ profileId: STRANGER }));
    pairing.folder(STRANGER).drop(`offer-${OTHER_PAIRING}.json`, signal({ to: PEER }));
    pairing.folder(ME).drop("presence.json", presence({ profileId: ME }));
    pairing.folder(ME).drop(`offer-${OTHER_PAIRING}.json`, signal({ profileId: ME, to: ME }));
    expect(await rendezvous.look()).toEqual({
      presences: [presence(), presence({ profileId: STRANGER })],
      signals: [signal()],
    });
  });

  test.each([
    ["owned by another profile than its folder", { profileId: STRANGER }],
    ["expired", { expiresAt: NOW }],
    ["not JSON", "{not json"],
    ["not what it claims", { extra: true }],
    ["oversized", "x".repeat(128 * 1024 + 1)],
  ])("ignores a file that is %s and reads on", async (_, damage) => {
    const { pairing, rendezvous } = sharedFolder();
    const spoil = (value: object) =>
      typeof damage === "string" ? damage : { ...value, ...damage };
    pairing.folder(PEER).drop("presence.json", spoil(presence()));
    pairing.folder(PEER).drop(`offer-${PAIRING}.json`, spoil(signal()));
    const valid = signal({ profileId: STRANGER, pairingId: OTHER_PAIRING });
    pairing.folder(STRANGER).drop(`offer-${OTHER_PAIRING}.json`, valid);
    expect(await rendezvous.look()).toEqual({ presences: [], signals: [valid] });
  });

  test("ignores names it does not write and folders that are not profiles", async () => {
    const { pairing, rendezvous } = sharedFolder();
    pairing.folder(PEER).drop(`offer-${PAIRING}.json.bak`, signal());
    pairing.folder(PEER).drop("offer-not-a-uuid.json", signal());
    pairing.folder("not-a-profile").drop("presence.json", presence());
    pairing.drop(STRANGER, "a file where a folder would be");
    const opened = vi.spyOn(pairing, "getDirectoryHandle");
    expect(await rendezvous.look()).toEqual({ presences: [], signals: [] });
    expect(opened.mock.calls.map(([name]) => name)).toEqual([PEER, STRANGER]);
  });
});

describe("clean", () => {
  test("removes this profile's presence and signals, and nothing else", async () => {
    const { pairing, rendezvous, names } = sharedFolder();
    await rendezvous.announce(presence({ profileId: ME }));
    await rendezvous.publish(signal({ profileId: ME, to: PEER }));
    pairing.folder(ME).drop("notes.txt", "kept");
    pairing.folder(PEER).drop("presence.json", presence());
    await rendezvous.clean();
    expect(names(ME)).toEqual(["notes.txt"]);
    expect(names(PEER)).toEqual(["presence.json"]);
  });
});
