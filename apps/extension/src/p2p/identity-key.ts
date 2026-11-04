import * as v from "valibot";
import { addStored, deleteStored, readStored, writeStored } from "@/p2p/p2p-database";

/**
 * Whether this build has peers. Production has none, so a schema it bundles adds an identity only
 * under this test, inline: its bundle then folds the entry away and keeps its bytes.
 */
export const SIGNED = import.meta.env.MODE !== "production";

const STORE = "certificates";
const KEY = "identity";
const ALGORITHM: EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };
const SIGNATURE: EcdsaParams = { name: "ECDSA", hash: "SHA-256" };
/** Sets these bytes apart from anything else the key could ever be asked to sign. */
const CONTEXT = "RECnRun identity statement 1";

/** A public identity key: the raw P-256 point (65 bytes) in unpadded base64url. */
export const IdentityKeySchema = v.pipe(v.string(), v.regex(/^[\w-]{87}$/));

/**
 * A profile's statement that a DTLS certificate is its own: the identity key, the time, and the
 * key's ECDSA signature (64 bytes, r then s, in base64url) over the context line, the profile id,
 * the certificate's SHA-256 fingerprint, and that time. The verifier supplies the profile id and
 * fingerprint it observed, so a statement never vouches for another profile or certificate.
 */
export const IdentityStatementSchema = v.strictObject({
  key: IdentityKeySchema,
  signedAt: v.pipe(v.number(), v.safeInteger(), v.minValue(0)),
  signature: v.pipe(v.string(), v.regex(/^[\w-]{86}$/)),
});

export type IdentityStatement = v.InferOutput<typeof IdentityStatementSchema>;

/** The profile and the certificate fingerprint a statement is about. */
export interface IdentityClaim {
  profileId: string;
  fingerprint: string;
}

const toBase64Url = (bytes: ArrayBuffer) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");

const fromBase64Url = (text: string) =>
  Uint8Array.from(atob(text.replaceAll("-", "+").replaceAll("_", "/")), (char) =>
    char.charCodeAt(0),
  );

const signedBytes = ({ profileId, fingerprint }: IdentityClaim, signedAt: number) =>
  new TextEncoder().encode([CONTEXT, profileId, fingerprint, String(signedAt)].join("\n"));

/** Signs, with `keys`, that `claim.fingerprint` is the certificate of `claim.profileId`. */
export async function signIdentity(
  keys: CryptoKeyPair,
  claim: IdentityClaim,
  signedAt = Date.now(),
): Promise<IdentityStatement> {
  const [raw, signature] = await Promise.all([
    crypto.subtle.exportKey("raw", keys.publicKey),
    crypto.subtle.sign(SIGNATURE, keys.privateKey, signedBytes(claim, signedAt)),
  ]);
  return { key: toBase64Url(raw), signedAt, signature: toBase64Url(signature) };
}

/**
 * The key whose valid signature names `claim`, else undefined. It proves who signed, not who holds
 * the certificate: only a DTLS handshake proves that, and only a pin makes the key trusted.
 */
export async function signerOf(
  statement: unknown,
  claim: IdentityClaim,
): Promise<string | undefined> {
  const parsed = v.safeParse(IdentityStatementSchema, statement);
  if (!parsed.success) return undefined;
  const { key, signedAt, signature } = parsed.output;
  try {
    const publicKey = await crypto.subtle.importKey("raw", fromBase64Url(key), ALGORITHM, false, [
      "verify",
    ]);
    const bytes = signedBytes(claim, signedAt);
    return (await crypto.subtle.verify(SIGNATURE, publicKey, fromBase64Url(signature), bytes))
      ? key
      : undefined;
  } catch {
    // Bytes that are no point of P-256 are no key, and sign nothing.
    return undefined;
  }
}

const isKeyPair = (value: unknown): value is CryptoKeyPair =>
  typeof value === "object" &&
  value !== null &&
  "privateKey" in value &&
  "publicKey" in value &&
  value.privateKey instanceof CryptoKey &&
  value.publicKey instanceof CryptoKey;

/**
 * This profile's identity: an ECDSA P-256 key pair made once and kept in IndexedDB beside the DTLS
 * certificate. Its private key is not extractable, so no script can export it; IndexedDB still
 * writes its bytes into the profile's folder, which any program of the same OS user can read.
 */
export async function identityKey(): Promise<CryptoKeyPair> {
  const stored = await readStored(STORE, KEY);
  if (isKeyPair(stored)) return stored;
  const created = await crypto.subtle.generateKey(ALGORITHM, false, ["sign", "verify"]);
  if (stored !== undefined) {
    await writeStored(STORE, KEY, created);
    return created;
  }
  // The background and the offscreen document may both create one; the first stored is the identity.
  if (await addStored(STORE, KEY, created)) return created;
  const first = await readStored(STORE, KEY);
  if (!isKeyPair(first)) throw new Error("The identity key could not be stored.");
  return first;
}

/**
 * Forgets this profile's identity, so the next statement is signed by a new key its peers refuse.
 * A cloned profile must call it on its first boot (P5.3), so no two profiles share one identity.
 */
export const discardIdentityKey = (): Promise<void> => deleteStored(STORE, KEY);

/** This profile's statement, signed with its stored key, that `claim.fingerprint` is its certificate. */
export const signedIdentity = async (claim: IdentityClaim): Promise<IdentityStatement> =>
  signIdentity(await identityKey(), claim);
