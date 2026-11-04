import type { LinkEvent } from "@/messaging/peer-messages";
import { PRESENCE_TTL_MS } from "@/p2p/folder-rendezvous";
import type { Presence, SignalFile } from "@/p2p/folder-rendezvous";
import type { RendezvousTransport } from "@/p2p/rendezvous-transport";

const POLL_MS = 1000;
/** An unchanged sighting goes again this often, in case the service worker missed it asleep. */
const REPEAT_MS = 10_000;

type FolderEvent = Extract<LinkEvent, { type: "folder" }>;

interface WatchOptions {
  report: (event: FolderEvent) => void;
  /** This profile's certificate fingerprint, which its presence announces. */
  fingerprint: string;
  /** The transport of one profile, made once for it, so its stamps and its filter carry over. */
  transport: (profileId: string) => RendezvousTransport;
}

/** The longest a failing rendezvous waits between polls. */
const MAX_BACKOFF_MS = 10_000;

/** After `failures` failed polls in a row: one poll period, doubling to the cap. */
const delayAfter = (failures: number) =>
  failures === 0 ? POLL_MS : Math.min(POLL_MS * 2 ** (failures - 1), MAX_BACKOFF_MS);

/** The transport of the latest profile, made again only when the profile changes. */
function heldPerProfile(transport: (profileId: string) => RendezvousTransport) {
  let held: { me: string; transport: RendezvousTransport } | undefined;
  return (profileId: string) => {
    if (held?.me !== profileId) held = { me: profileId, transport: transport(profileId) };
    return held.transport;
  };
}

/** Runs each piece of work after the previous one settles. */
function serialQueue() {
  let queue: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const run = queue.then(work);
    queue = run.catch(() => {});
    return run;
  };
}

/**
 * Polls the rendezvous while this profile waits to pair, so no page has to stay open: it keeps
 * a folder presence fresh and reports what the others left. One poll at a time, each scheduled
 * after the last, so a slow read never overlaps the next. The background decides.
 */
export function createRendezvousWatch({ report, fingerprint, transport }: WatchOptions) {
  let me: Presence | undefined;
  let last = { key: "", at: 0 };
  let chain: { timer?: ReturnType<typeof setTimeout>; failures: number } | undefined;
  const rendezvous = heldPerProfile(transport);
  const serially = serialQueue();
  const look = async (presence: Presence) => {
    const at = rendezvous(presence.profileId);
    // The background's alarm renews a Downloads presence, in the bytes the catalog parses.
    if (at.kind === "folder" && presence.expiresAt - Date.now() < PRESENCE_TTL_MS / 2) {
      me = { ...presence, expiresAt: Date.now() + PRESENCE_TTL_MS };
      await at.announce(me);
    }
    const seen = await at.look();
    const key = JSON.stringify(seen);
    if (key === last.key && Date.now() - last.at < REPEAT_MS) return;
    last = { key, at: Date.now() };
    report({ type: "folder", ...seen });
  };
  /** The next poll of this chain; a stop or a new chain ends it. */
  const next = (current: NonNullable<typeof chain>) => {
    current.timer = setTimeout(() => {
      if (chain !== current || !me) return;
      // A failed read, as while Chrome asks for the folder again, waits for the next poll.
      void serially(() => (me ? look(me) : Promise.resolve()))
        .then(
          () => (current.failures = 0),
          () => (current.failures += 1),
        )
        .then(() => chain === current && next(current));
    }, delayAfter(current.failures));
  };
  const watch = async ({ profileId, displayName }: Pick<Presence, "profileId" | "displayName">) => {
    const createdAt = me?.profileId === profileId ? me.createdAt : Date.now();
    me = { profileId, displayName, fingerprint, createdAt, expiresAt: 0 };
    last = { key: "", at: 0 };
    const presence = me;
    await serially(() => look(presence));
    if (!chain) next((chain = { failures: 0 }));
  };
  const publish = (signal: SignalFile) => rendezvous(signal.profileId).publish(signal);
  /** Stops waiting once the read in flight ends, and leaves nothing of this profile's behind. */
  const stop = async () => {
    clearTimeout(chain?.timer);
    chain = undefined;
    const stopped = me;
    me = undefined;
    if (stopped) await serially(() => rendezvous(stopped.profileId).clean());
  };
  return { watch, publish, stop };
}

export type RendezvousWatch = ReturnType<typeof createRendezvousWatch>;
