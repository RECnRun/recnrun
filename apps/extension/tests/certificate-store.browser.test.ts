import { beforeEach, describe, expect, test } from "vite-plus/test";
import { certificateFingerprint, persistentCertificate } from "@/p2p/certificate-store";

const DB_NAME = "recnrun-p2p";
const DAY_MS = 24 * 60 * 60 * 1000;

function settled<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("IndexedDB failed."));
  });
}

/** The database at `version`, holding `value` as the certificate when given. */
async function seed(version: number, value?: unknown) {
  const request = indexedDB.open(DB_NAME, version);
  request.onupgradeneeded = () => request.result.createObjectStore("certificates");
  const db = await settled(request);
  if (value !== undefined) {
    await settled(
      db.transaction("certificates", "readwrite").objectStore("certificates").put(value, "link"),
    );
  }
  db.close();
}

const fingerprint = (certificate: RTCCertificate) => certificateFingerprint(certificate) ?? "";

beforeEach(async () => {
  await settled(indexedDB.deleteDatabase(DB_NAME));
});

describe("persistentCertificate", () => {
  test("creates the profile's certificate once and keeps using it", async () => {
    const first = await persistentCertificate();
    expect(first).toBeInstanceOf(RTCCertificate);
    expect(first.expires).toBeGreaterThan(Date.now() + DAY_MS);
    const again = await persistentCertificate();
    expect(fingerprint(again)).toBe(fingerprint(first));
  });

  test("renews a certificate a day before it expires, and keeps the new one", async () => {
    const first = await persistentCertificate();
    const kept = await persistentCertificate(first.expires - DAY_MS - 1);
    expect(fingerprint(kept)).toBe(fingerprint(first));
    const renewed = await persistentCertificate(first.expires - DAY_MS);
    expect(fingerprint(renewed)).not.toBe(fingerprint(first));
    expect(fingerprint(await persistentCertificate())).toBe(fingerprint(renewed));
  });

  test("replaces a stored value that is not a certificate", async () => {
    await seed(1, { expires: Number.MAX_SAFE_INTEGER });
    expect(await persistentCertificate()).toBeInstanceOf(RTCCertificate);
  });

  test("rejects when the database cannot open", async () => {
    await seed(2);
    await expect(persistentCertificate()).rejects.toMatchObject({ name: "VersionError" });
  });
});

describe("certificateFingerprint", () => {
  test("is the SHA-256 fingerprint in upper case, as an SDP writes it", async () => {
    const certificate = await persistentCertificate();
    const pc = new RTCPeerConnection({ certificates: [certificate] });
    pc.createDataChannel("probe");
    await pc.setLocalDescription();
    const announced = /^a=fingerprint:sha-256 (\S+)/m.exec(pc.localDescription?.sdp ?? "")?.[1];
    pc.close();
    expect(certificateFingerprint(certificate)).toBe(announced);
    expect(announced).toMatch(/^[0-9A-F]{2}(:[0-9A-F]{2}){31}$/);
  });

  test("is undefined for a certificate without a SHA-256 fingerprint", () => {
    const sha1Only = {
      getFingerprints: () => [{ algorithm: "sha-1", value: "ab:cd" }],
    } as unknown as RTCCertificate;
    expect(certificateFingerprint(sha1Only)).toBeUndefined();
  });
});
