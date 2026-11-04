import * as v from "valibot";
import {
  CLOCK_SKEW_MS,
  fileUrlFor,
  presencePath,
  readTolerantOf,
  registryPath,
  signalPath,
} from "@/p2p/downloads-rendezvous";
import type { Freshness } from "@/p2p/downloads-rendezvous";
import { PRESENCE_TTL_MS, StampedSignalSchema } from "@/p2p/folder-rendezvous";
import type { Presence, Sighting, SignalFile, StampedSignal } from "@/p2p/folder-rendezvous";
import { MAX_CODE_LENGTH } from "@/p2p/protocol";
import { RegistrationSchema, readRegistry } from "@/p2p/registry";
import type { Registry, RegistryPeer } from "@/p2p/registry";
import { createSightingFilter, createSignalStamp } from "@/p2p/rendezvous-transport";
import type { RendezvousTransport } from "@/p2p/rendezvous-transport";

/*
 * The Downloads rendezvous (POC PLAN.md §5 and decision 11): each profile writes its files
 * through chrome.downloads under its own folder, and reads the others' through file:// from the
 * Downloads root Chrome reported, for the peers the launcher's catalog lists.
 */

type Registration = v.InferOutput<typeof RegistrationSchema>;
type Kind = StampedSignal["kind"];

/** Where this profile's files go, as the background knows it. */
export interface DownloadsContext {
  namespace: string;
  /** The absolute Downloads root, once Chrome reported it. */
  root: string | null;
}

/** Chrome's Downloads, as the transport writes through it. */
export interface DownloadsWriter {
  /** Writes `text` at `path` under the Downloads root, replacing it, and returns the item's id. */
  write: (path: string, text: string) => Promise<number>;
  /** Removes the file and the history entry of an item this profile wrote. */
  erase: (id: number) => Promise<void>;
}

export interface DownloadsTransportOptions {
  me: string;
  context: () => Promise<DownloadsContext>;
  /** The boot each write is stamped with, asked each time, since the launcher's token may replace it. */
  boot: () => Promise<string>;
  writer: DownloadsWriter;
  /** The text of a file:// URL, or undefined when it cannot be read. */
  read: (url: string) => Promise<string | undefined>;
  now?: () => number;
}

interface Located {
  namespace: string;
  root: string;
}

/** One look's reads: who reads, under which root, with what, and when. */
interface Reading {
  me: string;
  at: Located;
  read: DownloadsTransportOptions["read"];
  now: number;
}

/**
 * A registration counts in its owner's folder and namespace only, with catalog.sh's bounds: the
 * schema caps its lifetime at the TTL, and it may be stamped up to one clock skew ahead.
 */
const registrationOf = (owner: string, namespace: string): Freshness<Registration> => ({
  schema: v.pipe(
    RegistrationSchema,
    v.check((each) => each.profileId === owner && each.namespace === namespace),
  ),
  createdAt: (each) => each.createdAt,
  expiresAt: (each) => each.expiresAt,
  horizon: PRESENCE_TTL_MS + CLOCK_SKEW_MS,
});

const readAt = ({ at, read }: Reading, path: string) => read(fileUrlFor(`${at.root}/${path}`));

function parseSignal(text: string | undefined): StampedSignal | undefined {
  if (text === undefined || text.length > MAX_CODE_LENGTH) return undefined;
  try {
    const parsed = v.safeParse(StampedSignalSchema, JSON.parse(text));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** The one signal of `kind` that `owner` left for this profile, if it is current. */
async function signalOf(reading: Reading, owner: string, kind: Kind): Promise<StampedSignal[]> {
  const { me, at, now } = reading;
  const signal = parseSignal(await readAt(reading, signalPath(at.namespace, owner, kind, me)));
  const fits = signal?.kind === kind && signal.profileId === owner && signal.to === me;
  return fits && signal.expiresAt > now ? [signal] : [];
}

/** Each peer's presence: the last valid one stands until its TTL while its file is replaced. */
function createPresenceReader() {
  const kept = new Map<string, Registration>();
  return async (reading: Reading, owner: string) => {
    const { at, now } = reading;
    const text = await readAt(reading, presencePath(at.namespace, owner));
    const kind = registrationOf(owner, at.namespace);
    const { publication } = readTolerantOf(kind, text, kept.get(owner), now);
    if (publication) kept.set(owner, publication);
    else kept.delete(owner);
    return publication;
  };
}

/** The catalog the launcher writes: the last valid one stands until its TTL. */
function createCatalogReader() {
  let registry: Registry | undefined;
  return async (reading: Reading) => {
    const text = await readAt(reading, registryPath(reading.at.namespace));
    registry = readRegistry(text, registry, reading.now).publication;
    return registry;
  };
}

/** The other peers the catalog lists now. */
const listed = (registry: Registry | undefined, { me, now }: Reading): RegistryPeer[] =>
  Object.values(registry?.peers ?? {}).filter(
    (peer) => peer.profileId !== me && peer.expiresAt > now,
  );

/** The listed peers this profile can read: under its own root, once the catalog lists it. */
function readable(registry: Registry | undefined, reading: Reading): RegistryPeer[] {
  const mine = registry?.peers[reading.me];
  return listed(registry, reading).filter((peer) => !mine || peer.root === mine.root);
}

/** What the others left for this profile, read peer by peer as the catalog lists them. */
function createDownloadsReads() {
  const sift = createSightingFilter();
  const presenceOf = createPresenceReader();
  const catalog = createCatalogReader();
  const sightingOf = async (reading: Reading, owner: string): Promise<Sighting> => {
    const [presence, offers, answers] = await Promise.all([
      presenceOf(reading, owner),
      signalOf(reading, owner, "offer"),
      signalOf(reading, owner, "answer"),
    ]);
    return { presences: presence ? [presence] : [], signals: [...offers, ...answers] };
  };
  return {
    look: async (reading: Reading) => {
      const peers = readable(await catalog(reading), reading);
      const sightings = await Promise.all(peers.map((peer) => sightingOf(reading, peer.profileId)));
      return sift({
        presences: sightings.flatMap((each) => each.presences),
        signals: sightings.flatMap((each) => each.signals),
      });
    },
    discover: async (reading: Reading) => listed(await catalog(reading), reading),
  };
}

/** This profile's writes, each into its own folder; it erases only the items it wrote. */
function createDownloadsWrites({ me, context, boot, writer, now }: DownloadsTransportOptions) {
  const stamp = createSignalStamp(now);
  const written: number[] = [];
  const write = async (path: string, text: string) => {
    written.push(await writer.write(path, text));
  };
  return {
    announce: async (presence: Presence) => {
      const { namespace } = await context();
      // Through the schema, so the keys follow the order catalog.sh parses and a path is refused.
      const registration = v.parse(RegistrationSchema, {
        ...presence,
        namespace,
        boot: await boot(),
      });
      await write(presencePath(namespace, me), JSON.stringify(registration));
    },
    publish: async (signal: SignalFile) => {
      const { namespace } = await context();
      const stamped = v.parse(StampedSignalSchema, stamp(signal, await boot()));
      await write(signalPath(namespace, me, signal.kind, signal.to), JSON.stringify(stamped));
    },
    clean: async () => {
      // Newest first; one that fails leaves the others to be erased.
      for (const id of written.splice(0).toReversed()) await writer.erase(id).catch(() => {});
    },
  };
}

/** The rendezvous through Downloads, by relative paths under this profile's own folder. */
export function downloadsTransport(options: DownloadsTransportOptions): RendezvousTransport {
  const { me, context, read, now = Date.now } = options;
  const reads = createDownloadsReads();
  const reading = async (): Promise<Reading> => {
    const { namespace, root } = await context();
    if (root === null) throw new Error("The Downloads root is not known yet.");
    return { me, at: { namespace, root }, read, now: now() };
  };
  return {
    kind: "downloads",
    available: async () => (await context()).root !== null,
    ...createDownloadsWrites({ ...options, now }),
    look: async () => reads.look(await reading()),
    discover: async () => reads.discover(await reading()),
  };
}
