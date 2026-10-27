import { expect, test } from "vite-plus/test";
import { decideFolderSteps } from "@/background/folder-pairing";
import { PRESENCE_TTL_MS, folderRendezvous, signalFileOf } from "@/p2p/folder-rendezvous";
import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const PAIRING = "44444444-4444-4444-8444-444444444444";
const FINGERPRINTS: Record<string, string> = { [A]: "AA:AA", [B]: "BB:BB" };

const presence = (profileId: string): Presence => ({
  profileId,
  displayName: profileId === A ? "Laptop" : "Desk",
  fingerprint: FINGERPRINTS[profileId] ?? "",
  createdAt: Date.now(),
  expiresAt: Date.now() + PRESENCE_TTL_MS,
});

/** The signal `from` leaves for `to`, its code announcing `from`'s certificate. */
const signalOf = (kind: SignalFile["kind"], from: string, to: string) =>
  signalFileOf(
    encodePairing({
      kind,
      pairingId: PAIRING,
      profileId: from,
      displayName: "Profile",
      expiresAt: Date.now() + PAIRING_TTL_MS,
      sdp: `v=0\r\na=fingerprint:sha-256 ${FINGERPRINTS[from] ?? ""}\r\n`,
    }),
    to,
  );

/** What profile `me` does about what it sees, as a profile that has done nothing yet. */
const step = (me: string, seen: Seen, pending: { to: string } | null = null) =>
  decideFolderSteps({
    me,
    seen,
    skip: [],
    pending: pending
      ? { [pending.to]: { ...pending, pairingId: PAIRING, expiresAt: Date.now() + 60_000 } }
      : {},
    acted: {},
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
  // B never sees its own answer, nor A the offer it made.
  expect((await b.look()).signals).toEqual([offer]);

  await a.clean();
  await b.clean();
  expect(await entries(pairing)).toEqual([A, B]);
});
