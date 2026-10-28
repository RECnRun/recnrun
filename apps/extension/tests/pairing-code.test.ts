import { describe, expect, test } from "vite-plus/test";
import { PAIRING_TTL_MS, decodePairing, encodePairing, fingerprintOf } from "@/p2p/pairing-code";

const NOW = 1_700_000_000_000;
const FINGERPRINT = "AB:CD:EF:01";
const DAMAGED = "The pairing code is damaged; copy it again.";

const pairing = {
  kind: "offer" as const,
  pairingId: "33333333-3333-4333-8333-333333333333",
  profileId: "11111111-1111-4111-8111-111111111111",
  displayName: "Work laptop é ✓",
  expiresAt: NOW + PAIRING_TTL_MS,
  sdp: `v=0\r\na=fingerprint:sha-256 ${FINGERPRINT}\r\n`,
};

const codeOf = (json: string) => `RECNRUN-PAIR-1.${Buffer.from(json).toString("base64url")}`;

describe("pairing codes", () => {
  test("round-trip as one line of URL-safe text, surrounding whitespace ignored", () => {
    const code = encodePairing(pairing);
    expect(code).toMatch(/^RECNRUN-PAIR-1\.[\w-]+$/);
    expect(decodePairing(`  ${code}\n`, NOW)).toEqual(pairing);
    const fresh = { ...pairing, expiresAt: Date.now() + PAIRING_TTL_MS };
    expect(decodePairing(encodePairing(fresh))).toEqual(fresh);
  });

  test("refuses text that is not a pairing code", () => {
    expect(() => decodePairing("hello", NOW)).toThrow("This is not a RECnRun pairing code.");
  });

  test.each([
    ["characters outside base64", "RECNRUN-PAIR-1.!!!"],
    ["text that is not JSON", codeOf("{not json")],
    ["JSON that is not a pairing", codeOf(JSON.stringify({ ...pairing, kind: "other" }))],
    ["an extra field", codeOf(JSON.stringify({ ...pairing, extra: 1 }))],
    ["an empty name", codeOf(JSON.stringify({ ...pairing, displayName: " " }))],
  ])("reports a code with %s as damaged", (_, code) => {
    expect(() => decodePairing(code, NOW)).toThrow(DAMAGED);
  });

  test("refuses a code once it expires", () => {
    const code = encodePairing(pairing);
    expect(decodePairing(code, pairing.expiresAt - 1)).toEqual(pairing);
    expect(() => decodePairing(code, pairing.expiresAt)).toThrow(
      "The pairing code expired; create a new one.",
    );
  });
});

describe("fingerprintOf", () => {
  test("reads the SHA-256 fingerprint line, in upper case", () => {
    expect(fingerprintOf(pairing.sdp)).toBe(FINGERPRINT);
    expect(fingerprintOf("v=0\na=fingerprint:sha-256 ab:cd  \n")).toBe("AB:CD");
  });

  test("finds nothing without a SHA-256 fingerprint", () => {
    expect(fingerprintOf("v=0\r\na=fingerprint:sha-1 AB:CD\r\n")).toBeUndefined();
    expect(fingerprintOf("v=0\r\n")).toBeUndefined();
  });
});
