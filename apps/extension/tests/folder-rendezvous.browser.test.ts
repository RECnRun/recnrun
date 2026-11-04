import { expect, test } from "vite-plus/test";
import { decideFolderSteps } from "@/background/folder-pairing";
import { PRESENCE_TTL_MS, folderRendezvous, signalFileOf } from "@/p2p/folder-rendezvous";
import type { FolderPresence, Seen, SignalFile, StampedSignal } from "@/p2p/folder-rendezvous";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import { signAs } from "./test-identity";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PAIRING = "44444444-4444-4444-8444-444444444444";
const FINGERPRINTS: Record<string, string> = { [A]: "AA:AA", [B]: "BB:BB" };
const BOOT = "66666666-6666-4666-8666-666666666666";
const STATEMENTS = {
  [A]: await signAs({ profileId: A, fingerprint: "AA:AA" }),
  [B]: await signAs({ profileId: B, fingerprint: "BB:BB" }),
};
const statementOf = (profileId: string) => (profileId === A ? STATEMENTS[A] : STATEMENTS[B]);

const presence = (profileId: string): FolderPresence => ({
  profileId,
  displayName: profileId === A ? "Laptop" : "Desk",
  fingerprint: FINGERPRINTS[profileId] ?? "",
  identity: statementOf(profileId),
  createdAt: Date.now(),
  expiresAt: Date.now() + PRESENCE_TTL_MS,
  boot: BOOT,
});

/** The signal `from` leaves for `to`, its code announcing `from`'s certificate. */
const signalOf = (kind: SignalFile["kind"], from: string, to: string): StampedSignal => ({
  ...signalFileOf(
    encodePairing({
      kind,
      pairingId: PAIRING,
      profileId: from,
      displayName: "Profile",
      expiresAt: Date.now() + PAIRING_TTL_MS,
      sdp: `v=0\r\na=fingerprint:sha-256 ${FINGERPRINTS[from] ?? ""}\r\n`,
      identity: statementOf(from),
    }),
    to,
  ),
  boot: BOOT,
  sequence: 1,
});

/** What profile `me` does about what it sees, as a profile that has done nothing yet. */
const step = (me: string, seen: Seen, pending: { to: string } | null = null) =>
  decideFolderSteps({
    me,
    seen,
    skip: [],
    pending: pending
      ? {
          [pending.to]: {
            ...pending,
            pairingId: PAIRING,
            expiresAt: Date.now() + 60_000,
            code: "",
          },
        }
      : {},
    acted: {},
    answered: {},
    now: Date.now(),
  });

async function entries(folder: FileSystemDirectoryHandle): Promise<string[]> {
  const found: string[] = [];
  for await (const [name, handle] of folder.entries()) {
    found.push(name);
    if (handle instanceof FileSystemDirectoryHandle) {
      for (const inner of await entries(handle)) found.push(`${name}/${inner}`);
    }
  }
  return found.toSorted();
}

test("two profiles in one real folder find each other and cross an offer and an answer", async () => {
  const root = await navigator.storage.getDirectory();
  await root.removeEntry("rendezvous", { recursive: true }).catch(() => {});
  const pairing = await root.getDirectoryHandle("rendezvous", { create: true });
  const [a, b] = [folderRendezvous(pairing, A), folderRendezvous(pairing, B)];
  await a.announce(presence(A));
  await b.announce(presence(B));

  const offer = signalOf("offer", A, B);
  expect(step(A, await a.look())).toMatchObject([{ type: "offer", to: { profileId: B } }]);
  await a.publish(offer);
  expect(step(B, await b.look())).toEqual([{ type: "answer", offer }]);

  const answer = signalOf("answer", B, A);
  await b.publish(answer);
  expect(step(A, await a.look(), { to: B })).toEqual([{ type: "connect", answer }]);
  // B sees its own answer, which tells a relaunch what it answered; A never sees the offer it made.
  expect((await b.look()).signals).toEqual([answer, offer]);
  expect((await a.look()).signals).toEqual([answer]);

  await a.clean();
  await b.clean();
  expect(await entries(pairing)).toEqual([A, B]);
});
