import { readStored, writeStored } from "@/p2p/p2p-database";

const STORE = "certificates";
const KEY = "link";
/** Renewed a day before Chrome would refuse it; peers follow it by the identity key's statement. */
const MARGIN_MS = 24 * 60 * 60 * 1000;

/**
 * The DTLS certificate this profile always uses, so its fingerprint identifies the profile across
 * connections. An RTCCertificate is structured-cloneable; its private key never leaves Chrome.
 */
export async function persistentCertificate(now = Date.now()): Promise<RTCCertificate> {
  const stored = await readStored(STORE, KEY);
  if (stored instanceof RTCCertificate && stored.expires - MARGIN_MS > now) return stored;
  const keys: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
  const created = await RTCPeerConnection.generateCertificate(keys);
  await writeStored(STORE, KEY, created);
  return created;
}

/** Stores `certificate` as this profile's, for the next document that starts to load (P3.3 lab). */
export const storeCertificate = (certificate: RTCCertificate): Promise<void> =>
  writeStored(STORE, KEY, certificate);

/** The certificate's SHA-256 fingerprint, written as an SDP writes it. */
export function certificateFingerprint(certificate: RTCCertificate): string | undefined {
  const sha = certificate.getFingerprints().find(({ algorithm }) => algorithm === "sha-256");
  return sha?.value?.toUpperCase();
}

/** The fingerprint of this profile's stored certificate, if it has one; it never creates one. */
export async function storedFingerprint(): Promise<string | null> {
  const stored = await readStored(STORE, KEY);
  return (stored instanceof RTCCertificate && certificateFingerprint(stored)) || null;
}
