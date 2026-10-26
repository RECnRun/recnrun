import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import type { LinkEvent } from "@/messaging/peer-messages";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence, SignalFile } from "@/p2p/folder-rendezvous";
import { createFolderWatch } from "@/offscreen/folder-watch";
import { ME, PEER } from "./fake-peer";
import { MemoryDirectory } from "./memory-directory";

const NOW = 1_700_000_000_000;
const PAIRING = "44444444-4444-4444-8444-444444444444";
const IDENTITY = { profileId: ME, displayName: "Laptop" };

const peerPresence: Presence = {
  profileId: PEER,
  displayName: "Desk",
  fingerprint: "AB:CD:EF",
  createdAt: NOW,
  expiresAt: NOW + 10 * PRESENCE_TTL_MS,
};

/** The offscreen document's watch over a folder in memory, its reports recorded. */
function watching(chosen: MemoryDirectory | null = new MemoryDirectory()) {
  const events: LinkEvent[] = [];
  const watch = createFolderWatch({
    report: (event) => events.push(event),
    fingerprint: "11:22",
    folder: async () => (chosen ?? undefined) as FileSystemDirectoryHandle | undefined,
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
      createdAt: NOW,
      expiresAt: NOW + PRESENCE_TTL_MS,
    });
    expect(events).toEqual([sighting()]);
    pairing(PEER).drop("presence.json", peerPresence);
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
    pairing(PEER).drop("presence.json", peerPresence);
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
    expect([...pairing(ME).files.keys()]).toEqual(["presence.json", `offer-${PAIRING}.json`]);
    await watch.stop();
    expect([...pairing(ME).files.keys()]).toEqual([]);
    pairing(PEER).drop("presence.json", peerPresence);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(events).toEqual([sighting()]);
  });

  test("stops quietly when it never watched", async () => {
    const { watch } = watching(null);
    await expect(watch.stop()).resolves.toBeUndefined();
  });
});
