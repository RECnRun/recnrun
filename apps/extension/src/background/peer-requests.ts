import type { PeerChannel } from "@/background/peer-channel";
import type { PairingFlow } from "@/background/pairing";
import type { LinkCommand, PeerRequest } from "@/messaging/peer-messages";
import type { FolderAccess } from "@/p2p/folder-store";
import type { PeerMessage, SharedTabs } from "@/p2p/protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type {
  AuthorizedPeer,
  PeerLink,
  ProfileIdentity,
  RemoteController,
  RemoteRecording,
  Repository,
} from "@/storage/peer-repository";

export interface PeerRequestDependencies {
  channel: Pick<PeerChannel, "request" | "send">;
  /** Introduces this profile to the peer, as on every new link. */
  hello: () => Promise<void>;
  pairing: PairingFlow;
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  rename: (identity: ProfileIdentity) => Promise<void>;
  authorized: Pick<Repository<AuthorizedPeer>, "read" | "write">;
  link: Pick<Repository<PeerLink>, "read" | "write">;
  mirror: Pick<Repository<RemoteRecording>, "read" | "write">;
  localSession: Pick<RecordingStore, "read">;
  /** The peer that started the session running here, if one did. */
  controller: Pick<Repository<RemoteController>, "read">;
  /** The peer's tabs as last reported. */
  tabs: Pick<Repository<SharedTabs>, "read" | "write">;
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

const verified = async (deps: Deps) => (await deps.link.read())?.verified === true;

/** Resolves when the executor did it; rejects with its reason, or when the link is down. */
async function command(reply: Promise<PeerMessage>): Promise<void> {
  const result = await reply;
  if (result.type === "COMMAND_RESULT" && !result.ok) throw new Error(result.reason ?? "Refused.");
}

async function peerTabs(deps: Deps): Promise<SharedTabs> {
  const known = await deps.tabs.read();
  // The last report outlives a disconnect, and the pages show it read only.
  if (known || !(await verified(deps))) return known ?? { tabs: [] };
  const reply = await deps.channel.request("GET_TABS", {});
  if (reply.type !== "TABS_SNAPSHOT") return { tabs: [] };
  const { tabs, currentId } = reply;
  const snapshot = currentId === undefined ? { tabs } : { tabs, currentId };
  await deps.tabs.write(snapshot);
  return snapshot;
}

async function startRemote(deps: Deps, tabId: number) {
  // One session per controlling profile: this one's own, or one it runs in the other profile.
  if (await deps.localSession.read()) throw new Error("A session already runs in this profile.");
  await command(deps.channel.request("SESSION_START", { tabId }));
}

/** The peer's session as its last report has it; the report is current only over a verified link. */
function peerSession(mirror: RemoteRecording | null, link: PeerLink) {
  if (!mirror?.session) return null;
  const { session, mine, connected } = mirror;
  return { status: session.status, mine, live: connected && link.verified };
}

async function status(deps: Deps) {
  const [identity, peer, stored, mirror, controller, local] = await Promise.all([
    deps.identity(),
    deps.authorized.read(),
    deps.link.read(),
    deps.mirror.read(),
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

async function ping(deps: Deps) {
  const sent = performance.now();
  await deps.channel.request("PING", { timestamp: Date.now() });
  return { latencyMs: Math.round(performance.now() - sent) };
}

/** Tells a verified peer the close is intended, so it does not report a failure, then closes. */
async function close(deps: Deps) {
  // The channel sends only over a verified link; a peer already gone hears nothing.
  await deps.channel.send("BYE", {}).catch(() => {});
  await deps.link.write({ state: "disconnected", verified: false, reason: "closed-here" });
  await deps.askLink({ type: "close" });
}

/** The user ends the link, so this profile also stops waiting in the folder to reconnect. */
async function disconnect(deps: Deps) {
  // Waiting stops even when the folder's own files cannot be removed.
  await deps.folder.stop().catch(() => {});
  await close(deps);
}

async function forget(deps: Deps) {
  await disconnect(deps);
  await deps.authorized.write(null);
  await deps.mirror.write(null);
  await deps.tabs.write(null);
}

/** A connected profile needs no folder, and its link lives in the handles' document. */
async function releaseFolder(deps: Deps) {
  if (!(await verified(deps))) await deps.folder.release();
}

async function rename(deps: Deps, displayName: string) {
  const identity = { ...(await deps.identity()), displayName };
  await deps.rename(identity);
  // The peer learns the new name at once; without a link, at the next HELLO.
  if (await verified(deps)) await deps.hello().catch(() => {});
}

type Handlers = {
  [K in PeerRequest["type"]]: (deps: Deps, request: Extract<PeerRequest, { type: K }>) => unknown;
};

const HANDLERS: Handlers = {
  status: (deps) => status(deps),
  rename: (deps, { displayName }) => rename(deps, displayName),
  "create-offer": (deps) => deps.pairing.createOffer(),
  inspect: (deps, { code }) => deps.pairing.inspect(code),
  accept: (deps, { code }) => deps.pairing.accept(code),
  disconnect: (deps) => disconnect(deps),
  forget: (deps) => forget(deps),
  "folder-pair": (deps) => deps.folder.start(),
  "folder-release": (deps) => releaseFolder(deps),
  ping: (deps) => ping(deps),
  diagnostics: (deps) => deps.askLink({ type: "info" }),
  tabs: (deps) => peerTabs(deps),
  activate: (deps, { tabId }) => command(deps.channel.request("ACTIVATE_TAB", { tabId })),
  "session-start": (deps, { tabId }) => startRemote(deps, tabId),
  "session-set": (deps, { status: next }) =>
    command(deps.channel.request("SESSION_SET_STATUS", { status: next })),
  "session-stop": (deps) => command(deps.channel.request("SESSION_STOP", {})),
};

/** Runs a page's request about the other profile; the result goes back in the reply. */
export async function handlePeerRequest(deps: Deps, request: PeerRequest): Promise<unknown> {
  // The table's key matches the request's type, which TypeScript cannot correlate on its own.
  const handler = HANDLERS[request.type] as (deps: Deps, request: PeerRequest) => unknown;
  return handler(deps, request);
}
