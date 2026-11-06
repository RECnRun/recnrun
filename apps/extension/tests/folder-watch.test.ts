import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { LinkEvent } from "@/messaging/peer-messages";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import type { RendezvousTransport } from "@/p2p/rendezvous-transport";
import { createRendezvousWatch } from "@/offscreen/folder-watch";
import { folderTransport } from "@/p2p/folder-store";
import { ME, PEER, PEER_STATEMENT } from "./fake-peer";
import { MemoryDirectory } from "./memory-directory";
import { signAs } from "./test-identity";

const NOW = 1_700_000_000_000;
const PAIRING = "44444444-4444-4444-8444-444444444444";
const IDENTITY = { profileId: ME, displayName: "Laptop" };
const PEER_BOOT = "66666666-6666-4666-8666-666666666666";
const BOOT = "77777777-7777-4777-8777-777777777777";
// Signed once: a real signature takes longer than the fake timers these tests advance.
const STATEMENT = await signAs({ profileId: ME, fingerprint: "11:22" });
const sign = async () => STATEMENT;

const peerPresence: Presence = {
  profileId: PEER,
  displayName: "Desk",
  fingerprint: "AB:CD:EF",
  identity: PEER_STATEMENT,
  createdAt: NOW,
  expiresAt: NOW + 10 * PRESENCE_TTL_MS,
};

/** The offscreen document's watch over a folder in memory, its reports recorded. */
function watching(chosen: MemoryDirectory | null = new MemoryDirectory()) {
  const events: LinkEvent[] = [];
  const load = async () => (chosen ?? undefined) as FileSystemDirectoryHandle | undefined;
  const watch = createRendezvousWatch({
    report: (event) => events.push(event),
    fingerprint: "11:22",
    sign,
    transport: (me) => folderTransport({ me, boot: BOOT, load }),
  });
  const pairing = (owner: string) => (chosen ?? new MemoryDirectory()).folder("pairing", owner);
  const mine = () => JSON.parse(pairing(ME).files.get("presence.json") ?? "null") as unknown;
  return { events, watch, pairing, mine };
}

const sighting = (presences: Presence[] = [], signals: SignalFile[] = []) => ({
  type: "folder",
  presences,
  signals,
});

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("watch", () => {
  test("announces this profile and reports what the others left, once per change", async () => {
    const { events, watch, pairing, mine } = watching();
    await watch.watch(IDENTITY);
    expect(mine()).toEqual({
      ...IDENTITY,
      fingerprint: "11:22",
      identity: STATEMENT,
      createdAt: NOW,
      expiresAt: NOW + PRESENCE_TTL_MS,
      boot: BOOT,
    });
    expect(events).toEqual([sighting()]);
    pairing(PEER).drop("presence.json", { ...peerPresence, boot: PEER_BOOT });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([sighting(), sighting([peerPresence])]);
  });

  test("repeats an unchanged sighting now and then, for a background that slept", async () => {
    const { events, watch } = watching();
    await watch.watch(IDENTITY);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(events).toEqual([sighting(), sighting()]);
  });

  test("refreshes its presence before it expires, and keeps when it started", async () => {
    const { watch, mine } = watching();
    await watch.watch(IDENTITY);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS / 2 + 1000);
    expect(mine()).toMatchObject({
      createdAt: NOW,
      expiresAt: Date.now() + PRESENCE_TTL_MS,
    });
  });

  test("keeps polling after a read that fails", async () => {
    const chosen = new MemoryDirectory();
    const { events, watch, pairing } = watching(chosen);
    await watch.watch(IDENTITY);
    const broken = vi.spyOn(chosen, "getDirectoryHandle").mockRejectedValue(new Error("Gone."));
    await vi.advanceTimersByTimeAsync(1000);
    broken.mockRestore();
    pairing(PEER).drop("presence.json", { ...peerPresence, boot: PEER_BOOT });
    await vi.advanceTimersByTimeAsync(1000);
    expect(events).toEqual([sighting(), sighting([peerPresence])]);
  });

  test("refuses to watch before a folder is chosen", async () => {
    const { watch } = watching(null);
    await expect(watch.watch(IDENTITY)).rejects.toThrow("Choose the RECnRun folder first.");
  });
});

describe("publish and stop", () => {
  test("publishes into this profile's folder, and stops by removing its files", async () => {
    const { events, watch, pairing } = watching();
    await watch.watch(IDENTITY);
    const offer: SignalFile = {
      kind: "offer",
      pairingId: PAIRING,
      profileId: ME,
      to: PEER,
      expiresAt: NOW + 60_000,
      code: "RECNRUN-PAIR-1.code",
    };
    await watch.publish(offer);
    expect([...pairing(ME).files.keys()]).toEqual(["presence.json", `offer-${PEER}.json`]);
    await watch.stop();
    expect([...pairing(ME).files.keys()]).toEqual([]);
    pairing(PEER).drop("presence.json", { ...peerPresence, boot: PEER_BOOT });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toEqual([sighting()]);
  });

  test("stops quietly when it never watched", async () => {
    const { watch } = watching(null);
    await expect(watch.stop()).resolves.toBeUndefined();
  });
});

/** A transport whose reads the test holds or fails. */
function fakeTransport(kind: RendezvousTransport["kind"] = "downloads") {
  const transport = {
    kind,
    available: vi.fn(async () => true),
    announce: vi.fn(async () => {}),
    publish: vi.fn(async () => {}),
    look: vi.fn(async (): Promise<Seen> => ({ presences: [], signals: [] })),
    discover: vi.fn(async () => []),
    clean: vi.fn(async () => {}),
  } satisfies RendezvousTransport;
  const made = vi.fn(() => transport);
  const watch = createRendezvousWatch({
    report: () => {},
    fingerprint: "11:22",
    sign,
    transport: made,
  });
  /** Holds the next read until `release` is called. */
  const holdNextLook = () => {
    let release = () => {};
    transport.look.mockImplementationOnce(
      () => new Promise((resolve) => (release = () => resolve({ presences: [], signals: [] }))),
    );
    return () => release();
  };
  return { transport, made, watch, holdNextLook };
}

describe("polls", () => {
  test("never start while the last one still reads, and the transport is made once", async () => {
    const { transport, made, watch, holdNextLook } = fakeTransport();
    await watch.watch(IDENTITY);
    const release = holdNextLook();
    await vi.advanceTimersByTimeAsync(5000);
    expect(transport.look).toHaveBeenCalledTimes(2);
    release();
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport.look).toHaveBeenCalledTimes(3);
    expect(made).toHaveBeenCalledTimes(1);
  });

  test("wait longer after each failure, up to ten seconds, and every second again after a success", async () => {
    const { transport, watch } = fakeTransport();
    await watch.watch(IDENTITY);
    let failing = true;
    const at: number[] = [];
    transport.look.mockImplementation(async () => {
      at.push(Date.now() - NOW);
      if (failing) throw new Error("Gone.");
      return { presences: [], signals: [] };
    });
    await vi.advanceTimersByTimeAsync(40_000);
    expect(at).toEqual([1000, 2000, 4000, 8000, 16_000, 26_000, 36_000]);
    failing = false;
    await vi.advanceTimersByTimeAsync(8000);
    expect(at.slice(7)).toEqual([46_000, 47_000, 48_000]);
  });

  test("leave a Downloads presence to the background's alarm, and keep a folder's fresh", async () => {
    const downloads = fakeTransport("downloads");
    await downloads.watch.watch(IDENTITY);
    await vi.advanceTimersByTimeAsync(PRESENCE_TTL_MS);
    expect(downloads.transport.announce).not.toHaveBeenCalled();
    const folder = fakeTransport("folder");
    await folder.watch.watch(IDENTITY);
    expect(folder.transport.announce).toHaveBeenCalledTimes(1);
  });

  test("stop after the read in flight, then clean through the transport", async () => {
    const { transport, watch, holdNextLook } = fakeTransport();
    await watch.watch(IDENTITY);
    const release = holdNextLook();
    await vi.advanceTimersByTimeAsync(1000);
    const stopping = watch.stop();
    await vi.advanceTimersByTimeAsync(0);
    expect(transport.clean).not.toHaveBeenCalled();
    release();
    await stopping;
    expect(transport.clean).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(transport.look).toHaveBeenCalledTimes(2);
  });
});
