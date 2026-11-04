import { beforeEach, describe, expect, test } from "vite-plus/test";
import { renewCertificate } from "@/diagnostics/renew-certificate";
import { certificateFingerprint, persistentCertificate } from "@/p2p/certificate-store";
import { identityKey } from "@/p2p/identity-key";

const DAY_MS = 24 * 60 * 60 * 1000;

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });
}

const publicKeyOf = async () =>
  new Uint8Array(await crypto.subtle.exportKey("raw", (await identityKey()).publicKey)).join(",");

const fingerprintOf = async () => certificateFingerprint(await persistentCertificate());

beforeEach(async () => {
  await settled(indexedDB.deleteDatabase("recnrun-p2p"));
});

describe("renewCertificate", () => {
  test("stores a new certificate of that lifetime, which the next start loads, under the same key", async () => {
    const before = await fingerprintOf();
    const key = await publicKeyOf();
    const asked = Date.now();
    const { fingerprint } = await renewCertificate({ expires: 7 * DAY_MS });
    expect(fingerprint).not.toBe(before);
    const loaded = await persistentCertificate();
    expect(certificateFingerprint(loaded)).toBe(fingerprint);
    expect(loaded.expires).toBeGreaterThanOrEqual(asked + 7 * DAY_MS - 60_000);
    expect(loaded.expires).toBeLessThanOrEqual(Date.now() + 7 * DAY_MS + 60_000);
    expect(await publicKeyOf()).toBe(key);
  });

  test("with discardIdentity, also forgets the identity key, so a new one signs next", async () => {
    const key = await publicKeyOf();
    const { fingerprint } = await renewCertificate({ expires: 7 * DAY_MS, discardIdentity: true });
    expect(await fingerprintOf()).toBe(fingerprint);
    expect(await publicKeyOf()).not.toBe(key);
  });

  test.each([
    ["no lifetime", {}],
    ["a lifetime of zero", { expires: 0 }],
    ["a lifetime over Chrome's one-year cap", { expires: 366 * DAY_MS }],
    ["a fractional lifetime", { expires: 1.5 }],
    ["another key", { expires: DAY_MS, keep: true }],
  ])("refuses %s and changes nothing", async (_name, request) => {
    const before = await fingerprintOf();
    await expect(renewCertificate(request)).rejects.toThrow();
    expect(await fingerprintOf()).toBe(before);
  });
});
