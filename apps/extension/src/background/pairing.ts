import type { LinkCommand } from "@/messaging/peer-messages";
import { signerOf } from "@/p2p/identity-key";
import type { IdentityClaim, IdentityStatement } from "@/p2p/identity-key";
import { PAIRING_TTL_MS, decodePairing, encodePairing, fingerprintOf } from "@/p2p/pairing-code";
import type { Pairing } from "@/p2p/pairing-code";
import type { Pins } from "@/p2p/pins";
import type {
  AuthorizedPeer,
  PeerRecords,
  PendingOffer,
  ProfileIdentity,
} from "@/storage/peer-repository";

export interface PairingDependencies {
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  authorized: Pick<PeerRecords<AuthorizedPeer>, "set">;
  /** This profile's offers waiting for an answer, by the profile each is for. */
  pending: Pick<PeerRecords<PendingOffer>, "get" | "set">;
  /** A code's certificate must be signed by a pinned profile's identity; the link pins, never the code. */
  pins: Pick<Pins, "verify">;
  /** This profile's statement, by its identity key, that a certificate is its own. */
  sign: (claim: IdentityClaim) => Promise<IdentityStatement>;
  now?: () => number;
}

const sdpOf = (result: unknown) => (result as { sdp: string }).sdp;

/** Decodes a code from the folder: another profile's, and for an answer, one to this profile's offer. */
async function verifyCode(code: string, deps: PairingDependencies, now: number) {
  const pairing = decodePairing(code, now);
  const me = await deps.identity();
  if (pairing.profileId === me.profileId) throw new Error("This code comes from this profile.");
  if (pairing.kind === "answer") {
    const pending = await deps.pending.get(pairing.profileId);
    if (pending?.pairingId !== pairing.pairingId || pending.expiresAt <= now) {
      throw new Error("This answer is not for the offer this profile made.");
    }
  }
  const fingerprint = fingerprintOf(pairing.sdp);
  if (!fingerprint) throw new Error("The code has no certificate fingerprint.");
  const identity = await signerOf(pairing.identity, { profileId: pairing.profileId, fingerprint });
  // Refused before the link sees its SDP, so a forged code never gets a connection.
  if ((await deps.pins.verify(pairing.profileId, identity)) === "pinned-mismatch")
    throw new Error(
      `Refused a code from ${pairing.profileId}: its pinned identity did not sign its certificate.`,
    );
  if (!identity)
    throw new Error(
      `Refused a code from ${pairing.profileId}: no valid signature names its certificate.`,
    );
  return { pairing, fingerprint, identity };
}

/**
 * The offer and answer codes profiles exchange through the RECnRun folder: A offers to B, B
 * accepts and answers, A accepts the answer. Each code carries its maker's signed statement for the
 * certificate its SDP names; accepting one records that certificate and the key that signed it.
 */
export function createPairing(deps: PairingDependencies) {
  const now = deps.now ?? Date.now;
  const half = async (kind: Pairing["kind"], pairingId: string, sdp: string) => {
    const me = await deps.identity();
    const fingerprint = fingerprintOf(sdp);
    if (!fingerprint) throw new Error("The link made an SDP with no certificate fingerprint.");
    const identity = await deps.sign({ profileId: me.profileId, fingerprint });
    const expiresAt = now() + PAIRING_TTL_MS;
    return encodePairing({ kind, pairingId, ...me, expiresAt, sdp, identity });
  };
  /** An offer for the profile `to`. */
  const createOffer = async (to: string) => {
    const pairingId = crypto.randomUUID();
    const sdp = sdpOf(await deps.askLink({ type: "offer", peer: to }));
    const code = await half("offer", pairingId, sdp);
    await deps.pending.set(to, { pairingId, expiresAt: now() + PAIRING_TTL_MS, to, code });
    return { code };
  };
  const accept = async (code: string): Promise<{ code?: string }> => {
    const { pairing, fingerprint, identity } = await verifyCode(code, deps, now());
    const { profileId, displayName } = pairing;
    // Each profile paired joins the others; none replaces another.
    await deps.authorized.set(profileId, { profileId, displayName, fingerprint, identity });
    if (pairing.kind === "offer") {
      const answer = sdpOf(
        await deps.askLink({ type: "answer", peer: profileId, sdp: pairing.sdp }),
      );
      return { code: await half("answer", pairing.pairingId, answer) };
    }
    await deps.askLink({ type: "accept-answer", peer: profileId, sdp: pairing.sdp });
    await deps.pending.set(profileId, null);
    return {};
  };
  return { createOffer, accept };
}

export type PairingFlow = ReturnType<typeof createPairing>;
