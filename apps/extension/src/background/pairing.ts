import {
  decodePairing,
  encodePairing,
  fingerprintOf,
  PAIRING_TTL_MS,
  shortAuthenticationString,
} from "@/p2p/pairing-code";
import type { Pairing } from "@/p2p/pairing-code";
import type { AuthorizedPeer, ProfileIdentity, Repository } from "@/storage/peer-repository";

type LinkCommand =
  | { type: "link-fingerprint" }
  | { type: "link-offer" }
  | { type: "link-answer"; sdp: string }
  | { type: "link-accept-answer"; sdp: string };

export interface PairingDependencies {
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  authorized: Pick<Repository<AuthorizedPeer>, "read" | "write">;
  pending: Pick<Repository<{ pairingId: string; expiresAt: number }>, "read" | "write">;
  now?: () => number;
}

/** What the user compares before accepting: who sent the code, and the six digits. */
export interface PairingPreview {
  kind: Pairing["kind"];
  profileId: string;
  displayName: string;
  sas: string;
  /** The same profile and certificate as the authorized peer, as when reconnecting. */
  known: boolean;
}

const sdpOf = (result: unknown) => (result as { sdp: string }).sdp;

/** Decodes a pasted code and checks it is another profile's, and for an answer, ours. */
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
  const theirs = fingerprintOf(pairing.sdp);
  if (!theirs) throw new Error("The code has no certificate fingerprint.");
  return { pairing, theirs };
}

/**
 * Manual pairing: A creates an offer, B inspects and accepts it (its user confirms the digits
 * first), and A inspects and accepts B's answer (its user confirms the same digits).
 */
export function createPairing(deps: PairingDependencies) {
  const now = deps.now ?? Date.now;
  const half = async (kind: Pairing["kind"], pairingId: string, sdp: string) => {
    const me = await deps.identity();
    return encodePairing({ kind, pairingId, ...me, expiresAt: now() + PAIRING_TTL_MS, sdp });
  };
  const verify = (code: string) => verifyCode(code, deps, now());
  const inspect = async (code: string): Promise<PairingPreview> => {
    const { pairing, theirs } = await verify(code);
    const mine = (await deps.askLink({ type: "link-fingerprint" })) as { fingerprint: string };
    const peer = await deps.authorized.read();
    const { kind, profileId, displayName } = pairing;
    return {
      kind,
      profileId,
      displayName,
      sas: await shortAuthenticationString(mine.fingerprint, theirs),
      known: peer?.profileId === profileId && peer.fingerprint === theirs,
    };
  };
  const accept = async (code: string): Promise<{ code?: string }> => {
    const { pairing, theirs } = await verify(code);
    const { profileId, displayName } = pairing;
    // The user confirmed the digits, so this peer replaces any earlier one.
    await deps.authorized.write({ profileId, displayName, fingerprint: theirs });
    if (pairing.kind === "offer") {
      const answer = sdpOf(await deps.askLink({ type: "link-answer", sdp: pairing.sdp }));
      return { code: await half("answer", pairing.pairingId, answer) };
    }
    await deps.askLink({ type: "link-accept-answer", sdp: pairing.sdp });
    await deps.pending.write(null);
    return {};
  };
  const createOffer = async () => {
    const pairingId = crypto.randomUUID();
    const sdp = sdpOf(await deps.askLink({ type: "link-offer" }));
    await deps.pending.write({ pairingId, expiresAt: now() + PAIRING_TTL_MS });
    return { code: await half("offer", pairingId, sdp) };
  };
  return { createOffer, inspect, accept };
}
