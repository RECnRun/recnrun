/*
 * The extension's identity statement (apps/extension/src/p2p/identity-key.ts) restated for the
 * lab's virtual peers: a P-256 key of their own signs, in the extension's bytes, that a certificate
 * fingerprint is a profile's. A real profile verifies it as it verifies any peer's.
 */

const CONTEXT = "RECnRun identity statement 1";
const ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGNATURE: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };

export interface IdentityStatement {
  /** The raw P-256 public point, unpadded base64url. */
  key: string;
  signedAt: number;
  /** ECDSA over the context line, the profile id, the fingerprint, and signedAt; r then s. */
  signature: string;
}

export type Signer = (profileId: string, fingerprint: string) => Promise<IdentityStatement>;

const base64url = (bytes: ArrayBuffer) => Buffer.from(bytes).toString("base64url");

/** The bytes a statement signs, as the extension builds them. */
export const signedBytes = (profileId: string, fingerprint: string, signedAt: number) =>
  new TextEncoder().encode([CONTEXT, profileId, fingerprint, String(signedAt)].join("\n"));

/** A fresh identity key, and a signer that uses only it. */
export async function identitySigner(): Promise<Signer> {
  const keys = await crypto.subtle.generateKey(ALGORITHM, false, ["sign", "verify"]);
  const key = base64url(await crypto.subtle.exportKey("raw", keys.publicKey));
  return async (profileId, fingerprint) => {
    const signedAt = Date.now();
    const bytes = signedBytes(profileId, fingerprint, signedAt);
    const signature = base64url(await crypto.subtle.sign(SIGNATURE, keys.privateKey, bytes));
    return { key, signedAt, signature };
  };
}
