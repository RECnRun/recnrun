import { describe, expect, test } from "vite-plus/test";
import { allows } from "./worker-extension/allow.js";
import { createProvision, parsePolicy } from "./worker-extension/policy.js";

/* Owner flow, task B: the launcher's policy.json, its storage fallback, and the "*" allowlist. */

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const WORKSPACE = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";

async function masterSpki() {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  return Buffer.from(await crypto.subtle.exportKey("spki", pair.publicKey)).toString("base64");
}

const policyOf = (masterSpki: string, over: Record<string, unknown> = {}) => ({
  v: 1,
  workspace: WORKSPACE,
  root: "w1",
  generation: 1,
  masterSpki,
  allow: ["http://127.0.0.1:47812"],
  interactEnabled: true,
  viewport: { minWidth: 320, minHeight: 240, maxWidth: 1920, maxHeight: 1080 },
  ...over,
});
const bytesOf = (value: unknown) => new TextEncoder().encode(JSON.stringify(value));

describe("the allowlist", () => {
  test("an exact origin is allowed and any other is not", () => {
    expect(allows(["http://127.0.0.1:47812"], "http://127.0.0.1:47812")).toBe(true);
    expect(allows(["http://127.0.0.1:47812"], "http://127.0.0.1:47813")).toBe(false);
  });

  test('"*" allows any http(s) origin and no other scheme', () => {
    expect(allows(["*"], "https://example.com")).toBe(true);
    expect(allows(["*"], "http://127.0.0.1:4700")).toBe(true);
    for (const origin of ["file://", "null", "chrome-extension://abc", "ftp://a.test", "*", ""]) {
      expect(allows(["*"], origin), origin).toBe(false);
    }
  });
});

describe("the policy file", () => {
  test("a valid policy parses", async () => {
    const policy = policyOf(await masterSpki());
    expect(parsePolicy(bytesOf(policy))).toEqual(policy);
  });

  test.each([
    ["a wrong version", { v: 2 }],
    ["a bad root", { root: "w0" }],
    ["a bad workspace", { workspace: "x" }],
    ["a zero generation", { generation: 0 }],
    ["a short master key", { masterSpki: "AAAA" }],
    ["an empty allowlist", { allow: [] }],
    ["a path in the allowlist", { allow: ["http://a.test/x"] }],
    ["a star with origins", { allow: ["*", "http://a.test"] }],
    ["an exchange URL", { exchangeUrl: "file:///etc/" }],
    [
      "an inverted viewport",
      { viewport: { minWidth: 900, minHeight: 240, maxWidth: 800, maxHeight: 600 } },
    ],
    ["an extra key", { extra: true }],
  ])("%s is refused", async (_name, over) => {
    const spki = await masterSpki();
    expect(() => parsePolicy(bytesOf(policyOf(spki, over)))).toThrow(/BAD_POLICY/);
  });
});

describe("the provision a worker acts on", () => {
  test("policy.json wins and names its master key as a JWK", async () => {
    const policy = policyOf(await masterSpki(), { allow: ["*"] });
    const provision = createProvision({
      readPolicy: async () => bytesOf(policy),
      readStorage: async () => ({ masterKey: { kty: "stale" }, allowlist: ["http://old"] }),
    });
    const value = await provision.current();
    expect(value).toMatchObject({ allowlist: ["*"], interactEnabled: true, source: "policy" });
    expect(value?.masterKey).toMatchObject({ kty: "EC", crv: "P-256" });
    expect((await provision.filed())?.policy).toEqual(policy);
  });

  test("with no policy.json the lab's storage provision is used, read each time", async () => {
    let stored = { masterKey: { kty: "EC" }, allowlist: ["http://a.test"] };
    const provision = createProvision({
      readPolicy: async () => null,
      readStorage: async () => stored,
    });
    expect(await provision.current()).toEqual(stored);
    stored = { masterKey: { kty: "EC" }, allowlist: ["http://b.test"] };
    expect(await provision.current()).toEqual(stored);
    expect(await provision.filed()).toBeNull();
  });

  test("an invalid policy.json fails closed instead of falling back", async () => {
    const provision = createProvision({
      readPolicy: async () => new TextEncoder().encode("{"),
      readStorage: async () => ({ masterKey: { kty: "EC" }, allowlist: ["http://a.test"] }),
    });
    expect(await provision.current()).toBeUndefined();
  });
});
