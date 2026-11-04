import { describe, expect, test } from "vite-plus/test";
import { IdentityStatementSchema, signIdentity, signerOf } from "@/p2p/identity-key";
import * as v from "valibot";

const PROFILE = "22222222-2222-4222-8222-222222222222";
const OTHER_PROFILE = "33333333-3333-4333-8333-333333333333";
const FINGERPRINT = "AB:CD:EF";
const RENEWED = "12:34:56";
const SIGNED_AT = 1_700_000_000_000;

const keyPair = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);

const claim = { profileId: PROFILE, fingerprint: FINGERPRINT };

describe("signIdentity", () => {
  test("states the public key, the time, and a signature in base64url", async () => {
    const statement = await signIdentity(await keyPair(), claim, SIGNED_AT);
    expect(v.is(IdentityStatementSchema, statement)).toBe(true);
    expect(statement.signedAt).toBe(SIGNED_AT);
    expect(statement.key).toMatch(/^[\w-]{87}$/);
    expect(statement.signature).toMatch(/^[\w-]{86}$/);
  });

  test("names the same key for every certificate of one identity", async () => {
    const keys = await keyPair();
    const first = await signIdentity(keys, claim, SIGNED_AT);
    const renewed = await signIdentity(keys, { ...claim, fingerprint: RENEWED }, SIGNED_AT + 1);
    expect(renewed.key).toBe(first.key);
  });
});

describe("signerOf", () => {
  test("is the key that signed this profile's certificate", async () => {
    const statement = await signIdentity(await keyPair(), claim, SIGNED_AT);
    expect(await signerOf(statement, claim)).toBe(statement.key);
  });

  test("is undefined for another certificate, so a statement is never replayed for one", async () => {
    const statement = await signIdentity(await keyPair(), claim, SIGNED_AT);
    expect(await signerOf(statement, { ...claim, fingerprint: RENEWED })).toBeUndefined();
  });

  test("is undefined for another profile id", async () => {
    const statement = await signIdentity(await keyPair(), claim, SIGNED_AT);
    expect(await signerOf(statement, { ...claim, profileId: OTHER_PROFILE })).toBeUndefined();
  });

  test("is undefined when the time was changed after signing", async () => {
    const statement = await signIdentity(await keyPair(), claim, SIGNED_AT);
    expect(await signerOf({ ...statement, signedAt: SIGNED_AT + 1 }, claim)).toBeUndefined();
  });

  test("is undefined for a signature by another key under this key's name", async () => {
    const statement = await signIdentity(await keyPair(), claim, SIGNED_AT);
    const forged = await signIdentity(await keyPair(), claim, SIGNED_AT);
    const swapped = { ...statement, signature: forged.signature };
    expect(await signerOf(swapped, claim)).toBeUndefined();
  });

  test("is undefined for a key that is not a point of P-256", async () => {
    const statement = await signIdentity(await keyPair(), claim, SIGNED_AT);
    const notAPoint = `BA${"A".repeat(85)}`;
    expect(await signerOf({ ...statement, key: notAPoint }, claim)).toBeUndefined();
  });

  test.each([
    ["nothing", undefined],
    ["a string", "signed"],
    ["an extra key", { key: "A".repeat(87), signedAt: 0, signature: "A".repeat(86), extra: 1 }],
    ["a short key", { key: "A".repeat(86), signedAt: 0, signature: "A".repeat(86) }],
    ["a negative time", { key: "A".repeat(87), signedAt: -1, signature: "A".repeat(86) }],
  ])("is undefined for %s", async (_name, statement) => {
    expect(await signerOf(statement, claim)).toBeUndefined();
  });
});
