import { createPins } from "@/p2p/pins";
import { createRoles } from "@/p2p/roles";
import { roleStores } from "@/storage/hierarchy-repository";
import { peerPinsRepository } from "@/storage/peer-repository";
import { identityOf } from "./test-identity";

export const NOW = 1_700_000_000_000;
export const ME = "11111111-1111-4111-8111-111111111111";
// The Default's id sorts after its workers' ids, so the offerer election picks a worker.
export const MASTER = "ffffffff-ffff-4fff-8fff-ffffffffffff";
export const LOW_WORKER = "00000000-0000-4000-8000-000000000000";
export const OTHER_MASTER = "33333333-3333-4333-8333-333333333333";
export const CLONE = "44444444-4444-4444-8444-444444444444";
export const FINGERPRINT = "AB:CD:EF";
export const MASTER_KEY = await identityOf(MASTER);
export const OTHER_KEY = await identityOf("other");

export const pins = () => createPins(peerPinsRepository(), () => NOW);
export const stores = roleStores();
export const { role: roleRepository, workers: boundWorkersRepository } = stores;
export const roles = () => createRoles({ ...stores, pins: pins(), now: () => NOW });
export const master = { profileId: MASTER, identity: MASTER_KEY, source: "pairing" } as const;
export const binding = {
  role: "worker",
  masterProfileId: MASTER,
  masterIdentity: MASTER_KEY,
  boundAt: NOW,
  source: "pairing",
};

/** A link proved a certificate `identity` signed for `profileId`, as a first verified link pins it. */
export const proved = (profileId: string, identity: string) =>
  pins().pin(profileId, { identity, fingerprint: FINGERPRINT }, "pairing-code");
