import { NOT_CONNECTED } from "@/background/peer-channel";
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
  mirror: Pick<PeerRecords<RemoteRecording>, "get" | "set">;
  localSession: Pick<RecordingStore, "read">;
  /** The peer that started the session running here, if one did. */
  controller: Pick<Repository<RemoteController>, "read">;
  /** Each peer's tabs as last reported. */
  tabs: Pick<PeerRecords<SharedTabs>, "get" | "set">;
  /** The RECnRun folder, and waiting in it for another profile to pair with. */
  folder: {
    access: () => Promise<FolderAccess>;
    waiting: () => Promise<boolean>;
    start: () => Promise<void>;
    stop: () => Promise<void>;
    /** Drops every handle to the folder, so Chrome may offer to keep it on every visit. */
    release: () => Promise<void>;
  };
}

type Deps = PeerRequestDependencies;

const verified = async (deps: Deps, peer: string) => (await deps.link.get(peer))?.verified === true;

/** Until requests name their peer, they act on the first one paired. */
async function primary(deps: Deps): Promise<AuthorizedPeer | null> {
  return Object.values(await deps.authorized.all())[0] ?? null;
}

async function primaryId(deps: Deps): Promise<string> {
  const peer = await primary(deps);
  if (!peer) throw new Error(NOT_CONNECTED);
  return peer.profileId;
}

/** Asks the first peer; the reply's outcome is the request's. */
async function ask<T extends PeerType>(deps: Deps, type: T, payload: PeerPayload<T>) {
  return command(deps.channel.request(await primaryId(deps), type, payload));
}

/** Resolves when the executor did it; rejects with its reason, or when the link is down. */
async function command(reply: Promise<PeerMessage>): Promise<void> {
  const result = await reply;
  if (result.type === "COMMAND_RESULT" && !result.ok) throw new Error(result.reason ?? "Refused.");
}

async function peerTabs(deps: Deps): Promise<SharedTabs> {
  const peer = await primary(deps);
  if (!peer) return { tabs: [] };
  const known = await deps.tabs.get(peer.profileId);
  // The last report outlives a disconnect, and the pages show it read only.
  if (known || !(await verified(deps, peer.profileId))) return known ?? { tabs: [] };
  const reply = await deps.channel.request(peer.profileId, "GET_TABS", {});
  if (reply.type !== "TABS_SNAPSHOT") return { tabs: [] };
  const { tabs, currentId } = reply;
  const snapshot = currentId === undefined ? { tabs } : { tabs, currentId };
  await deps.tabs.set(peer.profileId, snapshot);
  return snapshot;
}

async function startRemote(deps: Deps, tabId: number) {
  // One session per controlling profile: this one's own, or one it runs in the other profile.
  if (await deps.localSession.read()) throw new Error("A session already runs in this profile.");
  await ask(deps, "SESSION_START", { tabId });
}

/** The peer's session as its last report has it; the report is current only over a verified link. */
function peerSession(mirror: RemoteRecording | null, link: PeerLink) {
  if (!mirror?.session) return null;
  const { session, mine, connected } = mirror;
  return { status: session.status, mine, live: connected && link.verified };
}

async function status(deps: Deps) {
  const peer = await primary(deps);
  const id = peer?.profileId;
  const [identity, stored, mirror, controller, local] = await Promise.all([
    deps.identity(),
    id ? deps.link.get(id) : null,
    id ? deps.mirror.get(id) : null,
    deps.controller.read(),
    deps.localSession.read(),
  ]);
  const link = stored ?? { state: "idle" as const, verified: false };
  // Without the link the peer cannot stop it, so this profile's user gets the controls back.
  const controlledByPeer = link.verified && controller !== null && local !== null;
  // A folder the offscreen document cannot read is one the user has to choose again.
  const folder = await deps.folder.access().catch((): FolderAccess => "none");
  const folderPairing = await deps.folder.waiting();
  const session = peerSession(mirror, link);
  return { identity, peer, link, peerSession: session, controlledByPeer, folder, folderPairing };
}

/** Tells a verified peer the close is intended, so it does not report a failure, then closes. */
async function close(deps: Deps, peer: string) {
  // The channel sends only over a verified link; a peer already gone hears nothing.
  await deps.channel.send(peer, "BYE", {}).catch(() => {});
  await deps.link.set(peer, { state: "disconnected", verified: false, reason: "closed-here" });
  await deps.askLink({ type: "close", peer });
}

/** The user ends the link, so this profile also stops waiting in the folder to reconnect. */
async function disconnect(deps: Deps) {
  // Waiting stops even when the folder's own files cannot be removed.
  await deps.folder.stop().catch(() => {});
  const peer = await primary(deps);
  if (peer) await close(deps, peer.profileId);
}

async function forget(deps: Deps) {
  const peer = await primary(deps);
  await disconnect(deps);
  if (!peer) return;
  await deps.authorized.set(peer.profileId, null);
  await deps.mirror.set(peer.profileId, null);
  await deps.tabs.set(peer.profileId, null);
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
  disconnect: (deps) => disconnect(deps),
  forget: (deps) => forget(deps),
  "folder-pair": (deps) => deps.folder.start(),
  "folder-release": (deps) => releaseFolder(deps),
  tabs: (deps) => peerTabs(deps),
  activate: (deps, { tabId }) => ask(deps, "ACTIVATE_TAB", { tabId }),
  "session-start": (deps, { tabId }) => startRemote(deps, tabId),
  "session-set": (deps, { status: next }) => ask(deps, "SESSION_SET_STATUS", { status: next }),
  "session-stop": (deps) => ask(deps, "SESSION_STOP", {}),
};

/** Runs a page's request about the other profile; the result goes back in the reply. */
export async function handlePeerRequest(deps: Deps, request: PeerRequest): Promise<unknown> {
  // The table's key matches the request's type, which TypeScript cannot correlate on its own.
  const handler = HANDLERS[request.type] as (deps: Deps, request: PeerRequest) => unknown;
  return handler(deps, request);
}
