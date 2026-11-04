import type { RendezvousTransport } from "@/p2p/rendezvous-transport";

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

/** Every transport the contract suite runs against. */
export const environments: RendezvousEnvironment[] = [];
