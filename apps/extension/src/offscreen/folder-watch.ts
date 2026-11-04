import type { LinkEvent } from "@/messaging/peer-messages";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence, SignalFile } from "@/p2p/folder-rendezvous";
import { folderTransport, loadFolder } from "@/p2p/folder-store";
import type { RendezvousTransport } from "@/p2p/rendezvous-transport";

const POLL_MS = 1000;
/** An unchanged sighting goes again this often, in case the service worker missed it asleep. */
const REPEAT_MS = 10_000;

type FolderEvent = Extract<LinkEvent, { type: "folder" }>;

interface WatchOptions {
  report: (event: FolderEvent) => void;
  /** This profile's certificate fingerprint, which its presence announces. */
  fingerprint: string;
  folder?: () => Promise<FileSystemDirectoryHandle | undefined>;
}

/**
 * Polls the RECnRun folder while this profile waits to pair, so no page has to stay open: it
 * keeps this profile's presence fresh and reports what the others left. The background decides.
 */
export function createFolderWatch({ report, fingerprint, folder = loadFolder }: WatchOptions) {
  let me: Presence | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let last = { key: "", at: 0 };
  // One boot per document, so a document made again stamps its files apart from this one's.
  const boot = crypto.randomUUID();
  let held: { me: string; transport: RendezvousTransport } | undefined;
  // Kept per profile, so its stamps keep growing and its filter remembers what it saw.
  const rendezvous = (me: string) => {
    if (held?.me !== me) held = { me, transport: folderTransport({ me, boot, load: folder }) };
    return held.transport;
  };
  const look = async (presence: Presence) => {
    const at = rendezvous(presence.profileId);
    if (presence.expiresAt - Date.now() < PRESENCE_TTL_MS / 2) {
      me = { ...presence, expiresAt: Date.now() + PRESENCE_TTL_MS };
      await at.announce(me);
    }
    const seen = await at.look();
    const key = JSON.stringify(seen);
    if (key === last.key && Date.now() - last.at < REPEAT_MS) return;
    last = { key, at: Date.now() };
    report({ type: "folder", ...seen });
  };
  const watch = async ({ profileId, displayName }: Pick<Presence, "profileId" | "displayName">) => {
    const createdAt = me?.profileId === profileId ? me.createdAt : Date.now();
    me = { profileId, displayName, fingerprint, createdAt, expiresAt: 0 };
    last = { key: "", at: 0 };
    await look(me);
    // A failed read, as while Chrome asks for the folder again, waits for the next poll.
    timer ??= setInterval(() => void (me && look(me).catch(() => {})), POLL_MS);
  };
  const publish = (signal: SignalFile) => rendezvous(signal.profileId).publish(signal);
  /** Stops waiting, and leaves nothing of this profile's behind in the folder. */
  const stop = async () => {
    clearInterval(timer);
    timer = undefined;
    const stopped = me;
    me = undefined;
    if (stopped) await rendezvous(stopped.profileId).clean();
  };
  return { watch, publish, stop };
}

export type FolderWatch = ReturnType<typeof createFolderWatch>;
