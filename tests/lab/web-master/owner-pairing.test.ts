import { createPublicKey, verify as nodeVerify } from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { canonical } from "./site/jobs.js";
import {
  buildRequest,
  fingerprint,
  fromBase64Url,
  sha256Hex,
  signOffer,
  spkiOk,
  toBase64,
  toBase64Url,
  verifyAnswer,
} from "./site/owner-pairing.js";

const ecdsa = { name: "ECDSA", hash: "SHA-256" };
const generate = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
const spkiOf = async (pair: CryptoKeyPair) =>
  new Uint8Array(await crypto.subtle.exportKey("spki", pair.publicKey));
const encode = (value: string) => new TextEncoder().encode(value);
const UUID = "0b9f7a52-3c1e-4d0a-9a55-6f2f1c7b8e10";

describe("spki and fingerprints", () => {
  test("an exported P-256 key is 91 bytes with the fixed prefix", async () => {
    expect(spkiOk(await spkiOf(await generate()))).toBe(true);
  });

  test("wrong length or prefix is refused", async () => {
    const spki = await spkiOf(await generate());
    expect(spkiOk(spki.slice(0, 90))).toBe(false);
    const bad = spki.slice();
    bad[5] = (bad[5] ?? 0) ^ 0xff;
    expect(spkiOk(bad)).toBe(false);
  });

  test("the fingerprint is lowercase hex sha-256 of the 91 bytes", async () => {
    const spki = await spkiOf(await generate());
    const hash = await crypto.subtle.digest("SHA-256", spki);
    const expected = [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect(await fingerprint(spki)).toBe(expected);
    expect(await sha256Hex(spki)).toBe(expected);
  });

  test("base64url round-trips without padding", () => {
    const bytes = Uint8Array.of(251, 255, 254, 1);
    const text = toBase64Url(bytes);
    expect(text).not.toMatch(/[+/=]/);
    expect([...fromBase64Url(text)]).toEqual([...bytes]);
  });
});

describe("buildRequest", () => {
  const fields = {
    workspace: UUID,
    session: "0123456789abcdef",
    request: "1b9f7a52-3c1e-4d0a-9a55-6f2f1c7b8e11",
    root: "w1",
    offer: "a".repeat(64),
    attempt: "2b9f7a52-3c1e-4d0a-9a55-6f2f1c7b8e12",
    expires: 1_800_000_100,
  };

  test("lines come in the contract's order and the DER signature verifies", async () => {
    const pair = await generate();
    const text = await buildRequest(fields, pair.privateKey);
    const lines = text.split("\n");
    expect(lines.pop()).toBe("");
    const sig = lines.pop() ?? "";
    expect(lines.map((line) => line.split("=")[0])).toEqual([
      "recnrun-lab-request v1",
      "workspace",
      "session",
      "request",
      "action",
      "root",
      "offer",
      "attempt",
      "expires",
    ]);
    expect(lines).toContain("action=start");
    expect(text.length).toBeLessThanOrEqual(1024);
    expect(sig.startsWith("sig=")).toBe(true);
    const body = Buffer.from(`${lines.join("\n")}\n`);
    const key = createPublicKey({
      key: Buffer.from(await spkiOf(pair)),
      format: "der",
      type: "spki",
    });
    const der = Buffer.from(sig.slice(4), "base64");
    expect(nodeVerify("sha256", body, { key, dsaEncoding: "der" }, der)).toBe(true);
    expect(
      nodeVerify(
        "sha256",
        Buffer.concat([Buffer.from("x"), body]),
        { key, dsaEncoding: "der" },
        der,
      ),
    ).toBe(false);
  });

  test("a field that breaks the grammar is refused before signing", async () => {
    const pair = await generate();
    await expect(buildRequest({ ...fields, root: "../w1" }, pair.privateKey)).rejects.toThrow();
    await expect(buildRequest({ ...fields, offer: "zz" }, pair.privateKey)).rejects.toThrow();
  });
});

describe("signOffer and verifyAnswer", () => {
  test("an offer is signed in P1363 base64url over canonical() of the other fields", async () => {
    const pair = await generate();
    const offer = { v: 1, type: "offer", root: "w1", attempt: UUID, sdp: "v=0" };
    const signed = await signOffer(offer, pair.privateKey);
    const { signature, ...rest } = signed;
    expect(Object.keys(rest).sort()).toEqual(Object.keys(offer).sort());
    expect(
      await crypto.subtle.verify(
        ecdsa,
        pair.publicKey,
        fromBase64Url(signature),
        encode(canonical(rest)),
      ),
    ).toBe(true);
  });

  const answerOf = async (pair: CryptoKeyPair, changes: Record<string, unknown> = {}) => {
    const spki = await spkiOf(pair);
    const fields = {
      v: 1,
      type: "answer",
      root: "w1",
      attempt: UUID,
      nonce: "n-1",
      bootId: "boot",
      sdp: "v=0 answer",
      workerSpki: toBase64(spki),
      ...changes,
    };
    const sig = await crypto.subtle.sign(ecdsa, pair.privateKey, encode(canonical(fields)));
    return { answer: { ...fields, signature: toBase64Url(new Uint8Array(sig)) }, spki };
  };
  const expected = { attempt: UUID, nonce: "n-1", root: "w1" };

  test("a signed answer from the pinned worker key is accepted", async () => {
    const { answer, spki } = await answerOf(await generate());
    expect(await verifyAnswer(answer, spki, expected)).toEqual({ ok: true });
  });

  test("a tampered body, a signature of another key and a different pin are refused", async () => {
    const pair = await generate();
    const { answer, spki } = await answerOf(pair);
    expect((await verifyAnswer({ ...answer, sdp: "v=0 evil" }, spki, expected)).reason).toBe(
      "bad-signature",
    );
    const other = await answerOf(await generate());
    expect((await verifyAnswer(other.answer, spki, expected)).reason).toBe("worker-key-mismatch");
    const swapped = { ...answer, workerSpki: other.answer.workerSpki };
    expect((await verifyAnswer(swapped, spki, expected)).reason).toBe("worker-key-mismatch");
  });

  test("a different attempt, nonce or root is refused", async () => {
    const { answer, spki } = await answerOf(await generate());
    expect((await verifyAnswer(answer, spki, { ...expected, attempt: "x" })).reason).toBe(
      "wrong-attempt",
    );
    expect((await verifyAnswer(answer, spki, { ...expected, nonce: "x" })).reason).toBe(
      "wrong-nonce",
    );
    expect((await verifyAnswer(answer, spki, { ...expected, root: "w2" })).reason).toBe(
      "wrong-root",
    );
  });

  test("a malformed answer is refused", async () => {
    const { spki } = await answerOf(await generate());
    expect((await verifyAnswer({ type: "answer" }, spki, expected)).ok).toBe(false);
  });
});
