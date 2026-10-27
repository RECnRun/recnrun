import type { PeerChannel } from "@/background/peer-channel";
import type { LinkCommand, PeerRequest } from "@/messaging/peer-messages";
import type { FolderAccess } from "@/p2p/folder-store";
import type { PeerMessage, PeerPayload, PeerType, SharedTabs } from "@/p2p/protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type {
  AuthorizedPeer,
  PeerLink,
  PeerRecords,
  ProfileIdentity,
  RemoteController,
  RemoteRecording,
  Repository,
} from "@/storage/peer-repository";

export interface PeerRequestDependencies {
  channel: Pick<PeerChannel, "request" | "send">;
  /** Introduces this profile to a peer, as on every new link. */
  hello: (peer: string) => Promise<void>;
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  rename: (identity: ProfileIdentity) => Promise<void>;
  authorized: Pick<PeerRecords<AuthorizedPeer>, "all" | "set">;
  link: Pick<PeerRecords<PeerLink>, "get" | "set">;
  mirror: Pick<PeerRecords<RemoteRecording>, "all" | "get" | "set">;
  localSession: Pick<RecordingStore, "read">;
  /** The peer that started the session running here, if one did. */
  controller: Pick<Repository<RemoteController>, "read">;
  /** Each peer's tabs as last reported. */
  tabs: Pick<PeerRecords<SharedTabs>, "get" | "set">;
  /** The RECnRun folder, waiting in it for other profiles, and the ones it leaves alone. */
  folder: {
    access: () => Promise<FolderAccess>;
    waiting: () => Promise<boolean>;
    paused: () => Promise<string[]>;
    start: () => Promise<void>;
    pause: (peer: string) => Promise<void>;
    unpause: (peer: string) => Promise<void>;
    unpauseAll: () => Promise<void>;
    /** Drops every handle to the folder, so Chrome may offer to keep it on every visit. */
    release: () => Promise<void>;
  };
}

type Deps = PeerRequestDependencies;

const IDLE: PeerLink = { state: "idle", verified: false };

const verified = async (deps: Deps, peer: string) => (await deps.link.get(peer))?.verified === true;

/** Asks `peer`; the reply's outcome is the request's. */
async function ask<T extends PeerType>(deps: Deps, peer: string, type: T, payload: PeerPayload<T>) {
  return command(deps.channel.request(peer, type, payload));
}

/** Resolves when the executor did it; rejects with its reason, or when the link is down. */
async function command(reply: Promise<PeerMessage>): Promise<void> {
  const result = await reply;
  if (result.type === "COMMAND_RESULT" && !result.ok) throw new Error(result.reason ?? "Refused.");
}

async function peerTabs(deps: Deps, peer: string): Promise<SharedTabs> {
  const known = await deps.tabs.get(peer);
  // The last report outlives a disconnect, and the pages show it read only.
  if (known || !(await verified(deps, peer))) return known ?? { tabs: [] };
  const reply = await deps.channel.request(peer, "GET_TABS", {});
  if (reply.type !== "TABS_SNAPSHOT") return { tabs: [] };
  const { tabs, currentId } = reply;
  const snapshot = currentId === undefined ? { tabs } : { tabs, currentId };
  await deps.tabs.set(peer, snapshot);
  return snapshot;
}

/** The peer whose last report, over a link that held, has a session running. */
async function busyPeer(deps: Deps): Promise<AuthorizedPeer | undefined> {
  const [mirrors, authorized] = await Promise.all([deps.mirror.all(), deps.authorized.all()]);
  const busy = Object.values(mirrors).find(({ session, connected }) => session && connected);
  return busy && authorized[busy.profileId];
}

async function startRemote(deps: Deps, peer: string, tabId: number) {
  // One session at a time across every profile: this one's own, or one it runs in a peer.
  if (await deps.localSession.read()) throw new Error("A session already runs in this profile.");
  const busy = await busyPeer(deps);
  if (busy) throw new Error(`A session already runs in ${busy.displayName}.`);
  await ask(deps, peer, "SESSION_START", { tabId });
}

/** The peer's session as its last report has it; the report is current only over a verified link. */
function peerSession(mirror: RemoteRecording | null, link: PeerLink) {
  if (!mirror?.session) return null;
  const { session, mine, connected } = mirror;
  return { status: session.status, mine, live: connected && link.verified };
}

async function entry(deps: Deps, peer: AuthorizedPeer) {
  const [stored, mirror] = await Promise.all([
    deps.link.get(peer.profileId),
    deps.mirror.get(peer.profileId),
  ]);
  const link = stored ?? IDLE;
  return { peer, link, peerSession: peerSession(mirror, link) };
}

async function status(deps: Deps) {
  const [identity, authorized, controller, local, paused] = await Promise.all([
    deps.identity(),
    deps.authorized.all(),
    deps.controller.read(),
    deps.localSession.read(),
    deps.folder.paused(),
  ]);
  const peers = await Promise.all(Object.values(authorized).map((peer) => entry(deps, peer)));
  // Without the link the peer cannot stop it, so this profile's user gets the controls back.
  const controlling = peers.find(
    ({ peer, link }) => link.verified && peer.profileId === controller?.profileId,
  );
  const controlledBy = local && controlling ? controlling.peer.profileId : null;
  // A folder the offscreen document cannot read is one the user has to choose again.
  const folder = await deps.folder.access().catch((): FolderAccess => "none");
  const folderPairing = await deps.folder.waiting();
  return { identity, peers, controlledBy, paused, folder, folderPairing };
}

/** Tells a verified peer the close is intended, so it does not report a failure, then closes. */
async function close(deps: Deps, peer: string) {
  // The channel sends only over a verified link; a peer already gone hears nothing.
  await deps.channel.send(peer, "BYE", {}).catch(() => {});
  await deps.link.set(peer, { state: "disconnected", verified: false, reason: "closed-here" });
  await deps.askLink({ type: "close", peer });
}

/** The user ends one link, so the folder leaves that peer alone until Reconnect. */
async function disconnect(deps: Deps, peer: string) {
  await deps.folder.pause(peer);
  await close(deps, peer);
}

/** Forgetting keeps the pause, so a profile still in the folder does not pair again at once. */
async function forget(deps: Deps, peer: string) {
  await disconnect(deps, peer);
  await deps.authorized.set(peer, null);
  await deps.mirror.set(peer, null);
  await deps.tabs.set(peer, null);
}

/** The peers whose link is verified now. */
async function linked(deps: Deps): Promise<string[]> {
  const peers = Object.keys(await deps.authorized.all());
  const up = await Promise.all(peers.map((peer) => verified(deps, peer)));
  return peers.filter((_, index) => up[index]);
}

/** A connected profile needs no folder, and its links live in the handles' document. */
async function releaseFolder(deps: Deps) {
  if ((await linked(deps)).length === 0) await deps.folder.release();
}

async function rename(deps: Deps, displayName: string) {
  const identity = { ...(await deps.identity()), displayName };
  await deps.rename(identity);
  // Linked peers learn the new name at once; the others at their next HELLO.
  const peers = await linked(deps);
  await Promise.all(peers.map((peer) => deps.hello(peer).catch(() => {})));
}

type Handlers = {
  [K in PeerRequest["type"]]: (deps: Deps, request: Extract<PeerRequest, { type: K }>) => unknown;
};

const HANDLERS: Handlers = {
  status: (deps) => status(deps),
  rename: (deps, { displayName }) => rename(deps, displayName),
  disconnect: (deps, { peer }) => disconnect(deps, peer),
  reconnect: (deps, { peer }) => deps.folder.unpause(peer),
  forget: (deps, { peer }) => forget(deps, peer),
  "pair-again": (deps) => deps.folder.unpauseAll(),
  "folder-pair": (deps) => deps.folder.start(),
  "folder-release": (deps) => releaseFolder(deps),
  tabs: (deps, { peer }) => peerTabs(deps, peer),
  activate: (deps, { peer, tabId }) => ask(deps, peer, "ACTIVATE_TAB", { tabId }),
  "session-start": (deps, { peer, tabId }) => startRemote(deps, peer, tabId),
  "session-set": (deps, { peer, status: next }) =>
    ask(deps, peer, "SESSION_SET_STATUS", { status: next }),
  "session-stop": (deps, { peer }) => ask(deps, peer, "SESSION_STOP", {}),
};

/** Runs a page's request about the other profiles; the result goes back in the reply. */
export async function handlePeerRequest(deps: Deps, request: PeerRequest): Promise<unknown> {
  // The table's key matches the request's type, which TypeScript cannot correlate on its own.
  const handler = HANDLERS[request.type] as (deps: Deps, request: PeerRequest) => unknown;
  return handler(deps, request);
}
