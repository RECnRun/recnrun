import { describe, expect, test } from "vite-plus/test";
import { loadIdentity } from "./worker-extension/identity.js";

/* Owner flow, task B: the worker's persistent identity from the launcher's identity.pk8. */

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const toBase64 = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("base64");

async function launcherKey() {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  const pk8 = new Uint8Array(await crypto.subtle.exportKey("pkcs8", pair.privateKey));
  return { pair, pk8, spki: toBase64(await crypto.subtle.exportKey("spki", pair.publicKey)) };
}

describe("the worker identity", () => {
  test("identity.pk8 becomes a non-extractable key whose public half is the launcher's", async () => {
    const { pair, pk8, spki } = await launcherKey();
    const identity = await loadIdentity({ readPk8: async () => pk8 });
    expect(identity.source).toBe("pk8");
    expect(identity.privateKey.extractable).toBe(false);
    expect(identity.spki).toBe(spki);
    const data = new TextEncoder().encode("answer");
    const signature = await crypto.subtle.sign(SIGN, identity.privateKey, data);
    expect(await crypto.subtle.verify(SIGN, pair.publicKey, signature, data)).toBe(true);
  });

  test("two loads of one file name the same worker", async () => {
    const { pk8 } = await launcherKey();
    const first = await loadIdentity({ readPk8: async () => pk8 });
    const second = await loadIdentity({ readPk8: async () => pk8 });
    expect(second.spki).toBe(first.spki);
  });

  test("with no identity.pk8 the lab worker keeps an ephemeral key", async () => {
    const identity = await loadIdentity({ readPk8: async () => null });
    expect(identity.source).toBe("ephemeral");
    expect(identity.privateKey.extractable).toBe(false);
    expect(Buffer.from(identity.spki, "base64")).toHaveLength(91);
  });

  test("a corrupt identity.pk8 is refused, never replaced by a fresh key", async () => {
    await expect(loadIdentity({ readPk8: async () => new Uint8Array([1, 2, 3]) })).rejects.toThrow(
      /BAD_IDENTITY/,
    );
  });
});
