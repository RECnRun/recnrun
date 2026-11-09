import { describe, expect, test } from "vite-plus/test";
import { canonical } from "./worker-extension/encoding.js";
import { loadIdentity } from "./worker-extension/identity.js";
import { CONNECT_MS, RECOVER_MS, createLinkState } from "./worker-extension/link-state.js";
import type { LinkChange } from "./worker-extension/link-state.js";
import { createOfferCheck, signAnswer } from "./worker-extension/offer-file.js";
import type { Offer } from "./worker-extension/offer-file.js";

/* Owner flow, task B: the file-signalled link's states, the offer check, and the signed answer. */

const ECDSA = { name: "ECDSA", namedCurve: "P-256" };
const SIGN = { name: "ECDSA", hash: "SHA-256" };
const WORKSPACE = "6f1c2a4e-1b2c-4d3e-8f90-123456789abc";
const NOW = 1_800_000_000_000;
const toUrl = (buffer: ArrayBuffer) => Buffer.from(buffer).toString("base64url");

function fakeTimers() {
  const pending: { run: () => void; at: number }[] = [];
  let clock = 0;
  return {
    setTimer: (run: () => void, ms: number) => pending.push({ run, at: clock + ms }) - 1,
    clearTimer: (id: unknown) => {
      pending[id as number] = { run: () => undefined, at: Infinity };
    },
    advance: (ms: number) => {
      clock += ms;
      for (const entry of pending) {
        if (entry.at > clock) continue;
        entry.at = Infinity;
        entry.run();
      }
    },
  };
}

function linkOf() {
  const changes: LinkChange[] = [];
  const timers = fakeTimers();
  const link = createLinkState({
    onChange: (change) => changes.push(change),
    now: () => NOW,
    ...timers,
  });
  return { link, changes, timers };
}

describe("the link state", () => {
  test("an unlinked worker takes one offer and refuses the next while connecting or linked", () => {
    const { link, changes } = linkOf();
    expect(link.begin("a1")).toBe(true);
    expect(link.begin("a2")).toBe(false);
    link.opened("a1");
    expect(link.begin("a3")).toBe(false);
    expect(changes).toEqual([
      { state: "connecting", attempt: "a1", at: NOW },
      { state: "linked", attempt: "a1", at: NOW },
    ]);
  });

  test("a closed channel recovers for 10 s and then unlinks", () => {
    const { link, timers } = linkOf();
    link.begin("a1");
    link.opened("a1");
    link.closed("a1");
    expect(link.state()).toBe("recovering");
    expect(link.begin("a2")).toBe(false);
    timers.advance(RECOVER_MS - 1);
    expect(link.state()).toBe("recovering");
    timers.advance(1);
    expect(link.state()).toBe("unlinked");
    expect(link.begin("a2")).toBe(true);
  });

  test("a failed or closed peer connection unlinks at once", () => {
    const { link } = linkOf();
    link.begin("a1");
    link.opened("a1");
    link.lost("a1");
    expect(link.state()).toBe("unlinked");
  });

  test("a link that never opens unlinks after the connect window", () => {
    const { link, timers } = linkOf();
    link.begin("a1");
    timers.advance(CONNECT_MS);
    expect(link.state()).toBe("unlinked");
  });

  test("events of an older attempt do not move the current link", () => {
    const { link, timers } = linkOf();
    link.begin("a1");
    link.lost("a1");
    link.begin("a2");
    link.opened("a2");
    link.closed("a1");
    link.lost("a1");
    timers.advance(CONNECT_MS);
    expect(link.state()).toBe("linked");
  });
});

async function master() {
  const pair = await crypto.subtle.generateKey(ECDSA, true, ["sign", "verify"]);
  return { pair, jwk: await crypto.subtle.exportKey("jwk", pair.publicKey) };
}

async function offerOf(key: CryptoKey, over: Partial<Offer> = {}): Promise<Offer> {
  const fields = {
    v: 1 as const,
    type: "offer" as const,
    workspace: WORKSPACE,
    root: "w1",
    attempt: "4b0b6f0e-91c2-4a51-9a3f-6d1f6f0a0b01",
    nonce: "n-1",
    issuedAt: NOW - 1_000,
    expiresAt: NOW + 60_000,
    sdp: "v=0\r\n",
    ...over,
  };
  const data = new TextEncoder().encode(canonical(fields));
  return { ...fields, signature: toUrl(await crypto.subtle.sign(SIGN, key, data)) };
}

describe("the offer check", () => {
  test("a fresh offer signed by the pinned master passes once", async () => {
    const { pair, jwk } = await master();
    const check = createOfferCheck({ now: () => NOW });
    const context = { workspace: WORKSPACE, root: "w1", masterKey: jwk };
    const offer = await offerOf(pair.privateKey);
    expect(await check(offer, context)).toBeNull();
    expect(await check(offer, context)).toBe("SEEN");
  });

  test.each([
    ["another root", { root: "w2" }, "WRONG_ROOT"],
    ["another workspace", { workspace: "x" }, "WRONG_WORKSPACE"],
    ["an expired offer", { expiresAt: NOW }, "EXPIRED"],
    ["an offer from the future", { issuedAt: NOW + 60_000 }, "EXPIRED"],
    ["a bad attempt", { attempt: "../x" }, "BAD_FORMAT"],
  ])("%s is refused", async (_name, over, code) => {
    const { pair, jwk } = await master();
    const check = createOfferCheck({ now: () => NOW });
    const offer = await offerOf(pair.privateKey, over);
    expect(await check(offer, { workspace: WORKSPACE, root: "w1", masterKey: jwk })).toBe(code);
  });

  test("an offer signed by another key, or with an extra field, is refused", async () => {
    const pinned = await master();
    const other = await master();
    const check = createOfferCheck({ now: () => NOW });
    const context = { workspace: WORKSPACE, root: "w1", masterKey: pinned.jwk };
    expect(await check(await offerOf(other.pair.privateKey), context)).toBe("BAD_SIGNATURE");
    const extra = { ...(await offerOf(pinned.pair.privateKey)), extra: 1 };
    expect(await check(extra, context)).toBe("BAD_FORMAT");
  });
});

describe("the answer", () => {
  test("names the offer and verifies under the worker's own key", async () => {
    const { pair } = await master();
    const identity = await loadIdentity({ readPk8: async () => null });
    const offer = await offerOf(pair.privateKey);
    const answer = await signAnswer({ offer, bootId: "boot-1", sdp: "v=0 answer", identity });
    const { signature, ...fields } = answer;
    expect(fields).toEqual({
      v: 1,
      type: "answer",
      root: "w1",
      attempt: offer.attempt,
      nonce: offer.nonce,
      bootId: "boot-1",
      sdp: "v=0 answer",
      workerSpki: identity.spki,
    });
    const data = new TextEncoder().encode(canonical(fields));
    const bytes = Buffer.from(signature, "base64url");
    expect(signature).not.toMatch(/[+/=]/);
    expect(await crypto.subtle.verify(SIGN, identity.publicKey, bytes, data)).toBe(true);
  });
});
