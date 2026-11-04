import { errorMessage } from "@recnrun/domain";
import type { PairingFlow } from "@/background/pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import { signalFileOf } from "@/p2p/folder-rendezvous";
import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import { signerOf } from "@/p2p/identity-key";
import { PAIRING_TTL_MS, decodePairing, fingerprintOf } from "@/p2p/pairing-code";
import type { Pins } from "@/p2p/pins";
import type { AnsweredOffers } from "@/storage/answered-repository";
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
  /** The offers answered in this boot or an earlier one, which a relaunch finds on disk again. */
  answered: Record<string, AnsweredOffers>;
  now: number;
}

/** A signal counts when its code says what its file does and announces the partner's certificate. */
export function vouched(
  signal: SignalFile,
  partner: Pick<Presence, "profileId" | "fingerprint">,
  now: number,
): boolean {
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
  if (answer) return { type: "connect", answer } as const;
  // Unanswered for a retry period: the answerer may have restarted, and it answers an offer once.
  const madeAt = pending.expiresAt - PAIRING_TTL_MS;
  return now - madeAt >= RETRY_MS ? ({ type: "offer", to: partner } as const) : undefined;
}

/** The next step with one partner, if there is one now. */
function stepWith(partner: Presence, situation: Situation): FolderStep | undefined {
  const { me, seen, now } = situation;
  const signals = seen.signals.filter((each) => vouched(each, partner, now));
  if (me < partner.profileId) return offererStep(partner, signals, situation);
  const records = [
    situation.acted[partner.profileId],
    ...(situation.answered[partner.profileId] ?? []),
  ];
  // An answer of its own on disk counts too: a quit may land after it, before the record.
  const own = seen.signals.filter((each) => each.profileId === me && each.to === partner.profileId);
  const done = new Set([...records, ...own].flatMap((each) => each?.pairingId ?? []));
  const offer = signals.find((each) => each.kind === "offer" && !done.has(each.pairingId));
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
  answered: Pick<PeerRecords<AnsweredOffers>, "all" | "set">;
  state: Pick<Repository<FolderPairing>, "read" | "write">;
  /** A presence's certificate must be signed by the identity key pinned for its profile, if any. */
  pins: Pick<Pins, "verify">;
  log: (entry: string) => void;
  now?: () => number;
}

/**
 * Why this profile makes no offer to `presence`, if it does not: no valid statement names its
 * certificate, or one does but by a key other than the one pinned for its profile.
 */
async function refusal({ pins }: FolderPairingDependencies, presence: Presence) {
  const { profileId, fingerprint } = presence;
  const signer = await signerOf(presence.identity, { profileId, fingerprint });
  if (!signer) return "no valid signature names its certificate";
  if ((await pins.verify(profileId, signer)) === "pinned-mismatch")
    return "its certificate is signed by another identity than the one pinned";
  return undefined;
}

/** Remembers every offer answered from its sender, and forgets each one that expired. */
async function rememberAnswered(
  records: FolderPairingDependencies["answered"],
  { profileId, pairingId, expiresAt }: SignalFile,
  now: number,
) {
  const all = await records.all();
  const kept = (peer: string) => (all[peer] ?? []).filter((each) => each.expiresAt > now);
  for (const peer of Object.keys(all))
    if (peer !== profileId && kept(peer).length < (all[peer]?.length ?? 0))
      await records.set(peer, kept(peer).length > 0 ? kept(peer) : null);
  const same = kept(profileId).filter((each) => each.pairingId !== pairingId);
  await records.set(profileId, [...same, { pairingId, expiresAt }]);
}

/** Carries out one step: offers and answers go into the folder, and connecting needs nothing there. */
async function act(deps: FolderPairingDependencies, step: FolderStep, now: () => number) {
  const publish = (code: string, to: string) =>
    deps.askLink({ type: "folder-publish", signal: signalFileOf(code, to, now()) });
  const acted = ({ profileId, pairingId }: SignalFile) =>
    deps.acted.set(profileId, { pairingId, at: now() });
  if (step.type === "offer") {
    const { profileId } = step.to;
    // Checked before the offer, so a forged presence never gets a connection of this profile's.
    const refused = await refusal(deps, step.to);
    if (refused) return deps.log(`folder pairing: no offer to ${profileId}: ${refused}`);
    const { code } = await deps.pairing.createOffer(profileId);
    await publish(code, profileId);
  } else if (step.type === "answer") {
    const { code } = await deps.pairing.accept(step.offer.code);
    await acted(step.offer);
    if (code) await publish(code, step.offer.profileId);
    // Once the answer is out, so a quit before it leaves the offer to answer after a relaunch.
    await rememberAnswered(deps.answered, step.offer, now());
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
  // One piece of pairing work at a time, the mesh's too, so two never offer to one profile at once.
  const exclusive = (work: () => Promise<void>) => {
    queue = queue.then(work).catch(failed);
    return queue;
  };
  // Without the folder's grant the look fails; the dashboard that grants it again starts one.
  const lookAgain = () => resume().catch(failed);
  const handle = async (seen: Seen) => {
    const state = await deps.state.read();
    if (!state) return;
    const [me, links, pending, acted, answered] = await Promise.all([
      deps.identity(),
      deps.link.all(),
      deps.pending.all(),
      deps.acted.all(),
      deps.answered.all(),
    ]);
    // A verified link needs nothing; the presence stays, so the peer finds this one again.
    const linked = Object.keys(links).filter((peer) => links[peer]?.verified);
    const skip = [...linked, ...(state.paused ?? [])];
    const situation = { me: me.profileId, seen, skip, pending, acted, answered, now: now() };
    const steps = decideFolderSteps(situation);
    // One step at a time, so two never offer at once; one that fails leaves the others theirs.
    await steps.reduce(
      (done, step) => done.then(() => act(deps, step, now).catch(failed)),
      Promise.resolve(),
    );
  };
  return {
    ...folderPauses(deps.state, lookAgain),
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
    seen: (seen: Seen) => exclusive(() => handle(seen)),
    exclusive,
  };
}

export type FolderPairingFlow = ReturnType<typeof createFolderPairing>;
