import * as v from "valibot";
import { beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { fakeBrowser } from "wxt/testing/fake-browser";
import { PinSchema, createPins } from "@/p2p/pins";
import { PresenceSchema } from "@/p2p/folder-rendezvous";
import { RegistrySchema } from "@/p2p/registry";
import { peerPinsRepository } from "@/storage/peer-repository";

const NOW = 1_700_000_000_000;
const PEER = "22222222-2222-4222-8222-222222222222";
const OTHER = "33333333-3333-4333-8333-333333333333";
const FIRST = "AB:CD:EF";
const SECOND = "12:34:56";

const pins = () => createPins(peerPinsRepository, () => NOW);

beforeEach(() => {
  fakeBrowser.reset();
});

describe("pin", () => {
  test("keeps the first fingerprint with its time and source", async () => {
    const outcome = await pins().pin(PEER, FIRST, "local-channel");
    const pin = { fingerprint: FIRST, pinnedAt: NOW, source: "local-channel" };
    expect(outcome).toEqual({ ok: true, pin });
    expect(await pins().pinOf(PEER)).toEqual(pin);
    expect(await peerPinsRepository.get(PEER)).toEqual(pin);
  });

  test("refuses a second, different fingerprint and the first stands", async () => {
    const store = pins();
    await store.pin(PEER, FIRST, "pairing-code");
    const first = await store.pinOf(PEER);
    const outcome = await store.pin(PEER, SECOND, "manual");
    expect(outcome).toEqual({ ok: false, reason: "pinned-different", pinned: first });
    expect(await store.pinOf(PEER)).toEqual(first);
  });

  test("pinning the same fingerprint again changes nothing", async () => {
    const store = createPins(peerPinsRepository, vi.fn().mockReturnValueOnce(1).mockReturnValue(2));
    await store.pin(PEER, FIRST, "local-channel");
    const again = await store.pin(PEER, FIRST, "manual");
    const pin = { fingerprint: FIRST, pinnedAt: 1, source: "local-channel" };
    expect(again).toEqual({ ok: true, pin });
    expect(await store.pinOf(PEER)).toEqual(pin);
  });

  test("two pins at once keep only the first", async () => {
    const store = pins();
    const [one, two] = await Promise.all([
      store.pin(PEER, FIRST, "local-channel"),
      store.pin(PEER, SECOND, "local-channel"),
    ]);
    expect(one.ok).toBe(true);
    expect(two).toMatchObject({ ok: false, reason: "pinned-different" });
    expect((await store.pinOf(PEER))?.fingerprint).toBe(FIRST);
  });

  test("refuses a malformed fingerprint or profile id without throwing or storing", async () => {
    const store = pins();
    for (const [profileId, fingerprint] of [
      [PEER, "ab:cd"],
      [PEER, ""],
      [PEER, "A".repeat(201)],
      ["not-a-uuid", FIRST],
    ] as const)
      expect(await store.pin(profileId, fingerprint, "manual")).toEqual({
        ok: false,
        reason: "malformed",
      });
    expect(await peerPinsRepository.all()).toEqual({});
  });

  test("a store that fails is a refusal, never an exception", async () => {
    const failing = { get: vi.fn().mockRejectedValue(new Error("disk")), set: vi.fn() };
    expect(await createPins(failing).pin(PEER, FIRST, "manual")).toEqual({
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
    await store.pin(OTHER, FIRST, "local-channel");
    expect(await store.verify(PEER, FIRST)).toBe("unpinned");
    expect(await store.verify(OTHER, SECOND)).toBe("pinned-mismatch");
    expect(await store.verify(OTHER, FIRST)).toBe("pinned-match");
  });

  test("a presence announcing a new certificate is a mismatch and leaves the pin", async () => {
    const store = pins();
    await store.pin(PEER, FIRST, "local-channel");
    const presence = v.parse(PresenceSchema, {
      profileId: PEER,
      displayName: "Desk",
      fingerprint: SECOND,
      createdAt: NOW,
      expiresAt: NOW + 60_000,
    });
    expect(await store.verify(presence.profileId, presence.fingerprint)).toBe("pinned-mismatch");
    await store.pin(presence.profileId, presence.fingerprint, "local-channel");
    expect((await store.pinOf(PEER))?.fingerprint).toBe(FIRST);
  });

  test("a catalog entry announcing a new certificate is a mismatch and leaves the pin", async () => {
    const store = pins();
    await store.pin(PEER, FIRST, "pairing-code");
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
    const entry = registry.peers[PEER];
    expect(entry && (await store.verify(entry.profileId, entry.fingerprint))).toBe(
      "pinned-mismatch",
    );
    expect(await store.pinOf(PEER)).toEqual({
      fingerprint: FIRST,
      pinnedAt: NOW,
      source: "pairing-code",
    });
  });
});

describe("the stored pin", () => {
  test("refuses malformed fingerprints, unknown sources, and extra keys", () => {
    const pin = { fingerprint: FIRST, pinnedAt: NOW, source: "manual" };
    expect(v.is(PinSchema, pin)).toBe(true);
    for (const fingerprint of ["ab:cd:ef", "AB CD", "", "G1:00", "A".repeat(201)])
      expect(v.is(PinSchema, { ...pin, fingerprint })).toBe(false);
    expect(v.is(PinSchema, { ...pin, source: "catalog" })).toBe(false);
    expect(v.is(PinSchema, { ...pin, pinnedAt: -1 })).toBe(false);
    expect(v.is(PinSchema, { ...pin, extra: true })).toBe(false);
  });

  test("a stored pin that does not match its schema is an error, never replaced", async () => {
    await fakeBrowser.storage.local.set({ peerPins: { [PEER]: { fingerprint: "bad" } } });
    await expect(pins().pin(PEER, FIRST, "manual")).resolves.toMatchObject({
      ok: false,
      reason: "store-failed",
    });
    await expect(pins().verify(PEER, FIRST)).rejects.toThrow(/does not match its schema/);
    expect(await fakeBrowser.storage.local.get("peerPins")).toEqual({
      peerPins: { [PEER]: { fingerprint: "bad" } },
    });
  });
});
