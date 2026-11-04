import { signIdentity } from "@/p2p/identity-key";
import type { IdentityClaim, IdentityStatement } from "@/p2p/identity-key";

const ALGORITHM: EcKeyGenParams = { name: "ECDSA", namedCurve: "P-256" };
const pairs = new Map<string, Promise<CryptoKeyPair>>();

/** The test identity key named `name`: one per name for the whole run, as a profile keeps one. */
function keysOf(name: string): Promise<CryptoKeyPair> {
  let pair = pairs.get(name);
  if (!pair) {
    pair = crypto.subtle.generateKey(ALGORITHM, false, ["sign", "verify"]);
    pairs.set(name, pair);
  }
  return pair;
}

/** Signs `claim` with the test key of its profile, or of `as` to forge another's statement. */
export async function signAs(
  claim: IdentityClaim,
  as = claim.profileId,
): Promise<IdentityStatement> {
  return signIdentity(await keysOf(as), claim);
}

/** The public identity key named `name`, as a pin or an authorized peer holds it. */
export async function identityOf(name: string): Promise<string> {
  return (await signAs({ profileId: name, fingerprint: "AB" }, name)).key;
}
