import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import { PAIRING_TTL_MS, encodePairing } from "@/p2p/pairing-code";
import type { PendingOffer } from "@/storage/peer-repository";
import { ME, PEER, STRANGER } from "./fake-peer";
import { signAs } from "./test-identity";

export const NOW = 1_700_000_000_000;
export const OFFER_ID = "44444444-4444-4444-8444-444444444444";
export const OTHER_ID = "55555555-5555-4555-8555-555555555555";
const FINGERPRINTS: Record<string, string> = {
  [ME]: "11:11",
  [PEER]: "22:22",
  [STRANGER]: "33:33",
};
/** Each profile's statement for its certificate, as its presence and its codes carry it. */
const STATEMENTS = Object.fromEntries(
  await Promise.all(
    Object.entries(FINGERPRINTS).map(async ([profileId, fingerprint]) => [
      profileId,
      await signAs({ profileId, fingerprint }),
    ]),
  ),
);
const statementOf = (profileId: string) => {
  const statement = STATEMENTS[profileId];
  if (!statement) throw new Error(`No test statement for ${profileId}.`);
  return statement;
};

export const presence = (profileId: string, createdAt = NOW - 1000): Presence => ({
  profileId,
  displayName: `Profile ${profileId.slice(0, 1)}`,
  fingerprint: FINGERPRINTS[profileId] ?? "",
  identity: statementOf(profileId),
  createdAt,
  expiresAt: NOW + 60_000,
});

export interface SignalOptions {
  pairingId?: string;
  fingerprint?: string;
  codeFrom?: string;
  expiresAt?: number;
}

/** A signal `from` made for `to`, whose code announces `from`'s certificate unless told otherwise. */
export function signal(
  kind: SignalFile["kind"],
  from: string,
  to: string,
  options: SignalOptions = {},
) {
  const { pairingId = OFFER_ID, codeFrom = from, expiresAt = NOW + PAIRING_TTL_MS } = options;
  const fingerprint = options.fingerprint ?? FINGERPRINTS[from] ?? "";
  const code = encodePairing({
    kind,
    pairingId,
    profileId: codeFrom,
    displayName: "Profile",
    expiresAt,
    sdp: `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`,
    // The folder's decision reads no signature; the pairing flow checks it.
    identity: statementOf(codeFrom),
  });
  return { kind, pairingId, profileId: from, to, expiresAt, code } satisfies SignalFile;
}

export const seen = (presences: Presence[], signals: SignalFile[] = []): Seen => ({
  presences,
  signals,
});
// Made a second ago unless told otherwise.
export const pendingFor = (to: string, expiresAt = NOW - 1000 + PAIRING_TTL_MS): PendingOffer => ({
  pairingId: OFFER_ID,
  expiresAt,
  to,
  code: "offer-code",
});
