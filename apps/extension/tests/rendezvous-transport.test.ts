import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { CLOCK_SKEW_MS } from "@/p2p/downloads-rendezvous";
import { PAIRING_TTL_MS } from "@/p2p/pairing-code";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence, SignalFile, StampedSignal } from "@/p2p/folder-rendezvous";
import { createSightingFilter, createSignalStamp } from "@/p2p/rendezvous-transport";
import { ME, PEER, PEER_STATEMENT, STRANGER } from "./fake-peer";
import { environments } from "./rendezvous-envs";
import type { RendezvousEnv } from "./rendezvous-envs";

const NOW = 1_700_000_000_000;
const PAIRING = "44444444-4444-4444-8444-444444444444";
const OTHER_PAIRING = "55555555-5555-4555-8555-555555555555";
const BOOT = "66666666-6666-4666-8666-666666666666";
const EARLIER_BOOT = "77777777-7777-4777-8777-777777777777";
const HOUR_MS = 3_600_000;

const presence = (profileId: string): Presence => ({
  profileId,
  displayName: "Laptop",
  fingerprint: "AB:CD:EF",
  // The transport carries the statement; the folder pairing verifies it.
  identity: PEER_STATEMENT,
  createdAt: Date.now(),
  expiresAt: Date.now() + PRESENCE_TTL_MS,
});

const signal = (from: string, to: string, overrides: Partial<SignalFile> = {}): SignalFile => ({
  kind: "offer",
  pairingId: PAIRING,
  profileId: from,
  to,
  expiresAt: Date.now() + PAIRING_TTL_MS,
  code: "RECNRUN-PAIR-1.code",
  ...overrides,
});

const stamped = (overrides: Partial<StampedSignal> = {}): StampedSignal => ({
  ...signal(PEER, ME),
  boot: BOOT,
  sequence: NOW,
  ...overrides,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("createSignalStamp", () => {
  test("stamps the boot and a sequence above the last one and no lower than the clock", () => {
    let clock = NOW;
    const stamp = createSignalStamp(() => clock);
    const sequences = [stamp(signal(ME, PEER), BOOT), stamp(signal(ME, STRANGER), BOOT)];
    clock = NOW + 5000;
    sequences.push(stamp(signal(ME, PEER), BOOT));
    // Back by less than a reader's clock skew, so the order goes on.
    clock = NOW + 1000;
    sequences.push(stamp(signal(ME, PEER), BOOT));
    expect(sequences.map(({ boot, sequence }) => ({ boot, sequence }))).toEqual([
      { boot: BOOT, sequence: NOW },
      { boot: BOOT, sequence: NOW + 1 },
      { boot: BOOT, sequence: NOW + 5000 },
      { boot: BOOT, sequence: NOW + 5001 },
    ]);
    expect(sequences[0]).toEqual({ ...signal(ME, PEER), boot: BOOT, sequence: NOW });
  });

  test("restarts at the clock once it stepped back further than a reader would take", () => {
    let clock = NOW;
    const stamp = createSignalStamp(() => clock);
    stamp(signal(ME, PEER), BOOT);
    clock = NOW - HOUR_MS;
    expect(stamp(signal(ME, PEER), BOOT).sequence).toBe(NOW - HOUR_MS);
  });
});

describe("createSightingFilter", () => {
  // Made in each test, under the fake clock.
  const sender = () => ({ ...presence(PEER), boot: BOOT });

  test("hands the mesh its own shapes, with no boot and no sequence", () => {
    const sift = createSightingFilter();
    expect(sift({ presences: [sender()], signals: [stamped()] })).toEqual({
      presences: [presence(PEER)],
      signals: [signal(PEER, ME)],
    });
  });

  test("drops a signal of another boot than its sender's presence, even once it lapsed", () => {
    const sift = createSightingFilter();
    const earlier = stamped({ boot: EARLIER_BOOT, sequence: NOW + 1 });
    expect(sift({ presences: [sender()], signals: [earlier] }).signals).toEqual([]);
    expect(sift({ presences: [], signals: [earlier] }).signals).toEqual([]);
  });

  test("keeps a signal whose sender has no presence yet", () => {
    const sift = createSightingFilter();
    expect(sift({ presences: [], signals: [stamped()] }).signals).toEqual([signal(PEER, ME)]);
  });

  test("drops a lower sequence of the same boot, and keeps the same file read again", () => {
    const sift = createSightingFilter();
    const look = (each: StampedSignal) => sift({ presences: [sender()], signals: [each] }).signals;
    const newer = stamped({ pairingId: OTHER_PAIRING, sequence: NOW + 1 });
    expect(look(newer)).toHaveLength(1);
    expect(look(newer)).toHaveLength(1);
    expect(look(stamped())).toEqual([]);
    // An answer of the same sender is another file, with its own order.
    expect(look(stamped({ kind: "answer" }))).toHaveLength(1);
  });

  test("drops a signal stamped further ahead than an honest writer could, and hears that writer after it", () => {
    const sift = createSightingFilter();
    const look = (each: StampedSignal) => sift({ presences: [sender()], signals: [each] }).signals;
    expect(look(stamped({ sequence: NOW + CLOCK_SKEW_MS + 1 }))).toEqual([]);
    expect(look(stamped({ expiresAt: NOW + PAIRING_TTL_MS + CLOCK_SKEW_MS + 1 }))).toEqual([]);
    // A sequence refused leaves the order alone, so the writer's next stamp still counts.
    expect(look(stamped())).toHaveLength(1);
    const edge = { sequence: NOW + CLOCK_SKEW_MS, expiresAt: NOW + PAIRING_TTL_MS + CLOCK_SKEW_MS };
    expect(look(stamped({ pairingId: OTHER_PAIRING, ...edge }))).toHaveLength(1);
  });

  test("hears a writer whose clock stepped back and whose stamp restarted at it", () => {
    let clock = NOW;
    const sift = createSightingFilter(() => clock);
    const look = (each: StampedSignal) => sift({ presences: [sender()], signals: [each] }).signals;
    expect(look(stamped())).toHaveLength(1);
    clock = NOW - HOUR_MS;
    expect(look(stamped({ sequence: NOW }))).toEqual([]);
    const restarted = {
      pairingId: OTHER_PAIRING,
      sequence: clock,
      expiresAt: clock + PAIRING_TTL_MS,
    };
    expect(look(stamped(restarted))).toHaveLength(1);
  });

  test("takes a new boot's first signal once the sender's presence names it", () => {
    const sift = createSightingFilter();
    expect(
      sift({ presences: [sender()], signals: [stamped({ sequence: NOW + 9 })] }).signals,
    ).toHaveLength(1);
    const restarted = { ...sender(), boot: EARLIER_BOOT };
    const first = stamped({ boot: EARLIER_BOOT, sequence: NOW + 1 });
    expect(sift({ presences: [restarted], signals: [first] }).signals).toHaveLength(1);
  });
});

describe.each(environments)("the $kind transport", ({ create }) => {
  const announced = async (env: RendezvousEnv, ...profiles: string[]) => {
    const transports = profiles.map((profileId) => env.transport(profileId));
    for (const [index, transport] of transports.entries()) {
      await transport.announce(presence(profiles[index] ?? ""));
    }
    await env.sync();
    return transports;
  };

  test("announce then look sees each profile from the other side", async () => {
    const env = create();
    const [me, peer] = await announced(env, ME, PEER);
    expect(await peer?.look()).toEqual({ presences: [presence(ME)], signals: [] });
    expect(await me?.look()).toEqual({ presences: [presence(PEER)], signals: [] });
  });

  test("publishes an offer only the profile it names sees", async () => {
    const env = create();
    const [me, peer, stranger] = await announced(env, ME, PEER, STRANGER);
    await me?.publish(signal(ME, PEER));
    expect((await peer?.look())?.signals).toEqual([signal(ME, PEER)]);
    expect((await stranger?.look())?.signals).toEqual([]);
    expect((await me?.look())?.signals).toEqual([]);
  });

  test("drops a presence once it expired", async () => {
    const env = create();
    const [, peer] = await announced(env, ME, PEER);
    expect((await peer?.look())?.presences).toEqual([presence(ME)]);
    vi.advanceTimersByTime(PRESENCE_TTL_MS + 1);
    expect((await peer?.look())?.presences).toEqual([]);
  });

  test("skips a corrupt file and reads on", async () => {
    const env = create();
    const [me, peer] = await announced(env, ME, PEER, STRANGER);
    env.drop(STRANGER, "presence.json", "{not json");
    env.drop(STRANGER, `offer-${PEER}.json`, '{"kind":"offer"');
    await me?.publish(signal(ME, PEER));
    expect(await peer?.look()).toEqual({ presences: [presence(ME)], signals: [signal(ME, PEER)] });
  });

  test("ignores a signal from an earlier boot of its sender", async () => {
    const env = create();
    const [, peer] = await announced(env, ME, PEER);
    const earlier = { ...signal(ME, PEER), boot: EARLIER_BOOT, sequence: NOW + 60_000 };
    env.drop(ME, `offer-${PEER}.json`, JSON.stringify(earlier));
    expect((await peer?.look())?.signals).toEqual([]);
  });

  test("ignores a lower sequence of the same boot, then takes a newer one", async () => {
    const env = create();
    const [me, peer] = await announced(env, ME, PEER);
    await me?.publish(signal(ME, PEER));
    expect((await peer?.look())?.signals).toEqual([signal(ME, PEER)]);
    const written = JSON.parse(env.file(ME, `offer-${PEER}.json`) ?? "{}") as StampedSignal;
    const late = { ...written, pairingId: OTHER_PAIRING, sequence: written.sequence - 1 };
    env.drop(ME, `offer-${PEER}.json`, JSON.stringify(late));
    expect((await peer?.look())?.signals).toEqual([]);
    await me?.publish(signal(ME, PEER, { pairingId: OTHER_PAIRING }));
    expect((await peer?.look())?.signals).toEqual([signal(ME, PEER, { pairingId: OTHER_PAIRING })]);
  });

  test("ignores a signal stamped an hour ahead, then takes the writer's next one", async () => {
    const env = create();
    const [me, peer] = await announced(env, ME, PEER);
    await me?.publish(signal(ME, PEER));
    const written = JSON.parse(env.file(ME, `offer-${PEER}.json`) ?? "{}") as StampedSignal;
    const ahead = { ...written, pairingId: OTHER_PAIRING, sequence: written.sequence + HOUR_MS };
    env.drop(ME, `offer-${PEER}.json`, JSON.stringify(ahead));
    expect((await peer?.look())?.signals).toEqual([]);
    const lasting = { ...written, pairingId: OTHER_PAIRING, expiresAt: NOW + HOUR_MS };
    env.drop(
      ME,
      `offer-${PEER}.json`,
      JSON.stringify({ ...lasting, sequence: written.sequence + 1 }),
    );
    expect((await peer?.look())?.signals).toEqual([]);
    await me?.publish(signal(ME, PEER, { pairingId: OTHER_PAIRING }));
    expect((await peer?.look())?.signals).toEqual([signal(ME, PEER, { pairingId: OTHER_PAIRING })]);
  });

  test("clean removes only this profile's own files", async () => {
    const env = create();
    const [me, peer] = await announced(env, ME, PEER);
    await me?.publish(signal(ME, PEER));
    await peer?.publish(signal(PEER, ME, { kind: "answer" }));
    env.drop(ME, "notes.txt", "kept");
    await me?.clean();
    expect(env.names(ME)).toEqual(["notes.txt"]);
    expect(env.names(PEER).toSorted()).toEqual(["answer-" + ME + ".json", "presence.json"]);
  });

  test("a second instance on the same root sees the first's presence", async () => {
    const env = create();
    const mine = presence(ME);
    await announced(env, ME);
    vi.advanceTimersByTime(1000);
    const later = env.transport(PEER);
    expect(await later.look()).toEqual({ presences: [mine], signals: [] });
  });
});
