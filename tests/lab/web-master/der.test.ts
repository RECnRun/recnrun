import {
  createPrivateKey,
  createPublicKey,
  sign as nodeSign,
  verify as nodeVerify,
} from "node:crypto";
import { describe, expect, test } from "vite-plus/test";
import { derToP1363, p1363ToDer } from "./site/der.js";

/* The master signs with WebCrypto (P1363); the launcher's openssl speaks DER. */

const ecdsa = { name: "ECDSA", hash: "SHA-256" };
const data = new TextEncoder().encode("recnrun-lab-request v1\n");
const generate = () =>
  crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);

describe("p1363ToDer", () => {
  test("a WebCrypto signature in DER verifies under Node's DER ECDSA check", async () => {
    for (let round = 0; round < 25; round += 1) {
      const pair = await generate();
      const p1363 = new Uint8Array(await crypto.subtle.sign(ecdsa, pair.privateKey, data));
      const spki = Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey));
      const key = createPublicKey({ key: spki, format: "der", type: "spki" });
      const der = Buffer.from(p1363ToDer(p1363));
      expect(nodeVerify("sha256", data, { key, dsaEncoding: "der" }, der)).toBe(true);
    }
  });

  test("encodes a high-bit r with a zero byte and strips leading zeros of s", () => {
    const p1363 = new Uint8Array(64);
    p1363[0] = 0x80;
    p1363[34] = 0x7f;
    p1363[63] = 0x01;
    const der = [...p1363ToDer(p1363)];
    expect(der.slice(2, 5)).toEqual([0x02, 0x21, 0x00]);
    const sAt = 2 + 2 + 33;
    expect(der.slice(sAt, sAt + 2)).toEqual([0x02, 30]);
  });
});

describe("derToP1363", () => {
  test("a DER signature verifies as P1363 under WebCrypto", async () => {
    for (let round = 0; round < 25; round += 1) {
      const pair = await generate();
      const pkcs8 = Buffer.from(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
      const priv = createPrivateKey({ key: pkcs8, format: "der", type: "pkcs8" });
      const der = nodeSign("sha256", data, { key: priv, dsaEncoding: "der" });
      const p1363 = derToP1363(new Uint8Array(der));
      expect(p1363.length).toBe(64);
      expect(await crypto.subtle.verify(ecdsa, pair.publicKey, p1363, data)).toBe(true);
    }
  });

  test("round-trips an edge signature", () => {
    const p1363 = new Uint8Array(64).fill(0xff);
    p1363[31] = 0x00;
    expect([...derToP1363(p1363ToDer(p1363))]).toEqual([...p1363]);
  });

  test("refuses malformed DER", () => {
    expect(() => derToP1363(new Uint8Array([0x30, 0x02, 0x02, 0x00]))).toThrow();
    expect(() => derToP1363(new Uint8Array([0x31, 0x00]))).toThrow();
    expect(() => derToP1363(new Uint8Array())).toThrow();
  });
});
