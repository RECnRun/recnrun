import { CLOCK_SKEW_MS } from "@/p2p/downloads-rendezvous";
import type { Presence, Seen, Sighting, SignalFile, StampedSignal } from "@/p2p/folder-rendezvous";
import { PAIRING_TTL_MS } from "@/p2p/pairing-code";
import type { RegistryPeer } from "@/p2p/registry";

/*
 * How this profile meets the others (POC PLAN.md P3.1): the folder the user chose, or the POC
 * builds' Downloads. The mesh talks to this interface only, so either carries the same pairing.
 */

export interface RendezvousTransport {
  readonly kind: "folder" | "downloads";
  /** Whether it can work now: the folder granted, or the Downloads root learned. */
  available(): Promise<boolean>;
  /** Writes this profile's presence, stamped with its boot. */
  announce(presence: Presence): Promise<void>;
  /** Writes a signal for the one profile it names, stamped with this boot and the next sequence. */
  publish(signal: SignalFile): Promise<void>;
  /** The others' current presences, and the signals they left for this profile. */
  look(): Promise<Seen>;
  /** The peers the launcher's catalog lists, this profile excluded; the folder has no catalog. */
  discover(): Promise<RegistryPeer[]>;
  /** Removes this profile's own files, and never another's. */
  clean(): Promise<void>;
}

/**
 * Stamps each signal with the boot and a sequence above the last one and no lower than the
 * clock, so a document made again in the same boot still writes higher numbers. Once the clock
 * stepped back further than a reader takes, the stamp restarts at it, which readers accept.
 */
export function createSignalStamp(now: () => number = Date.now) {
  let last = 0;
  return (signal: SignalFile, boot: string): StampedSignal => {
    last = last + 1 > now() + CLOCK_SKEW_MS ? now() : Math.max(last + 1, now());
    return { ...signal, boot, sequence: last };
  };
}

// Field by field, so the mesh's strict schemas never meet a transport's extra keys.
const unstamped = ({ kind, pairingId, profileId, to, expiresAt, code }: StampedSignal) =>
  ({ kind, pairingId, profileId, to, expiresAt, code }) satisfies SignalFile;

const unbooted = (presence: Presence): Presence => {
  const { profileId, displayName, fingerprint, identity, createdAt, expiresAt } = presence;
  return { profileId, displayName, fingerprint, identity, createdAt, expiresAt };
};

/**
 * Sifts what a transport read into what the mesh sees. A signal counts only in its sender's
 * current boot, the one its latest presence named, and only if no later signal of that boot
 * already replaced its file: Downloads may finish an older write after a newer one. A stamp or
 * expiry further ahead than an honest writer's clock could put it never counts, so a forged file
 * can neither outlive the pairing nor hold back that writer's later signals.
 */
export function createSightingFilter(now: () => number = Date.now) {
  const boots = new Map<string, string>();
  const highest = new Map<string, { boot: string; sequence: number }>();
  const plausible = ({ sequence, expiresAt }: StampedSignal) =>
    sequence <= now() + CLOCK_SKEW_MS && expiresAt <= now() + PAIRING_TTL_MS + CLOCK_SKEW_MS;
  const current = (signal: StampedSignal) => {
    const boot = boots.get(signal.profileId);
    if (boot !== undefined && boot !== signal.boot) return false;
    if (!plausible(signal)) return false;
    // Each sender writes one file of each kind for this profile, so the order is per file.
    const file = `${signal.profileId}/${signal.kind}`;
    const seen = highest.get(file);
    // An order now ahead of the clock only a backward clock step leaves, and the writer restarts.
    const holds = seen !== undefined && seen.sequence < now() + CLOCK_SKEW_MS;
    if (holds && seen.boot === signal.boot && signal.sequence < seen.sequence) return false;
    highest.set(file, { boot: signal.boot, sequence: signal.sequence });
    return true;
  };
  return ({ presences, signals }: Sighting): Seen => {
    for (const { profileId, boot } of presences) boots.set(profileId, boot);
    return { presences: presences.map(unbooted), signals: signals.filter(current).map(unstamped) };
  };
}
