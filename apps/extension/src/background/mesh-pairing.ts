import { errorMessage } from "@recnrun/domain";
import { vouched } from "@/background/folder-pairing";
import type { FolderPairingFlow } from "@/background/folder-pairing";
import type { PairingFlow } from "@/background/pairing";
import type { PeerChannel } from "@/background/peer-channel";
import { signalFileOf } from "@/p2p/folder-rendezvous";
import type { Member, MessageOf, PeerMessage } from "@/p2p/protocol";
import type {
  AuthorizedPeer,
  FolderActed,
  FolderPairing,
  PeerLink,
  PeerRecords,
  PendingOffer,
  ProfileIdentity,
  Repository,
} from "@/storage/peer-repository";

export interface MeshPairingDependencies {
  channel: Pick<PeerChannel, "send">;
  identity: () => Promise<ProfileIdentity>;
  pairing: Pick<PairingFlow, "createOffer" | "accept">;
  authorized: Pick<PeerRecords<AuthorizedPeer>, "all">;
  link: Pick<PeerRecords<PeerLink>, "all">;
  pending: Pick<PeerRecords<PendingOffer>, "get">;
  acted: Pick<PeerRecords<FolderActed>, "get" | "set">;
  /** The profiles each linked peer last said its own links reach. */
  members: Pick<PeerRecords<Member[]>, "all" | "set">;
  state: Pick<Repository<FolderPairing>, "read">;
  exclusive: FolderPairingFlow["exclusive"];
  log: (entry: string) => void;
  now?: () => number;
}

/** Which profiles a look pairs with: only those not met in this session, or every one not linked. */
export type MeshScope = "new" | "all";

interface Known {
  me: string;
  state: FolderPairing | null;
  links: Record<string, PeerLink>;
  authorized: Record<string, AuthorizedPeer>;
  members: Record<string, Member[]>;
}

interface Mesh {
  deps: MeshPairingDependencies;
  now: () => number;
  failed: (error: unknown) => void;
}

async function knownNow({ deps }: Mesh): Promise<Known> {
  const [me, state, links, authorized, members] = await Promise.all([
    deps.identity(),
    deps.state.read(),
    deps.link.all(),
    deps.authorized.all(),
    deps.members.all(),
  ]);
  return { me: me.profileId, state, links, authorized, members };
}

/** Whether this profile pairs with `partner` now: it waits in the folder, and they are not linked. */
function wanted({ me, state, links }: Known, partner: string) {
  // The folder is the consent: a profile that never chose it pairs with nobody through the mesh.
  if (!state || state.paused?.includes(partner)) return false;
  return partner !== me && links[partner]?.verified !== true;
}

/** The member `relay` vouches for as `partner`, if this profile should pair with it now. */
function partnerVia(known: Known, relay: string, partner: string): Member | undefined {
  if (!wanted(known, partner) || known.links[relay]?.verified !== true) return undefined;
  const member = known.members[relay]?.find((each) => each.profileId === partner);
  // A relay cannot swap the certificate of a profile this one pinned already.
  const pinned = known.authorized[partner]?.fingerprint ?? member?.fingerprint;
  return member?.fingerprint === pinned ? member : undefined;
}

/** A profile this one met already: paired once, and linked or tried in this session. */
const met = (known: Known, partner: string) =>
  partner in known.authorized && partner in known.links;

function decoded(code: string, me: string, now: number) {
  try {
    return signalFileOf(code, me, now);
  } catch {
    return undefined;
  }
}

/** Tells every linked peer which of the others this profile's links reach. */
async function announce(mesh: Mesh) {
  const { links, authorized } = await knownNow(mesh);
  const linked = Object.keys(links).filter((peer) => links[peer]?.verified);
  const reached = linked.flatMap((peer) => {
    const known = authorized[peer];
    return known ? [{ ...known }] : [];
  });
  const send = (peer: string) => {
    const members = reached.filter((member) => member.profileId !== peer);
    return mesh.deps.channel.send(peer, "MEMBERS", { members }).catch(mesh.failed);
  };
  await Promise.all(linked.map(send));
}

/** Offers to `partner` through `relay`; an offer still waiting goes again instead of a new one. */
async function offer({ deps, now }: Mesh, relay: string, me: string, partner: string) {
  const pending = await deps.pending.get(partner);
  // The folder may have carried it where the partner cannot read.
  const live = pending && pending.expiresAt > now() ? pending : undefined;
  const code = live?.code ?? (await deps.pairing.createOffer(partner)).code;
  await deps.channel.send(relay, "SIGNAL", { origin: me, target: partner, code });
}

/** Pairs with the profiles linked peers reach and this one does not, each through one of them. */
async function look(mesh: Mesh, scope: MeshScope) {
  const known = await knownNow(mesh);
  const done = new Set<string>();
  const candidates = Object.entries(known.members).flatMap(([relay, members]) =>
    members.map(({ profileId }) => ({ relay, partner: profileId })),
  );
  for (const { relay, partner } of candidates) {
    const skip = done.has(partner) || (scope === "new" && met(known, partner));
    if (skip || !partnerVia(known, relay, partner)) continue;
    done.add(partner);
    // Of each pair, the lower profile id offers, as in the folder; the other asks it to.
    const reach =
      known.me < partner
        ? offer(mesh, relay, known.me, partner)
        : mesh.deps.channel.send(relay, "INVITE", { origin: known.me, target: partner });
    await reach.catch(mesh.failed);
  }
}

/** A signal another profile sent this one through `from`, which must vouch for it. */
async function signalled(mesh: Mesh, message: MessageOf<"SIGNAL">) {
  const { deps, now } = mesh;
  const { origin, from } = message;
  const known = await knownNow(mesh);
  const member = partnerVia(known, from, origin);
  const signal = decoded(message.code, known.me, now());
  if (!member || !signal || !vouched(signal, member, now())) {
    return deps.log("dropped a SIGNAL no linked peer vouched for");
  }
  const acted = { pairingId: signal.pairingId, at: now() };
  if (signal.kind === "answer") {
    await deps.pairing.accept(signal.code);
    return deps.acted.set(origin, acted);
  }
  // Only the higher id answers, and each offer once.
  if (known.me < origin || (await deps.acted.get(origin))?.pairingId === acted.pairingId) return;
  const { code } = await deps.pairing.accept(signal.code);
  await deps.acted.set(origin, acted);
  if (code) await deps.channel.send(from, "SIGNAL", { origin: known.me, target: origin, code });
}

async function invited(mesh: Mesh, { from, origin }: MessageOf<"INVITE">) {
  const known = await knownNow(mesh);
  if (known.me < origin && partnerVia(known, from, origin))
    await offer(mesh, from, known.me, origin);
}

/** Carries a peer's own signal on to another peer this profile's link reaches. */
async function forward(mesh: Mesh, message: MessageOf<"SIGNAL" | "INVITE">) {
  const { origin, target, from } = message;
  // A peer may only speak for itself; `from` is the peer of the link the frame came over.
  if (origin !== from) return mesh.deps.log(`dropped a ${message.type} relayed for another`);
  const { channel } = mesh.deps;
  const sent =
    message.type === "SIGNAL"
      ? channel.send(target, "SIGNAL", { origin, target, code: message.code })
      : channel.send(target, "INVITE", { origin, target });
  await sent.catch(mesh.failed);
}

/**
 * Pairing through the mesh: each profile tells its linked peers whom its links reach, and two
 * profiles linked to one peer exchange their codes through it, as they would through the folder.
 * Only one profile of the mesh then needs the folder for a newcomer to reach every other.
 */
export function createMeshPairing(deps: MeshPairingDependencies) {
  const mesh: Mesh = {
    deps,
    now: deps.now ?? Date.now,
    failed: (error) => deps.log(`mesh pairing: ${errorMessage(error)}`),
  };
  const receive = async (message: PeerMessage): Promise<void> => {
    if (message.type === "MEMBERS") {
      await deps.members.set(message.from, message.members);
      return deps.exclusive(() => look(mesh, "new"));
    }
    if (message.type !== "SIGNAL" && message.type !== "INVITE") return;
    const me = await deps.identity();
    if (message.target !== me.profileId) return forward(mesh, message);
    return deps.exclusive(() =>
      message.type === "SIGNAL" ? signalled(mesh, message) : invited(mesh, message),
    );
  };
  return {
    announce: () => announce(mesh),
    receive,
    look: (scope: MeshScope) => deps.exclusive(() => look(mesh, scope)),
    /** The link to `peer` went down: what it reached no longer counts, and the others learn it. */
    dropped: async (peer: string) => {
      // Every verified peer said whom it reaches, so a link that never came up changes nothing.
      if (!(peer in (await deps.members.all()))) return;
      await deps.members.set(peer, null);
      await announce(mesh);
    },
  };
}

export type MeshPairingFlow = ReturnType<typeof createMeshPairing>;
