import * as v from "valibot";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PresenceSchema } from "@/p2p/folder-rendezvous";
import { signerOf } from "@/p2p/identity-key";
import { PinSchema, createPins } from "@/p2p/pins";
import { RegistrySchema } from "@/p2p/registry";
import { peerPinsRepository } from "@/storage/peer-repository";
import { identityOf, signAs } from "./test-identity";

const NOW = 1_700_000_000_000;
const PEER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const FIRST = "AB:CD:EF";
const SECOND = "12:34:56";
const KEY = await identityOf(PEER);
const FORGER = await identityOf("forger");

const pins = () => createPins(peerPinsRepository(), () => NOW);
const proven = (fingerprint: string, identity = KEY) => ({ identity, fingerprint });

beforeEach(() => {
  fakeBrowser.reset();
});

describe("pin", () => {
  test("keeps the first identity and certificate with its time and source", async () => {
    const outcome = await pins().pin(PEER, proven(FIRST), "local-channel");
    const pin = { fingerprint: FIRST, pinnedAt: NOW, source: "local-channel", identity: KEY };
    expect(outcome).toEqual({ ok: true, pin });
    expect(await pins().pinOf(PEER)).toEqual(pin);
    expect(await peerPinsRepository().get(PEER)).toEqual(pin);
  });

  test("refuses another identity and the first stands", async () => {
    const store = pins();
    await store.pin(PEER, proven(FIRST), "pairing-code");
    const first = await store.pinOf(PEER);
    const outcome = await store.pin(PEER, proven(SECOND, FORGER), "manual");
    expect(outcome).toEqual({ ok: false, reason: "pinned-different", pinned: first });
    expect(await store.pinOf(PEER)).toEqual(first);
  });

  test("a renewed certificate of the pinned identity moves only the fingerprint", async () => {
    const store = createPins(
      peerPinsRepository(),
      vi.fn().mockReturnValueOnce(1).mockReturnValue(2),
    );
    await store.pin(PEER, proven(FIRST), "pairing-code");
    const renewed = await store.pin(PEER, proven(SECOND), "local-channel");
    const pin = { fingerprint: SECOND, pinnedAt: 1, source: "pairing-code", identity: KEY };
    expect(renewed).toEqual({ ok: true, pin });
    expect(await store.pinOf(PEER)).toEqual(pin);
  });

  test("pinning the same identity and certificate again writes nothing", async () => {
    const set = vi.fn(peerPinsRepository().set);
    const store = createPins({ get: peerPinsRepository().get, set }, () => NOW);
    await store.pin(PEER, proven(FIRST), "local-channel");
    const again = await store.pin(PEER, proven(FIRST), "manual");
    const pin = { fingerprint: FIRST, pinnedAt: NOW, source: "local-channel", identity: KEY };
    expect(again).toEqual({ ok: true, pin });
    expect(set).toHaveBeenCalledTimes(1);
  });

  test("two pins at once keep only the first identity", async () => {
    const store = pins();
    const [one, two] = await Promise.all([
      store.pin(PEER, proven(FIRST), "local-channel"),
      store.pin(PEER, proven(SECOND, FORGER), "local-channel"),
    ]);
    expect(one.ok).toBe(true);
    expect(two).toMatchObject({ ok: false, reason: "pinned-different" });
    expect(await store.pinOf(PEER)).toMatchObject({ fingerprint: FIRST, identity: KEY });
  });

  test("refuses a malformed fingerprint, key, or profile id without throwing or storing", async () => {
    const store = pins();
    for (const [profileId, fingerprint, identity] of [
      [PEER, "ab:cd", KEY],
      [PEER, "", KEY],
      [PEER, "A".repeat(201), KEY],
      [PEER, FIRST, ""],
      [PEER, FIRST, KEY.slice(1)],
      [PEER, FIRST, `${KEY.slice(1)}+`],
      ["not-a-uuid", FIRST, KEY],
    ] as const)
      expect(await store.pin(profileId, { identity, fingerprint }, "manual")).toEqual({
        ok: false,
        reason: "malformed",
      });
    expect(await peerPinsRepository().all()).toEqual({});
  });

  test("a store that fails is a refusal, never an exception", async () => {
    const failing = { get: vi.fn().mockRejectedValue(new Error("disk")), set: vi.fn() };
    expect(await createPins(failing).pin(PEER, proven(FIRST), "manual")).toEqual({
      ok: false,
      reason: "store-failed",
      error: "disk",
    });
    expect(failing.set).not.toHaveBeenCalled();
  });
});

describe("verify", () => {
  test("answers unpinned for a profile never pinned, distinct from a mismatch", async () => {
    const store = pins();
    await store.pin(OTHER, proven(FIRST), "local-channel");
    expect(await store.verify(PEER, KEY)).toBe("unpinned");
    expect(await store.verify(PEER, undefined)).toBe("unpinned");
    expect(await store.verify(OTHER, FORGER)).toBe("pinned-mismatch");
    expect(await store.verify(OTHER, undefined)).toBe("pinned-mismatch");
    expect(await store.verify(OTHER, KEY)).toBe("pinned-match");
  });

  const presenceOf = async (fingerprint: string, as = PEER) =>
    v.parse(PresenceSchema, {
      profileId: PEER,
      displayName: "Desk",
      fingerprint,
      identity: await signAs({ profileId: PEER, fingerprint }, as),
      createdAt: NOW,
      expiresAt: NOW + 60_000,
    });
  const signer = ({ identity, profileId, fingerprint }: v.InferOutput<typeof PresenceSchema>) =>
    signerOf(identity, { profileId, fingerprint });

  test("a presence of a renewed certificate the pinned identity signed matches", async () => {
    const store = pins();
    await store.pin(PEER, proven(FIRST), "local-channel");
    const presence = await presenceOf(SECOND);
    expect(await store.verify(PEER, await signer(presence))).toBe("pinned-match");
  });

  test("a presence of a certificate another key signed is a mismatch and leaves the pin", async () => {
    const store = pins();
    await store.pin(PEER, proven(FIRST), "local-channel");
    const presence = await presenceOf(SECOND, "forger");
    expect(await store.verify(PEER, await signer(presence))).toBe("pinned-mismatch");
    expect(await store.pinOf(PEER)).toMatchObject({ fingerprint: FIRST, identity: KEY });
  });

  test("a catalog entry signs nothing, so it never speaks for a pinned profile", async () => {
    const store = pins();
    await store.pin(PEER, proven(FIRST), "pairing-code");
    const boot = "44444444-4444-4444-8444-444444444444";
    const registry = v.parse(RegistrySchema, {
      version: 1,
      namespace: "lab",
      writtenAt: NOW,
      launcher: { boot },
      peers: {
        [PEER]: {
          profileId: PEER,
          displayName: "Desk",
          fingerprint: SECOND,
          root: "r1",
          lastSeenAt: NOW,
          expiresAt: NOW + 60_000,
          boot,
        },
      },
    });
    expect(registry.peers[PEER]).not.toHaveProperty("identity");
    expect(await store.verify(PEER, undefined)).toBe("pinned-mismatch");
    expect(await store.pinOf(PEER)).toEqual({
      fingerprint: FIRST,
      pinnedAt: NOW,
      source: "pairing-code",
      identity: KEY,
    });
  });
});

describe("the stored pin", () => {
  test("refuses malformed fingerprints and keys, unknown sources, and extra keys", () => {
    const pin = { fingerprint: FIRST, pinnedAt: NOW, source: "manual", identity: KEY };
    expect(v.is(PinSchema, pin)).toBe(true);
    for (const fingerprint of ["ab:cd:ef", "AB CD", "", "G1:00", "A".repeat(201)])
      expect(v.is(PinSchema, { ...pin, fingerprint })).toBe(false);
    for (const identity of ["", KEY.slice(1), `${KEY}A`, `${KEY.slice(1)}=`])
      expect(v.is(PinSchema, { ...pin, identity })).toBe(false);
    expect(v.is(PinSchema, { fingerprint: FIRST, pinnedAt: NOW, source: "manual" })).toBe(false);
    expect(v.is(PinSchema, { ...pin, source: "catalog" })).toBe(false);
    expect(v.is(PinSchema, { ...pin, pinnedAt: -1 })).toBe(false);
    expect(v.is(PinSchema, { ...pin, extra: true })).toBe(false);
  });

  test("a stored pin that does not match its schema is an error, never replaced", async () => {
    await fakeBrowser.storage.local.set({ peerPins: { [PEER]: { fingerprint: "bad" } } });
    await expect(pins().pin(PEER, proven(FIRST), "manual")).resolves.toMatchObject({
      ok: false,
      reason: "store-failed",
    });
    await expect(pins().verify(PEER, KEY)).rejects.toThrow(/does not match its schema/);
    expect(await fakeBrowser.storage.local.get("peerPins")).toEqual({
      peerPins: { [PEER]: { fingerprint: "bad" } },
    });
  });
});
