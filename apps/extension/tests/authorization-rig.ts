import { vi } from "vite-plus/test";
import { expect } from "vite-plus/test";
import { createPeerChannel } from "@/background/peer-channel";
import { peerMessage } from "@/p2p/protocol";
import type { PeerMessage, PeerPayload, PeerType } from "@/p2p/protocol";
import { createPins } from "@/p2p/pins";
import { storedRoles } from "@/storage/hierarchy-repository";
import { peerPinsRepository } from "@/storage/peer-repository";
import { identityOf } from "./test-identity";

export const ME = "11111111-1111-4111-8111-111111111111";
// The Default's id sorts after its workers' ids, so the offerer election picks a worker.
export const MASTER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const WORKER = "22222222-2222-4222-8222-222222222222";
export const LOW_WORKER = "00000000-0000-4000-8000-000000000000";
export const STRANGER = "33333333-3333-4333-8333-333333333333";
const FINGERPRINTS: Record<string, string> = {
  [ME]: "11:11",
  [MASTER]: "AA:AA",
  [WORKER]: "22:22",
  [LOW_WORKER]: "00:00",
  [STRANGER]: "33:33",
};
export const fp = (profileId: string) => FINGERPRINTS[profileId] ?? "";
export const KEYS: Record<string, string> = Object.fromEntries(
  await Promise.all(Object.keys(FINGERPRINTS).map(async (id) => [id, await identityOf(id)])),
);
export const key = (profileId: string) => KEYS[profileId] ?? "";
export const OTHER_KEY = await identityOf("other");

/** This profile's channel, with every peer authorized and linked under its certificate and key. */
export function channel(identities: Record<string, string> = KEYS) {
  const log = vi.fn<(entry: string) => void>();
  const sent: PeerMessage[] = [];
  const created = createPeerChannel({
    askLink: async (command) => {
      if (command.type === "send") sent.push(JSON.parse(command.frame) as PeerMessage);
      return { sent: true };
    },
    identity: async () => ({ profileId: ME, displayName: "Me" }),
    authorized: {
      get: async (id) => ({
        profileId: id,
        displayName: "Peer",
        fingerprint: fp(id),
        identity: identities[id] ?? "",
      }),
    },
    link: { get: async () => ({ state: "connected", verified: true }) },
    log,
    replyTimeoutMs: 50,
  });
  return { ...created, log, sent };
}

export const from = <T extends PeerType>(type: T, author: string, payload: PeerPayload<T>) =>
  peerMessage(type, { from: author, to: ME }, payload);
export const frame = (message: PeerMessage) => JSON.stringify(message);
export const start = (author: string) => from("SESSION_START", author, { tabId: 7 });

/** The first verified link to each peer pins its key, as pairing-flows does. */
export async function meet(...peers: string[]) {
  const pins = createPins(peerPinsRepository());
  for (const peer of peers)
    await pins.pin(peer, { identity: key(peer), fingerprint: fp(peer) }, "pairing-code");
}

export async function workerOf(master: string) {
  await meet(master);
  const bound = await storedRoles().bind({
    profileId: master,
    identity: key(master),
    source: "pairing",
  });
  expect(bound.ok).toBe(true);
}

export async function masterOf(...workers: string[]) {
  const roles = storedRoles();
  await roles.becomeMaster({ profileId: ME, identity: key(ME) });
  await meet(...workers);
  for (const worker of workers)
    await roles.bindWorker({ profileId: worker, identity: key(worker), source: "pairing" });
}
