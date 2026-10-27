import { describe, expect, test, vi } from "vite-plus/test";
import { createPairing } from "@/background/pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import { PAIRING_TTL_MS, decodePairing, encodePairing } from "@/p2p/pairing-code";
import type { AuthorizedPeer } from "@/storage/peer-repository";
import { memoryRecords } from "./fake-peer";

const NOW = 1_700_000_000_000;
const A = { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Work" };
const B = { profileId: "22222222-2222-4222-8222-222222222222", displayName: "Home" };
const FP_A = "AA:AA";
const FP_B = "BB:BB";
const C = { profileId: "33333333-3333-4333-8333-333333333333", displayName: "Lab" };
const FP_C = "CC:CC";
const STRANGER = "44444444-4444-4444-8444-444444444444";
const sdpWith = (fingerprint: string) => `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;

interface PendingOffer {
  pairingId: string;
  expiresAt: number;
  to: string;
}

/** One profile's pairing flow over a fake link whose certificate is `fingerprint`. */
function side(identity: typeof A, fingerprint: string, clock = { now: NOW }) {
  const sdp = sdpWith(fingerprint);
  const askLink = vi.fn(async (command: LinkCommand): Promise<unknown> => {
    if (command.type === "offer" || command.type === "answer") return { sdp };
    return {};
  });
  const authorized = memoryRecords<AuthorizedPeer>();
  const pending = memoryRecords<PendingOffer>();
  const flow = createPairing({
    askLink,
    identity: async () => identity,
    authorized,
    pending,
    now: () => clock.now,
  });
  return { ...flow, askLink, authorized, pending, clock };
}

async function offered() {
  const a = side(A, FP_A);
  const b = side(B, FP_B);
  const { code } = await a.createOffer(B.profileId);
  return { a, b, offer: code };
}

describe("a full pairing", () => {
  test("authorizes each other, each pinned to the other's certificate", async () => {
    const { a, b, offer } = await offered();
    const pairingId = decodePairing(offer, NOW).pairingId;
    expect(await a.pending.get(B.profileId)).toEqual({
      pairingId,
      expiresAt: NOW + PAIRING_TTL_MS,
      to: B.profileId,
    });
    expect(await b.authorized.all()).toEqual({});

    const { code: answer = "" } = await b.accept(offer);
    expect(b.askLink).toHaveBeenCalledWith({
      type: "answer",
      peer: A.profileId,
      sdp: sdpWith(FP_A),
    });
    expect(await b.authorized.all()).toEqual({ [A.profileId]: { ...A, fingerprint: FP_A } });
    expect(decodePairing(answer, NOW)).toMatchObject({ kind: "answer", pairingId, ...B });

    expect(await a.accept(answer)).toEqual({});
    expect(a.askLink).toHaveBeenCalledWith({
      type: "accept-answer",
      peer: B.profileId,
      sdp: sdpWith(FP_B),
    });
    expect(await a.authorized.all()).toEqual({ [B.profileId]: { ...B, fingerprint: FP_B } });
    expect(await a.pending.all()).toEqual({});
  });

  test("accepting a second profile keeps the first", async () => {
    const { a, b, offer } = await offered();
    await a.accept((await b.accept(offer)).code ?? "");
    const c = side(C, FP_C);
    const { code: toC } = await a.createOffer(C.profileId);
    await a.accept((await c.accept(toC)).code ?? "");
    expect(await a.authorized.all()).toEqual({
      [B.profileId]: { ...B, fingerprint: FP_B },
      [C.profileId]: { ...C, fingerprint: FP_C },
    });
  });

  test("keeps each profile's offer apart until its answer comes", async () => {
    const a = side(A, FP_A);
    const b = side(B, FP_B);
    const c = side(C, FP_C);
    const toB = (await a.createOffer(B.profileId)).code;
    const toC = (await a.createOffer(C.profileId)).code;
    await a.accept((await c.accept(toC)).code ?? "");
    expect(Object.keys(await a.pending.all())).toEqual([B.profileId]);
    await a.accept((await b.accept(toB)).code ?? "");
    expect(await a.pending.all()).toEqual({});
  });

  test("dates codes from the real clock by default", async () => {
    const flow = createPairing({
      askLink: async () => ({ sdp: sdpWith(FP_A) }),
      identity: async () => A,
      authorized: memoryRecords<AuthorizedPeer>(),
      pending: memoryRecords<PendingOffer>(),
    });
    const before = Date.now();
    const { expiresAt } = decodePairing((await flow.createOffer(B.profileId)).code);
    expect(expiresAt).toBeGreaterThanOrEqual(before + PAIRING_TTL_MS);
  });
});

describe("refused codes", () => {
  test("refuses this profile's own code", async () => {
    const { a, offer } = await offered();
    await expect(a.accept(offer)).rejects.toThrow("This code comes from this profile.");
  });

  test("refuses an expired code", async () => {
    const { b, offer } = await offered();
    b.clock.now = NOW + PAIRING_TTL_MS;
    await expect(b.accept(offer)).rejects.toThrow("The pairing code expired; create a new one.");
    expect(await b.authorized.all()).toEqual({});
  });

  test("refuses an answer to another offer, to none, or to an expired one", async () => {
    const { a, b, offer } = await offered();
    const { code: answer = "" } = await b.accept(offer);
    const wrong = "This answer is not for the offer this profile made.";
    const pairingId = "55555555-5555-4555-8555-555555555555";
    const to = B.profileId;
    await a.pending.set(to, { pairingId, expiresAt: NOW + PAIRING_TTL_MS, to });
    await expect(a.accept(answer)).rejects.toThrow(wrong);
    await a.pending.set(to, null);
    await expect(a.accept(answer)).rejects.toThrow(wrong);
    // An offer to another profile answers nothing from B.
    const made = { pairingId: decodePairing(answer, NOW).pairingId, expiresAt: NOW + 1 };
    await a.pending.set(STRANGER, { ...made, to: STRANGER });
    await expect(a.accept(answer)).rejects.toThrow(wrong);
    await a.pending.set(to, { ...made, expiresAt: NOW, to });
    await expect(a.accept(answer)).rejects.toThrow(wrong);
    expect(await a.authorized.all()).toEqual({});
  });

  test("refuses a code without a certificate fingerprint", async () => {
    const b = side(B, FP_B);
    const code = encodePairing({
      kind: "offer",
      pairingId: "66666666-6666-4666-8666-666666666666",
      ...A,
      expiresAt: NOW + PAIRING_TTL_MS,
      sdp: "v=0\r\n",
    });
    await expect(b.accept(code)).rejects.toThrow("The code has no certificate fingerprint.");
    expect(await b.authorized.all()).toEqual({});
  });
});
