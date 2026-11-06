import * as v from "valibot";
import { certificateFingerprint, storeCertificate } from "@/p2p/certificate-store";
import { discardIdentityKey } from "@/p2p/identity-key";

const DAY_MS = 24 * 60 * 60 * 1000;

/** What the harness may ask: a lifetime within Chrome's one-year cap, and the negative control. */
const RenewalRequestSchema = v.strictObject({
  expires: v.pipe(v.number(), v.safeInteger(), v.minValue(1), v.maxValue(365 * DAY_MS)),
  discardIdentity: v.optional(v.boolean(), false),
});

/**
 * P3.3 (POC PLAN.md): replaces this profile's stored DTLS certificate by a new one living
 * `expires` ms, as a renewal would, and answers its fingerprint. With `discardIdentity` it also
 * forgets the identity key, so the next statement is signed by a key no peer pinned. The offscreen
 * document keeps the certificate it loaded until it starts again, so the harness relaunches Chrome.
 */
export async function renewCertificate(request: unknown): Promise<{ fingerprint: string }> {
  const { expires, discardIdentity } = v.parse(RenewalRequestSchema, request);
  const certificate = await RTCPeerConnection.generateCertificate({
    name: "ECDSA",
    namedCurve: "P-256",
    expires,
  } as EcKeyGenParams);
  const fingerprint = certificateFingerprint(certificate);
  if (!fingerprint) throw new Error("The new certificate has no SHA-256 fingerprint.");
  await storeCertificate(certificate);
  if (discardIdentity) await discardIdentityKey();
  return { fingerprint };
}

/** `window.__poc.renewCertificate(request)`, merged into what is there. */
export function installRenewCertificate(target: object): void {
  const holder = target as { __poc?: Record<string, unknown> };
  holder.__poc = { ...holder.__poc, renewCertificate };
}
