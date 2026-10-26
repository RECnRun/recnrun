import { describe, expect, test, vi } from "vite-plus/test";
import { createPairing } from "@/background/pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import { PAIRING_TTL_MS, decodePairing, encodePairing } from "@/p2p/pairing-code";
import type { AuthorizedPeer } from "@/storage/peer-repository";

const NOW = 1_700_000_000_000;
const A = { profileId: "11111111-1111-4111-8111-111111111111", displayName: "Work" };
const B = { profileId: "22222222-2222-4222-8222-222222222222", displayName: "Home" };
const FP_A = "AA:AA";
const FP_B = "BB:BB";
const sdpWith = (fingerprint: string) => `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;

interface PendingOffer {
  pairingId: string;
  expiresAt: number;
  to?: string;
}

function memory<T>(initial: T | null = null) {
  let value = initial;
  return { read: async () => value, write: async (next: T | null) => void (value = next) };
}

/** One profile's pairing flow over a fake link whose certificate is `fingerprint`. */
function side(identity: typeof A, fingerprint: string, clock = { now: NOW }) {
  const sdp = sdpWith(fingerprint);
  const askLink = vi.fn(async (command: LinkCommand): Promise<unknown> => {
    if (command.type === "fingerprint") return { fingerprint };
    if (command.type === "offer" || command.type === "answer") return { sdp };
    return {};
  });
  const authorized = memory<AuthorizedPeer>();
  const pending = memory<PendingOffer>();
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
  const { code } = await a.createOffer();
  return { a, b, offer: code };
}

describe("a full pairing", () => {
  test("shows the same digits on both profiles and authorizes each other", async () => {
    const { a, b, offer } = await offered();
    const pairingId = decodePairing(offer, NOW).pairingId;
    expect(await a.pending.read()).toEqual({ pairingId, expiresAt: NOW + PAIRING_TTL_MS });

    const seenByB = await b.inspect(offer);
    expect(seenByB).toMatchObject({ kind: "offer", ...A, known: false });
    expect(seenByB.digits).toMatch(/^\d{6}$/);
    expect(await b.authorized.read()).toBeNull();

    const { code: answer = "" } = await b.accept(offer);
    expect(b.askLink).toHaveBeenCalledWith({ type: "answer", sdp: sdpWith(FP_A) });
    expect(await b.authorized.read()).toEqual({ ...A, fingerprint: FP_A });
    expect(decodePairing(answer, NOW)).toMatchObject({ kind: "answer", pairingId, ...B });

    const seenByA = await a.inspect(answer);
    expect(seenByA).toEqual({ kind: "answer", ...B, digits: seenByB.digits, known: false });
    expect(await a.accept(answer)).toEqual({});
    expect(a.askLink).toHaveBeenCalledWith({ type: "accept-answer", sdp: sdpWith(FP_B) });
    expect(await a.authorized.read()).toEqual({ ...B, fingerprint: FP_B });
    expect(await a.pending.read()).toBeNull();
  });

  test("knows a peer it authorized with the same certificate", async () => {
    const { b, offer } = await offered();
    await b.authorized.write({ ...A, fingerprint: FP_A });
    expect((await b.inspect(offer)).known).toBe(true);
    await b.authorized.write({ ...A, fingerprint: "CC:CC" });
    expect((await b.inspect(offer)).known).toBe(false);
    await b.authorized.write({ ...B, fingerprint: FP_A });
    expect((await b.inspect(offer)).known).toBe(false);
  });

  test("remembers whom an offer through the folder is for", async () => {
    const a = side(A, FP_A);
    const { code } = await a.createOffer(B.profileId);
    const { pairingId } = decodePairing(code, NOW);
    expect(await a.pending.read()).toEqual({
      pairingId,
      expiresAt: NOW + PAIRING_TTL_MS,
      to: B.profileId,
    });
  });

  test("dates codes from the real clock by default", async () => {
    const flow = createPairing({
      askLink: async () => ({ sdp: sdpWith(FP_A) }),
      identity: async () => A,
      authorized: memory<AuthorizedPeer>(),
      pending: memory<PendingOffer>(),
    });
    const before = Date.now();
    const { expiresAt } = decodePairing((await flow.createOffer()).code);
    expect(expiresAt).toBeGreaterThanOrEqual(before + PAIRING_TTL_MS);
  });
});

describe("refused codes", () => {
  test("refuses this profile's own code", async () => {
    const { a, offer } = await offered();
    await expect(a.inspect(offer)).rejects.toThrow("This code comes from this profile.");
    await expect(a.accept(offer)).rejects.toThrow("This code comes from this profile.");
  });

  test("refuses an expired code", async () => {
    const { b, offer } = await offered();
    b.clock.now = NOW + PAIRING_TTL_MS;
    await expect(b.inspect(offer)).rejects.toThrow("The pairing code expired; create a new one.");
  });

  test("refuses an answer to another offer, to none, or to an expired one", async () => {
    const { a, b, offer } = await offered();
    const { code: answer = "" } = await b.accept(offer);
    const wrong = "This answer is not for the offer this profile made.";
    const pairingId = "55555555-5555-4555-8555-555555555555";
    await a.pending.write({ pairingId, expiresAt: NOW + PAIRING_TTL_MS });
    await expect(a.inspect(answer)).rejects.toThrow(wrong);
    await a.pending.write(null);
    await expect(a.accept(answer)).rejects.toThrow(wrong);
    await a.pending.write({ pairingId: decodePairing(answer, NOW).pairingId, expiresAt: NOW });
    await expect(a.accept(answer)).rejects.toThrow(wrong);
    expect(await a.authorized.read()).toBeNull();
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
    expect(await b.authorized.read()).toBeNull();
  });
});
