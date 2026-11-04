import { afterEach, beforeEach, describe, expect, test, vi } from "vite-plus/test";
import { registryPath } from "@/p2p/downloads-rendezvous";
import { downloadsTransport } from "@/p2p/downloads-transport";
import type { DownloadsContext } from "@/p2p/downloads-transport";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence } from "@/p2p/folder-rendezvous";
import { PAIRING_TTL_MS } from "@/p2p/pairing-code";
import { FINGERPRINT, ME, PEER, PEER_STATEMENT, STRANGER } from "./fake-peer";
import { DOWNLOADS_ROOT, NAMESPACE, catalogOf, downloadsDisk } from "./rendezvous-envs";

const NOW = 1_700_000_000_000;
const BOOT = "99999999-9999-4999-8999-999999999999";
const PAIRING = "44444444-4444-4444-8444-444444444444";
const FOLDER = `RECnRun/poc/lab/peers/${ME}`;

const presence = (profileId: string): Presence => ({
  profileId,
  displayName: "Laptop",
  fingerprint: FINGERPRINT,
  // The transport carries the statement; the folder pairing verifies it.
  identity: PEER_STATEMENT,
  createdAt: Date.now(),
  expiresAt: Date.now() + PRESENCE_TTL_MS,
});

const offer = {
  kind: "offer" as const,
  pairingId: PAIRING,
  profileId: ME,
  to: PEER,
  expiresAt: NOW + PAIRING_TTL_MS,
  code: "RECNRUN-PAIR-1.code",
};

/** A Downloads root shared by profiles, and a transport over it for `me`. */
function shared(root: string | null = DOWNLOADS_ROOT) {
  const disk = downloadsDisk();
  const context = vi.fn(async (): Promise<DownloadsContext> => ({ namespace: NAMESPACE, root }));
  const boot = async () => BOOT;
  const read = vi.fn(disk.read);
  const transport = (me = ME) =>
    downloadsTransport({ me, context, boot, writer: disk.writer, read });
  const sync = () => disk.files.set(registryPath(NAMESPACE), JSON.stringify(catalogOf(disk.files)));
  return { disk, read, transport, sync };
}

beforeEach(() => {
  vi.useFakeTimers({ now: NOW });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("downloadsTransport", () => {
  test("is available once the Downloads root is known, and reads only then", async () => {
    const { disk, transport } = shared(null);
    const mine = transport();
    expect(mine.kind).toBe("downloads");
    expect(await mine.available()).toBe(false);
    await expect(mine.look()).rejects.toThrow("The Downloads root is not known yet.");
    await expect(mine.discover()).rejects.toThrow("The Downloads root is not known yet.");
    // Writing needs no root: the first presence is how Chrome reports it.
    await mine.announce(presence(ME));
    expect([...disk.files.keys()]).toEqual([`${FOLDER}/presence.json`]);
    expect(await shared().transport().available()).toBe(true);
  });

  test("writes by relative path into this profile's folder, the presence as the catalog parses it", async () => {
    const { disk, transport } = shared();
    const mine = transport();
    await mine.announce(presence(ME));
    await mine.publish(offer);
    expect(disk.files.get(`${FOLDER}/presence.json`)).toBe(
      `{"profileId":"${ME}","displayName":"Laptop","fingerprint":"${FINGERPRINT}",` +
        `"identity":${JSON.stringify(PEER_STATEMENT)},"createdAt":${NOW},"expiresAt":${NOW + PRESENCE_TTL_MS},"namespace":"lab","boot":"${BOOT}"}`,
    );
    expect(JSON.parse(disk.files.get(`${FOLDER}/offer-${PEER}.json`) ?? "")).toEqual({
      ...offer,
      boot: BOOT,
      sequence: NOW,
    });
  });

  test("refuses a presence the registration schema refuses, and writes nothing", async () => {
    const { disk, transport } = shared();
    const leaky = { ...presence(ME), path: "/home/me/Downloads" } as Presence;
    await expect(transport().announce(leaky)).rejects.toThrow();
    expect(disk.files.size).toBe(0);
  });

  test("discovers the catalog's other current peers, and keeps the catalog while it is replaced", async () => {
    const { disk, transport, sync } = shared();
    await transport(ME).announce(presence(ME));
    await transport(PEER).announce(presence(PEER));
    sync();
    const mine = transport();
    expect((await mine.discover()).map((peer) => peer.profileId)).toEqual([PEER]);
    disk.files.set(registryPath(NAMESPACE), "");
    expect((await mine.discover()).map((peer) => peer.profileId)).toEqual([PEER]);
    vi.advanceTimersByTime(PRESENCE_TTL_MS);
    expect(await mine.discover()).toEqual([]);
  });

  test("reads only the listed peers under its own root, never another root's", async () => {
    const { disk, read, transport } = shared();
    for (const id of [ME, PEER, STRANGER]) await transport(id).announce(presence(id));
    const catalog = catalogOf(disk.files);
    const stranger = catalog.peers[STRANGER];
    if (stranger) catalog.peers[STRANGER] = { ...stranger, root: "r2" };
    disk.files.set(registryPath(NAMESPACE), JSON.stringify(catalog));
    expect((await transport().look()).presences.map((each) => each.profileId)).toEqual([PEER]);
    expect(read.mock.calls.some(([url]) => url.includes(STRANGER))).toBe(false);
    expect(read.mock.calls[0]?.[0]).toBe(`file://${DOWNLOADS_ROOT}/RECnRun/poc/lab/registry.json`);
  });

  test("counts a presence only in its owner's folder", async () => {
    const { disk, transport, sync } = shared();
    await transport(PEER).announce(presence(PEER));
    sync();
    const peerFile = `RECnRun/poc/lab/peers/${PEER}/presence.json`;
    disk.files.set(peerFile, (disk.files.get(peerFile) ?? "").replaceAll(PEER, STRANGER));
    expect((await transport().look()).presences).toEqual([]);
  });

  test("erases only the items this instance wrote, newest first, past one that fails", async () => {
    const { disk, transport } = shared();
    const first = transport();
    await first.announce(presence(ME));
    await first.publish(offer);
    await transport().clean();
    expect(disk.files.size).toBe(2);
    const erased: number[] = [];
    const erase = disk.writer.erase;
    disk.writer.erase = async (id) => {
      erased.push(id);
      if (id === 2) throw new Error("Busy.");
      await erase(id);
    };
    await first.clean();
    expect(erased).toEqual([2, 1]);
    expect([...disk.files.keys()]).toEqual([`${FOLDER}/offer-${PEER}.json`]);
  });
});
