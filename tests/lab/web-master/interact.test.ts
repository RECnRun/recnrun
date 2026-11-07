import { beforeEach, describe, expect, test } from "vite-plus/test";
import { createStartCheck } from "./worker-extension/input-check.js";
import type { LinkView, StartContext } from "./worker-extension/input-check.js";
import { inputError } from "./worker-extension/input-schema.js";
import { createLeases } from "./worker-extension/interact-lease.js";

/* W7 slice A: the closed input.v1 messages, the link-bound signed start, and the lease. */

const WORKER = "abcdefghijklmnopabcdefghijklmnop";
const BOOT = "11111111-2222-4333-8444-555555555555";
const LEASE = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
const ORIGIN = "http://127.0.0.1:4700";
const ECDSA = { name: "ECDSA", namedCurve: "P-256" };

const fingerprint = (byte: string) => Array.from({ length: 32 }, () => byte).join(":");
const LINK_A: LinkView = {
  linkId: "link-a",
  masterFingerprint: fingerprint("AA"),
  workerFingerprint: fingerprint("A1"),
};
const LINK_B: LinkView = {
  linkId: "link-b",
  masterFingerprint: fingerprint("BB"),
  workerFingerprint: fingerprint("B1"),
};

const canonical = (value: unknown): string => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([a], [b]) => (a < b ? -1 : 1));
    return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonical(entry)}`).join(",")}}`;
  }
  return JSON.stringify(value);
};

const keyPair = () => crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);

async function signWith(key: CryptoKey, fields: Record<string, unknown>) {
  const data = new TextEncoder().encode(canonical(fields));
  const raw = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, data);
  return { ...fields, signature: Buffer.from(raw).toString("base64") };
}

const startFields = (nonce: string, link: LinkView, overrides: Record<string, unknown> = {}) => ({
  type: "INTERACT_START",
  requestId: crypto.randomUUID(),
  workerId: WORKER,
  bootId: BOOT,
  nonce,
  masterFingerprint: link.masterFingerprint,
  workerFingerprint: link.workerFingerprint,
  url: `${ORIGIN}/form`,
  iat: Date.now(),
  exp: Date.now() + 10_000,
  ...overrides,
});

describe("the closed input.v1 schema", () => {
  const nonce = "n".repeat(32);
  const valid: Record<string, Record<string, unknown>> = {
    challenge: { type: "INTERACT_CHALLENGE", requestId: crypto.randomUUID() },
    start: { ...startFields(nonce, LINK_A), signature: "c2ln" },
    renew: { type: "INTERACT_RENEW", leaseId: LEASE, seq: 1 },
    stop: { type: "INTERACT_STOP", leaseId: LEASE, seq: 2 },
    event: { type: "INPUT_EVENT", leaseId: LEASE, seq: 3, kind: "pointerDown" },
  };

  test.each(Object.keys(valid))("a well-formed %s passes", (name) => {
    expect(inputError(valid[name])).toBeNull();
  });

  test.each([
    ["an unknown type", { ...valid.renew, type: "INTERACT_EVAL" }],
    ["an unknown field", { ...valid.renew, selector: "#go" }],
    ["a missing field", { type: "INTERACT_RENEW", leaseId: LEASE }],
    ["an unknown event kind", { ...valid.event, kind: "dispatchKeyEvent" }],
    ["a seq of zero", { ...valid.renew, seq: 0 }],
    ["a fractional seq", { ...valid.renew, seq: 1.5 }],
    ["a lease id that is not a UUID", { ...valid.renew, leaseId: "../lease" }],
    ["a start ttl over 30 s", { ...valid.start, exp: Date.now() + 60_000 }],
    ["a start url that is not http(s)", { ...valid.start, url: "javascript:alert(1)" }],
    ["a malformed fingerprint", { ...valid.start, masterFingerprint: "AA:BB" }],
    ["an unsigned start", { ...startFields(nonce, LINK_A) }],
    ["an array", [valid.renew]],
    ["null", null],
  ])("%s is refused", (_name, message) => {
    expect(inputError(message)).toBe("INVALID_REQUEST");
  });
});

describe("the link-bound signed start", () => {
  let master: CryptoKeyPair;
  let context: StartContext;
  let starts: ReturnType<typeof createStartCheck>;

  beforeEach(async () => {
    master = await keyPair();
    const masterKey = await crypto.subtle.exportKey("jwk", master.publicKey);
    context = { masterKey, allowlist: [ORIGIN], workerId: WORKER, bootId: BOOT, link: LINK_A };
    starts = createStartCheck();
  });

  const issued = () => String(starts.issue(LINK_A.linkId));
  const signed = (nonce: string, link = LINK_A, overrides: Record<string, unknown> = {}) =>
    signWith(master.privateKey, startFields(nonce, link, overrides));

  test("a start signed by the pinned key over this link's challenge is accepted once", async () => {
    const start = await signed(issued());
    expect(await starts.check(start, context)).toBeNull();
    expect(await starts.check(start, context)).toBe("REPLAY");
  });

  test("a nonce the worker never issued is refused", async () => {
    expect(await starts.check(await signed("x".repeat(32)), context)).toBe("NONCE_UNKNOWN");
  });

  test("a start signed by another key is refused and spends no nonce", async () => {
    const nonce = issued();
    const other = await keyPair();
    const forged = await signWith(other.privateKey, startFields(nonce, LINK_A));
    expect(await starts.check(forged, context)).toBe("BAD_SIGNATURE");
    expect(await starts.check(await signed(nonce), context)).toBeNull();
  });

  test("a field changed after signing is refused", async () => {
    const start = await signed(issued());
    const moved = { ...start, url: `${ORIGIN}/elsewhere` };
    expect(await starts.check(moved, context)).toBe("BAD_SIGNATURE");
  });

  test("a start carried to another link is refused and spends no nonce", async () => {
    const start = await signed(issued());
    expect(await starts.check(start, { ...context, link: LINK_B })).toBe("LINK_MISMATCH");
    expect(await starts.check(start, context)).toBeNull();
  });

  test("a start signed over another link's fingerprints is refused", async () => {
    expect(await starts.check(await signed(issued(), LINK_B), context)).toBe("LINK_MISMATCH");
  });

  test("a nonce issued on another link is refused on this one", async () => {
    const nonce = String(starts.issue(LINK_B.linkId));
    expect(await starts.check(await signed(nonce), context)).toBe("LINK_MISMATCH");
  });

  test("a nonce of a closed link is gone", async () => {
    const nonce = issued();
    starts.forget(LINK_A.linkId);
    expect(await starts.check(await signed(nonce), context)).toBe("NONCE_UNKNOWN");
  });

  test.each([
    ["an old boot", { bootId: crypto.randomUUID() }, "OLD_BOOT"],
    ["another worker", { workerId: "pppppppppppppppppppppppppppppppp" }, "WRONG_WORKER"],
    ["an expired start", { iat: Date.now() - 20_000, exp: Date.now() - 1 }, "EXPIRED"],
    ["an origin off the allowlist", { url: "http://127.0.0.1:9/" }, "ORIGIN_DENIED"],
  ])("%s is refused", async (_name, overrides, code) => {
    expect(await starts.check(await signed(issued(), LINK_A, overrides), context)).toBe(code);
  });

  test("outstanding challenges are capped", () => {
    const nonces = Array.from({ length: 20 }, () => starts.issue(LINK_A.linkId));
    expect(nonces.filter(Boolean)).toHaveLength(16);
    expect(starts.sizes().issued).toBe(16);
  });
});

describe("the interaction lease", () => {
  let clock: number;
  let leases: ReturnType<typeof createLeases>;
  let leaseId: string;

  beforeEach(() => {
    clock = 1_000_000;
    leases = createLeases({ now: () => clock, leaseMs: 3_000 });
    leaseId = leases.open({ linkId: "link-a", interactId: "i-1", url: `${ORIGIN}/` }).leaseId;
  });

  const message = (seq: number) => ({ leaseId, seq });

  test("in-order messages on its link pass and a renewal extends it", () => {
    expect(leases.admit(message(1), "link-a")).toBeNull();
    clock += 2_500;
    leases.renew();
    clock += 2_500;
    expect(leases.admit(message(2), "link-a")).toBeNull();
    expect(leases.current()?.seq).toBe(2);
  });

  test("a message from another link is refused and the lease stays", () => {
    expect(leases.admit(message(1), "link-b")).toEqual({ code: "LINK_MISMATCH" });
    expect(leases.admit(message(1), "link-a")).toBeNull();
  });

  test("a replayed seq revokes the lease", () => {
    expect(leases.admit(message(1), "link-a")).toBeNull();
    expect(leases.admit(message(1), "link-a")).toMatchObject({ code: "SEQ_REPLAY" });
    expect(leases.current()).toBeNull();
    expect(leases.admit(message(2), "link-a")).toEqual({
      code: "SESSION_REVOKED",
      reason: "SEQ_REPLAY",
    });
  });

  test("a gap in seq revokes the lease", () => {
    expect(leases.admit(message(2), "link-a")).toMatchObject({ code: "SEQ_GAP" });
    expect(leases.current()).toBeNull();
  });

  test("with no renewal the lease expires and every later message is refused", () => {
    clock += 3_001;
    expect(leases.expired()).toBe(true);
    expect(leases.admit(message(1), "link-a")).toMatchObject({ code: "LEASE_EXPIRED" });
    expect(leases.admit(message(2), "link-a")).toMatchObject({ code: "SESSION_REVOKED" });
  });

  test("a lease the worker never issued is refused", () => {
    expect(leases.admit({ leaseId: crypto.randomUUID(), seq: 1 }, "link-a")).toEqual({
      code: "NO_LEASE",
    });
  });

  test("a revoked lease answers its reason", () => {
    expect(leases.revoke("WORKER_STOP")).toMatchObject({ leaseId, reason: "WORKER_STOP" });
    expect(leases.admit(message(1), "link-a")).toEqual({
      code: "SESSION_REVOKED",
      reason: "WORKER_STOP",
    });
  });
});
