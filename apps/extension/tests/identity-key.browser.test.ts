import { beforeEach, describe, expect, test } from "vite-plus/test";
import { persistentCertificate } from "@/p2p/certificate-store";
import { discardIdentityKey, identityKey, signerOf, signedIdentity } from "@/p2p/identity-key";

const DB_NAME = "recnrun-p2p";
const claim = {
  profileId: "22222222-2222-4222-8222-222222222222",
  fingerprint: "AB:CD:EF",
};

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });
}

const publicKeyOf = async (keys: CryptoKeyPair) =>
  new Uint8Array(await crypto.subtle.exportKey("raw", keys.publicKey)).join(",");

beforeEach(async () => {
  await settled(indexedDB.deleteDatabase(DB_NAME));
});

describe("identityKey", () => {
  test("creates the profile's key pair once and keeps using it", async () => {
    const first = await identityKey();
    expect(await publicKeyOf(await identityKey())).toBe(await publicKeyOf(first));
  });

  test("keeps the private key from every script, and the public key readable", async () => {
    const { privateKey, publicKey } = await identityKey();
    expect(privateKey.extractable).toBe(false);
    await expect(crypto.subtle.exportKey("pkcs8", privateKey)).rejects.toMatchObject({
      name: "InvalidAccessError",
    });
    expect(publicKey.extractable).toBe(true);
  });

  test("gives one key to callers that create it at once, as two contexts of a profile may", async () => {
    const keys = await Promise.all([identityKey(), identityKey(), identityKey()]);
    const publicKeys = await Promise.all(keys.map(publicKeyOf));
    expect(new Set(publicKeys).size).toBe(1);
  });

  test("lives beside the certificate, which it leaves alone", async () => {
    const certificate = await persistentCertificate();
    await identityKey();
    expect((await persistentCertificate()).getFingerprints()).toEqual(
      certificate.getFingerprints(),
    );
  });

  test("replaces a stored value that is not a key pair", async () => {
    await identityKey();
    const opened = await settled(indexedDB.open(DB_NAME, 2));
    const store = opened.transaction("certificates", "readwrite").objectStore("certificates");
    await settled(store.put({ privateKey: "not a key" }, "identity"));
    opened.close();
    expect((await identityKey()).privateKey).toBeInstanceOf(CryptoKey);
  });

  test("rejects when the database cannot open", async () => {
    const request = indexedDB.open(DB_NAME, 3);
    request.onupgradeneeded = () => request.result.createObjectStore("certificates");
    (await settled(request)).close();
    await expect(identityKey()).rejects.toMatchObject({ name: "VersionError" });
  });
});

describe("discardIdentityKey", () => {
  test("forgets the identity, so the next key, as a clone's first boot makes, is another", async () => {
    const first = await identityKey();
    await discardIdentityKey();
    expect(await publicKeyOf(await identityKey())).not.toBe(await publicKeyOf(first));
  });
});

describe("signedIdentity", () => {
  test("signs with this profile's stored key", async () => {
    const statement = await signedIdentity(claim);
    expect(await signerOf(statement, claim)).toBe(statement.key);
    expect((await signedIdentity(claim)).key).toBe(statement.key);
  });
});
