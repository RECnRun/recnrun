import { errorMessage } from "@recnrun/domain";
import type { PairingFlow } from "@/background/pairing";
import type { LinkCommand } from "@/messaging/peer-messages";
import { signalFileOf } from "@/p2p/folder-rendezvous";
import type { Presence, Seen, SignalFile } from "@/p2p/folder-rendezvous";
import { decodePairing, fingerprintOf } from "@/p2p/pairing-code";
import type {
  AuthorizedPeer,
  FolderPairing,
  PeerLink,
  PendingOffer,
  ProfileIdentity,
  Repository,
} from "@/storage/peer-repository";

/** How long the link gets to come up after this profile answered or connected, before a retry. */
const RETRY_MS = 30_000;

export type FolderStep =
  | { type: "wait" }
  | { type: "offer"; to: Presence }
  | { type: "answer"; offer: SignalFile }
  | { type: "connect"; answer: SignalFile };

const WAIT: FolderStep = { type: "wait" };

interface Situation {
  me: string;
  seen: Seen;
  /** The pinned peer: once there is one, no other presence counts. */
  peer: Pick<AuthorizedPeer, "profileId"> | null;
  pending: PendingOffer | null;
  state: FolderPairing;
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

/** The one profile to pair with: the pinned peer, or else the one that has waited longest. */
function partnerOf(presences: Presence[], peer: Situation["peer"]): Presence | undefined {
  if (peer) return presences.find(({ profileId }) => profileId === peer.profileId);
  const oldest = (a: Presence, b: Presence) =>
    a.createdAt - b.createdAt || a.profileId.localeCompare(b.profileId);
  return presences.toSorted(oldest)[0];
}

function offererStep(partner: Presence, signals: SignalFile[], { pending, now }: Situation) {
  if (pending?.to !== partner.profileId || pending.expiresAt <= now)
    return { type: "offer", to: partner } as const;
  const answer = signals.find(
    (each) => each.kind === "answer" && each.pairingId === pending.pairingId,
  );
  return answer ? ({ type: "connect", answer } as const) : WAIT;
}

/**
 * What this profile does next in the folder: the lower profile id offers to its partner and
 * connects with the answer; the other answers. Nobody clicks, since the folder is the consent.
 */
export function decideFolderStep(situation: Situation): FolderStep {
  const { me, seen, peer, state, now } = situation;
  const partner = partnerOf(seen.presences, peer);
  if (!partner || (state.acted && now - state.acted.at < RETRY_MS)) return WAIT;
  const signals = seen.signals.filter((each) => vouched(each, partner, now));
  if (me < partner.profileId) return offererStep(partner, signals, situation);
  const offer = signals.find(
    (each) => each.kind === "offer" && each.pairingId !== state.acted?.pairingId,
  );
  return offer ? { type: "answer", offer } : WAIT;
}

export interface FolderPairingDependencies {
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  pairing: Pick<PairingFlow, "createOffer" | "accept">;
  authorized: Pick<Repository<AuthorizedPeer>, "read">;
  pending: Pick<Repository<PendingOffer>, "read">;
  link: Pick<Repository<PeerLink>, "read">;
  state: Pick<Repository<FolderPairing>, "read" | "write">;
  log: (entry: string) => void;
  now?: () => number;
}

/** Carries out one step: offers and answers go into the folder, and connecting needs nothing there. */
async function act(deps: FolderPairingDependencies, step: FolderStep, now: () => number) {
  const publish = (code: string, to: string) =>
    deps.askLink({ type: "folder-publish", signal: signalFileOf(code, to, now()) });
  const acted = (pairingId: string) => deps.state.write({ acted: { pairingId, at: now() } });
  if (step.type === "offer") {
    const { code } = await deps.pairing.createOffer(step.to.profileId);
    await publish(code, step.to.profileId);
  } else if (step.type === "answer") {
    const { code } = await deps.pairing.accept(step.offer.code);
    await acted(step.offer.pairingId);
    if (code) await publish(code, step.offer.profileId);
  } else if (step.type === "connect") {
    await deps.pairing.accept(step.answer.code);
    await acted(step.answer.pairingId);
  }
}

/** Pairing through the RECnRun folder: the offscreen document watches, and this decides. */
export function createFolderPairing(deps: FolderPairingDependencies) {
  const now = deps.now ?? Date.now;
  let queue = Promise.resolve();
  const watch = async () => {
    const { profileId, displayName } = await deps.identity();
    await deps.askLink({ type: "folder-watch", profileId, displayName });
  };
  const stop = async () => {
    await deps.state.write(null);
    await deps.askLink({ type: "folder-stop" });
  };
  const handle = async (seen: Seen) => {
    const state = await deps.state.read();
    if (!state) return;
    if ((await deps.link.read())?.verified) return stop();
    const [me, peer, pending] = await Promise.all([
      deps.identity(),
      deps.authorized.read(),
      deps.pending.read(),
    ]);
    const step = decideFolderStep({ me: me.profileId, seen, peer, pending, state, now: now() });
    await act(deps, step, now);
  };
  return {
    /** Waits in the folder for another profile, as the user just chose it. */
    start: async () => {
      await deps.state.write({});
      await watch();
    },
    /** Waits again after the service worker or the browser restarted, if it waited before. */
    resume: async () => {
      if (await deps.state.read()) await watch();
    },
    stop,
    /** The link is verified, so waiting ends and this profile's files leave the folder. */
    paired: async () => {
      if (await deps.state.read()) await stop();
    },
    /** One sighting at a time, so two in a row never both offer. */
    seen: (seen: Seen) => {
      queue = queue
        .then(() => handle(seen))
        .catch((error: unknown) => deps.log(`folder pairing: ${errorMessage(error)}`));
      return queue;
    },
  };
}

export type FolderPairingFlow = ReturnType<typeof createFolderPairing>;
