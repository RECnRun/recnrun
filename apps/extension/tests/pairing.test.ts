import { expect, test } from "vite-plus/test";
import { createPairing } from "@/background/pairing";
import { encodePairing } from "@/p2p/pairing-code";

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";
const sdpWith = (fingerprint: string) => `v=0\r\na=fingerprint:sha-256 ${fingerprint}\r\n`;

function memory<T>(initial: T | null = null) {
  let value = initial;
  return {
    read: async () => value,
    write: async (next: T | null) => {
      value = next;
    },
  };
}

/** One profile's pairing, its link replaced by a recorder that answers with its own SDP. */
function profile(profileId: string, fingerprint: string, now = () => 1_000) {
  const commands: string[] = [];
  const authorized = memory<{ profileId: string; displayName: string; fingerprint: string }>();
  const pending = memory<{ pairingId: string; expiresAt: number }>();
  const pairing = createPairing({
    askLink: async (command) => {
      commands.push(command.type);
      return command.type === "link-fingerprint" ? { fingerprint } : { sdp: sdpWith(fingerprint) };
    },
    identity: async () => ({ profileId, displayName: `Profile ${profileId.slice(0, 1)}` }),
    authorized,
    pending,
    now,
  });
  return { pairing, commands, authorized, pending };
}

test("pairs two profiles, each confirming the same digits", async () => {
  const home = profile(A, "AA:01");
  const work = profile(B, "BB:02");
  const { code: offer } = await home.pairing.createOffer();
  const seenByWork = await work.pairing.inspect(offer);
  expect(seenByWork).toMatchObject({ kind: "offer", profileId: A, known: false });
  expect(await work.authorized.read()).toBeNull();

  const { code: answer } = await work.pairing.accept(offer);
  expect(await work.authorized.read()).toEqual({
    profileId: A,
    displayName: "Profile 1",
    fingerprint: "AA:01",
  });
  const seenByHome = await home.pairing.inspect(answer ?? "");
  expect(seenByHome).toMatchObject({ kind: "answer", profileId: B, sas: seenByWork.sas });

  expect(await home.pairing.accept(answer ?? "")).toEqual({});
  expect(await home.authorized.read()).toMatchObject({ profileId: B, fingerprint: "BB:02" });
  expect(await home.pending.read()).toBeNull();
  expect(home.commands).toEqual(["link-offer", "link-fingerprint", "link-accept-answer"]);
  expect(work.commands).toEqual(["link-fingerprint", "link-answer"]);
});

test("recognizes the peer it already trusts", async () => {
  const home = profile(A, "AA:01");
  const work = profile(B, "BB:02");
  await work.authorized.write({ profileId: A, displayName: "Home", fingerprint: "AA:01" });
  const { code } = await home.pairing.createOffer();
  expect(await work.pairing.inspect(code)).toMatchObject({ known: true });
});

test("refuses its own offer", async () => {
  const home = profile(A, "AA:01");
  const { code } = await home.pairing.createOffer();
  await expect(home.pairing.accept(code)).rejects.toThrow("comes from this profile");
});

test("refuses an answer to an offer it did not make", async () => {
  const home = profile(A, "AA:01");
  const work = profile(B, "BB:02");
  const stray = encodePairing({
    kind: "answer",
    pairingId: "44444444-4444-4444-8444-444444444444",
    profileId: B,
    displayName: "Work",
    expiresAt: 9_999_999,
    sdp: sdpWith("BB:02"),
  });
  await home.pairing.createOffer();
  await expect(home.pairing.inspect(stray)).rejects.toThrow("not for the offer");
  await expect(home.pairing.accept(stray)).rejects.toThrow("not for the offer");
  expect(await home.authorized.read()).toBeNull();
  expect(work.commands).toEqual([]);
});

test("refuses an answer once its offer expired", async () => {
  let now = 1_000;
  const home = profile(A, "AA:01", () => now);
  const work = profile(B, "BB:02", () => now);
  const { code: offer } = await home.pairing.createOffer();
  const { code: answer } = await work.pairing.accept(offer);
  now += 5 * 60 * 1000;
  await expect(home.pairing.accept(answer ?? "")).rejects.toThrow(/expired|not for the offer/);
});

test("refuses a code without a certificate fingerprint", async () => {
  const work = profile(B, "BB:02");
  const code = encodePairing({
    kind: "offer",
    pairingId: "55555555-5555-4555-8555-555555555555",
    profileId: A,
    displayName: "Home",
    expiresAt: 9_999_999,
    sdp: "v=0\r\n",
  });
  await expect(work.pairing.accept(code)).rejects.toThrow("no certificate fingerprint");
});
