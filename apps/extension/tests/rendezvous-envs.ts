import * as v from "valibot";
import { fileUrlFor, registryPath } from "@/p2p/downloads-rendezvous";
import { downloadsTransport } from "@/p2p/downloads-transport";
import type { DownloadsWriter } from "@/p2p/downloads-transport";
import { folderTransport } from "@/p2p/folder-store";
import { RegistrationSchema } from "@/p2p/registry";
import type { Registry } from "@/p2p/registry";
import type { RendezvousTransport } from "@/p2p/rendezvous-transport";
import { MemoryDirectory } from "./memory-directory";

/** One shared rendezvous as the contract suite drives it, whatever carries it. */
export interface RendezvousEnv {
  /** A new transport for `me` over the shared root, in that profile's current boot. */
  transport(me: string): RendezvousTransport;
  /** The boot `me` stamps its files with. */
  boot(me: string): string;
  /** What the launcher does between passes; the folder has no launcher. */
  sync(): Promise<void>;
  /** Writes a file into `owner`'s folder, as another writer would. */
  drop(owner: string, name: string, content: string): void;
  /** A file of `owner`'s folder, if it is there. */
  file(owner: string, name: string): string | undefined;
  /** The file names in `owner`'s folder. */
  names(owner: string): string[];
}

export interface RendezvousEnvironment {
  kind: RendezvousTransport["kind"];
  create: () => RendezvousEnv;
}

/** One boot per profile and environment, as one browser session keeps it. */
function bootsOf() {
  const boots = new Map<string, string>();
  return (me: string) => {
    const boot = boots.get(me) ?? crypto.randomUUID();
    boots.set(me, boot);
    return boot;
  };
}

/** The folder every profile chose, in memory. */
function folderEnv(): RendezvousEnv {
  const chosen = new MemoryDirectory();
  const boot = bootsOf();
  const own = (owner: string) => chosen.folder("pairing", owner);
  const load = async () => chosen as unknown as FileSystemDirectoryHandle;
  return {
    transport: (me) => folderTransport({ me, boot: boot(me), load }),
    boot,
    sync: async () => {},
    drop: (owner, name, content) => own(owner).drop(name, content),
    file: (owner, name) => own(owner).files.get(name),
    names: (owner) => [...own(owner).files.keys()],
  };
}

export const DOWNLOADS_ROOT = "/home/lab/Downloads";
export const NAMESPACE = "lab";
const LAUNCHER_BOOT = "88888888-8888-4888-8888-888888888888";
const PRESENCE_PATH = /^RECnRun\/poc\/lab\/peers\/([0-9a-f-]{36})\/presence\.json$/;

/** One Downloads root on disk, and Chrome's items over it, which remove the file they wrote. */
export function downloadsDisk(root = DOWNLOADS_ROOT) {
  const files = new Map<string, string>();
  const items = new Map<number, string>();
  let next = 0;
  const writer: DownloadsWriter = {
    write: async (path, text) => {
      files.set(path, text);
      items.set(++next, path);
      return next;
    },
    erase: async (id) => {
      const path = items.get(id);
      if (path !== undefined) files.delete(path);
      items.delete(id);
    },
  };
  const read = async (url: string) =>
    [...files].find(([path]) => fileUrlFor(`${root}/${path}`) === url)?.[1];
  return { files, items, writer, read };
}

/** What catalog.sh writes from the presences it finds, every peer under one root. */
export function catalogOf(files: Map<string, string>, root = "r1"): Registry {
  const peers: Registry["peers"] = {};
  for (const [path, text] of files) {
    const parsed = PRESENCE_PATH.test(path) && v.safeParse(RegistrationSchema, JSON.parse(text));
    if (!parsed || !parsed.success) continue;
    const { profileId, displayName, fingerprint, expiresAt, boot } = parsed.output;
    const lastSeenAt = Date.now();
    peers[profileId] = { profileId, displayName, fingerprint, root, lastSeenAt, expiresAt, boot };
  }
  const launcher = { boot: LAUNCHER_BOOT };
  const roots = { [root]: DOWNLOADS_ROOT };
  return { version: 1, namespace: NAMESPACE, writtenAt: Date.now(), launcher, roots, peers };
}

/** The POC builds' Downloads, every profile under one root, and the launcher between passes. */
function downloadsEnv(): RendezvousEnv {
  const disk = downloadsDisk();
  const boot = bootsOf();
  const folder = (owner: string) => `RECnRun/poc/${NAMESPACE}/peers/${owner}/`;
  return {
    transport: (me) =>
      downloadsTransport({
        me,
        context: async () => ({ namespace: NAMESPACE, root: DOWNLOADS_ROOT }),
        boot: async () => boot(me),
        writer: disk.writer,
        read: disk.read,
      }),
    boot,
    sync: async () => {
      disk.files.set(registryPath(NAMESPACE), JSON.stringify(catalogOf(disk.files)));
    },
    drop: (owner, name, content) => disk.files.set(folder(owner) + name, content),
    file: (owner, name) => disk.files.get(folder(owner) + name),
    names: (owner) =>
      [...disk.files.keys()]
        .filter((path) => path.startsWith(folder(owner)))
        .map((path) => path.slice(folder(owner).length)),
  };
}

/** Every transport the contract suite runs against. */
export const environments: RendezvousEnvironment[] = [
  { kind: "folder", create: folderEnv },
  { kind: "downloads", create: downloadsEnv },
];
