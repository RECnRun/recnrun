// The worker's signing identity: the launcher's identity.pk8 when present, else an ephemeral lab key.
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const toBase64 = (buffer) => btoa(String.fromCharCode(...new Uint8Array(buffer)));

const spkiOf = async (publicKey) => toBase64(await crypto.subtle.exportKey("spki", publicKey));

const ephemeral = async () => {
  const pair = await crypto.subtle.generateKey(ECDSA, false, ["sign", "verify"]);
  const spki = await spkiOf(pair.publicKey);
  return { privateKey: pair.privateKey, publicKey: pair.publicKey, spki, source: "ephemeral" };
};

// The public half comes from a transient extractable import; only the non-extractable key is kept.
const fromPk8 = async (pk8) => {
  try {
    const open = await crypto.subtle.importKey("pkcs8", pk8, ECDSA, true, ["sign"]);
    const { kty, crv, x, y } = await crypto.subtle.exportKey("jwk", open);
    const publicKey = await crypto.subtle.importKey("jwk", { kty, crv, x, y }, ECDSA, true, [
      "verify",
    ]);
    const privateKey = await crypto.subtle.importKey("pkcs8", pk8, ECDSA, false, ["sign"]);
    return { privateKey, publicKey, spki: await spkiOf(publicKey), source: "pk8" };
  } catch (error) {
    throw new Error(`BAD_IDENTITY: ${String(error)}`, { cause: error });
  }
};

export const loadIdentity = async ({ readPk8 }) => {
  const pk8 = await readPk8();
  return pk8 ? fromPk8(pk8) : ephemeral();
};
