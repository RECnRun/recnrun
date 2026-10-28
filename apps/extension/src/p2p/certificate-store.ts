import { readStored, writeStored } from "@/p2p/p2p-database";

const STORE = "certificates";
const KEY = "link";
/** Renewed a day before Chrome would refuse it; a new certificate needs a new pairing. */
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

/** The certificate's SHA-256 fingerprint, written as an SDP writes it. */
export function certificateFingerprint(certificate: RTCCertificate): string | undefined {
  const sha = certificate.getFingerprints().find(({ algorithm }) => algorithm === "sha-256");
  return sha?.value?.toUpperCase();
}
