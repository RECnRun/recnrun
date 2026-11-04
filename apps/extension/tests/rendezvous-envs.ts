import { folderTransport } from "@/p2p/folder-store";
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

/** Every transport the contract suite runs against. */
export const environments: RendezvousEnvironment[] = [{ kind: "folder", create: folderEnv }];
