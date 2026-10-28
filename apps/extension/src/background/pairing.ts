import type { LinkCommand } from "@/messaging/peer-messages";
import {
  PAIRING_TTL_MS,
  decodePairing,
  encodePairing,
  fingerprintOf,
  shortAuthenticationString,
} from "@/p2p/pairing-code";
import type { Pairing } from "@/p2p/pairing-code";
import type {
  AuthorizedPeer,
  PendingOffer,
  ProfileIdentity,
  Repository,
} from "@/storage/peer-repository";

export interface PairingDependencies {
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  authorized: Pick<Repository<AuthorizedPeer>, "read" | "write">;
  pending: Pick<Repository<PendingOffer>, "read" | "write">;
  now?: () => number;
}

/** What the user checks before accepting: who made the code, and the six digits. */
export interface PairingPreview {
  kind: Pairing["kind"];
  profileId: string;
  displayName: string;
  digits: string;
  /** The authorized peer, with the same certificate, as when pairing again after a disconnect. */
  known: boolean;
}

const sdpOf = (result: unknown) => (result as { sdp: string }).sdp;

/** Decodes a pasted code: another profile's, and for an answer, one to this profile's offer. */
async function verifyCode(code: string, deps: PairingDependencies, now: number) {
  const pairing = decodePairing(code, now);
  const me = await deps.identity();
  if (pairing.profileId === me.profileId) throw new Error("This code comes from this profile.");
  if (pairing.kind === "answer") {
    const pending = await deps.pending.read();
    if (pending?.pairingId !== pairing.pairingId || pending.expiresAt <= now) {
      throw new Error("This answer is not for the offer this profile made.");
    }
  }
  const fingerprint = fingerprintOf(pairing.sdp);
  if (!fingerprint) throw new Error("The code has no certificate fingerprint.");
  return { pairing, fingerprint };
}

/**
 * Manual pairing: A creates an offer; B inspects it and its user accepts, which answers; A
 * inspects the answer and its user confirms that both profiles show the same digits.
 */
export function createPairing(deps: PairingDependencies) {
  const now = deps.now ?? Date.now;
  const half = async (kind: Pairing["kind"], pairingId: string, sdp: string) => {
    const me = await deps.identity();
    return encodePairing({ kind, pairingId, ...me, expiresAt: now() + PAIRING_TTL_MS, sdp });
  };
  /** An offer for whoever imports it, or through the folder, for the profile `to`. */
  const createOffer = async (to?: string) => {
    const pairingId = crypto.randomUUID();
    const sdp = sdpOf(await deps.askLink({ type: "offer" }));
    await deps.pending.write({ pairingId, expiresAt: now() + PAIRING_TTL_MS, ...(to && { to }) });
    return { code: await half("offer", pairingId, sdp) };
  };
  const inspect = async (code: string): Promise<PairingPreview> => {
    const { pairing, fingerprint } = await verifyCode(code, deps, now());
    const mine = (await deps.askLink({ type: "fingerprint" })) as { fingerprint: string };
    const peer = await deps.authorized.read();
    const { kind, profileId, displayName } = pairing;
    const digits = await shortAuthenticationString(mine.fingerprint, fingerprint);
    const known = peer?.profileId === profileId && peer.fingerprint === fingerprint;
    return { kind, profileId, displayName, digits, known };
  };
  const accept = async (code: string): Promise<{ code?: string }> => {
    const { pairing, fingerprint } = await verifyCode(code, deps, now());
    const { profileId, displayName } = pairing;
    // The user accepted this profile, which replaces any earlier one: one peer at a time.
    await deps.authorized.write({ profileId, displayName, fingerprint });
    if (pairing.kind === "offer") {
      const answer = sdpOf(await deps.askLink({ type: "answer", sdp: pairing.sdp }));
      return { code: await half("answer", pairing.pairingId, answer) };
    }
    await deps.askLink({ type: "accept-answer", sdp: pairing.sdp });
    await deps.pending.write(null);
    return {};
  };
  return { createOffer, inspect, accept };
}

export type PairingFlow = ReturnType<typeof createPairing>;
