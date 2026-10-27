import { errorMessage } from "@recnrun/domain";
import type { PairingFlow } from "@/background/pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import { signalFileOf } from "@/p2p/folder-rendezvous";
import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import { decodePairing, fingerprintOf } from "@/p2p/pairing-code";
import type {
  FolderActed,
  FolderPairing,
  PeerLink,
  PeerRecords,
  PendingOffer,
  ProfileIdentity,
  Repository,
} from "@/storage/peer-repository";

/** How long a link gets to come up after the offerer connected, before it offers again. */
const RETRY_MS = 30_000;

export type FolderStep =
  | { type: "offer"; to: Presence }
  | { type: "answer"; offer: SignalFile }
  | { type: "connect"; answer: SignalFile };

interface Situation {
  me: string;
  seen: Seen;
  /** Profiles to leave alone: linked already, or paused by the user. */
  skip: string[];
  /** This profile's offers waiting for an answer, by the profile each is for. */
  pending: Record<string, PendingOffer>;
  acted: Record<string, FolderActed>;
  now: number;
}

/** A signal counts when its code says what its file does and announces the partner's certificate. */
function vouched(signal: SignalFile, partner: Presence, now: number): boolean {
  try {
    const { kind, pairingId, profileId, sdp } = decodePairing(signal.code, now);
    const same = kind === signal.kind && pairingId === signal.pairingId;
    const from = profileId === partner.profileId && signal.profileId === partner.profileId;
    return same && from && fingerprintOf(sdp) === partner.fingerprint;
  } catch {
    return false;
  }
}

function offererStep(partner: Presence, signals: SignalFile[], situation: Situation) {
  const { now } = situation;
  const acted = situation.acted[partner.profileId];
  const pending = situation.pending[partner.profileId];
  if (acted && now - acted.at < RETRY_MS) return undefined;
  if (!pending || pending.expiresAt <= now) return { type: "offer", to: partner } as const;
  const answer = signals.find(
    (each) => each.kind === "answer" && each.pairingId === pending.pairingId,
  );
  return answer && ({ type: "connect", answer } as const);
}

/** The next step with one partner, if there is one now. */
function stepWith(partner: Presence, situation: Situation): FolderStep | undefined {
  const { me, seen, now } = situation;
  const signals = seen.signals.filter((each) => vouched(each, partner, now));
  if (me < partner.profileId) return offererStep(partner, signals, situation);
  const acted = situation.acted[partner.profileId];
  const offer = signals.find(
    (each) => each.kind === "offer" && each.pairingId !== acted?.pairingId,
  );
  return offer && { type: "answer", offer };
}

/**
 * What this profile does next with each profile in the folder: of each pair, the lower profile id
 * offers and connects with the answer; the other answers each new offer at once, since the
 * offerer makes one only when it gave up the last. Nobody clicks, since the folder is the consent.
 */
export function decideFolderSteps(situation: Situation): FolderStep[] {
  return situation.seen.presences
    .filter(({ profileId }) => !situation.skip.includes(profileId))
    .flatMap((partner) => stepWith(partner, situation) ?? []);
}

export interface FolderPairingDependencies {
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  pairing: Pick<PairingFlow, "createOffer" | "accept">;
  pending: Pick<PeerRecords<PendingOffer>, "all">;
  link: Pick<PeerRecords<PeerLink>, "all">;
  acted: Pick<PeerRecords<FolderActed>, "all" | "get" | "set">;
  state: Pick<Repository<FolderPairing>, "read" | "write">;
  log: (entry: string) => void;
  now?: () => number;
}

/** Carries out one step: offers and answers go into the folder, and connecting needs nothing there. */
async function act(deps: FolderPairingDependencies, step: FolderStep, now: () => number) {
  const publish = (code: string, to: string) =>
    deps.askLink({ type: "folder-publish", signal: signalFileOf(code, to, now()) });
  const acted = ({ profileId, pairingId }: SignalFile) =>
    deps.acted.set(profileId, { pairingId, at: now() });
  if (step.type === "offer") {
    const { code } = await deps.pairing.createOffer(step.to.profileId);
    await publish(code, step.to.profileId);
  } else if (step.type === "answer") {
    const { code } = await deps.pairing.accept(step.offer.code);
    await acted(step.offer);
    if (code) await publish(code, step.offer.profileId);
  } else {
    await deps.pairing.accept(step.answer.code);
    await acted(step.answer);
  }
}

/**
 * The profiles the user disconnected or forgot, which the folder leaves alone until unpaused.
 * Unpausing looks again at once: the sighting it skipped repeats only every few seconds.
 */
function folderPauses(state: FolderPairingDependencies["state"], lookAgain: () => Promise<void>) {
  const edit = async (change: (paused: string[]) => string[]) => {
    const current = await state.read();
    // Not waiting, there is nothing to pause; starting again keeps the pauses.
    if (current) await state.write({ ...current, paused: change(current.paused ?? []) });
  };
  return {
    paused: async () => (await state.read())?.paused ?? [],
    pause: (peer: string) => edit((ids) => [...ids.filter((id) => id !== peer), peer]),
    unpause: (peer: string) => edit((ids) => ids.filter((id) => id !== peer)).then(lookAgain),
    unpauseAll: () => edit(() => []).then(lookAgain),
  };
}

/** Pairing through the RECnRun folder: the offscreen document watches, and this decides. */
export function createFolderPairing(deps: FolderPairingDependencies) {
  const now = deps.now ?? Date.now;
  let queue = Promise.resolve();
  const watch = async () => {
    const { profileId, displayName } = await deps.identity();
    await deps.askLink({ type: "folder-watch", profileId, displayName });
  };
  const resume = async () => {
    if (await deps.state.read()) await watch();
  };
  const failed = (error: unknown) => deps.log(`folder pairing: ${errorMessage(error)}`);
  const handle = async (seen: Seen) => {
    const state = await deps.state.read();
    if (!state) return;
    const [me, links, pending, acted] = await Promise.all([
      deps.identity(),
      deps.link.all(),
      deps.pending.all(),
      deps.acted.all(),
    ]);
    // A verified link needs nothing; the presence stays, so the peer finds this one again.
    const linked = Object.keys(links).filter((peer) => links[peer]?.verified);
    const skip = [...linked, ...(state.paused ?? [])];
    const steps = decideFolderSteps({ me: me.profileId, seen, skip, pending, acted, now: now() });
    // One step at a time, so two never offer at once; one that fails leaves the others theirs.
    await steps.reduce(
      (done, step) => done.then(() => act(deps, step, now).catch(failed)),
      Promise.resolve(),
    );
  };
  return {
    ...folderPauses(deps.state, resume),
    /** Waits in the folder for another profile, and stays to reconnect once paired. */
    start: async () => {
      await deps.state.write((await deps.state.read()) ?? {});
      await watch();
    },
    /** Waits again after the service worker or the browser restarted, if it waited before. */
    resume,
    /** The link to `peer` came up, so the attempt it waited for is over: a later drop needs no wait. */
    linked: async (peer: string) => {
      const acted = await deps.acted.get(peer);
      // The pairing id stays, so an offer already answered is not answered again.
      if (acted) await deps.acted.set(peer, { ...acted, at: 0 });
    },
    /** One sighting at a time, so two in a row never both offer. */
    seen: (seen: Seen) => {
      queue = queue.then(() => handle(seen)).catch(failed);
      return queue;
    },
  };
}

export type FolderPairingFlow = ReturnType<typeof createFolderPairing>;
