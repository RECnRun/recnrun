import type { PeerChannel } from "@/background/peer-channel";
import type { PairingFlow } from "@/background/pairing";
import type { LinkCommand, PeerRequest } from "@/messaging/peer-messages";
import type { PeerMessage, SharedTabs } from "@/p2p/protocol";
import type { RecordingStore } from "@/ports/recording-store";
import type {
  AuthorizedPeer,
  PeerLink,
  ProfileIdentity,
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
  /** The peer's tabs as last reported, kept in memory only. */
  tabs: { read: () => SharedTabs | undefined; write: (tabs: SharedTabs | undefined) => void };
}

type Deps = PeerRequestDependencies;

const verified = async (deps: Deps) => (await deps.link.read())?.verified === true;

/** Resolves when the executor did it; rejects with its reason, or when the link is down. */
async function command(reply: Promise<PeerMessage>): Promise<void> {
  const result = await reply;
  if (result.type === "COMMAND_RESULT" && !result.ok) throw new Error(result.reason ?? "Refused.");
}

async function peerTabs(deps: Deps): Promise<SharedTabs> {
  const known = deps.tabs.read();
  // The last report outlives a disconnect, so a remote session keeps showing its tab.
  if (known || !(await verified(deps))) return known ?? { tabs: [] };
  const reply = await deps.channel.request("GET_TABS", {});
  if (reply.type !== "TABS_SNAPSHOT") return { tabs: [] };
  const { tabs, currentId } = reply;
  const snapshot = currentId === undefined ? { tabs } : { tabs, currentId };
  deps.tabs.write(snapshot);
  return snapshot;
}

async function startRemote(deps: Deps, tabId: number) {
  // One session per controlling profile: this one's own, or one it runs in the other profile.
  if (await deps.localSession.read()) throw new Error("A session already runs in this profile.");
  await command(deps.channel.request("SESSION_START", { tabId }));
}

async function status(deps: Deps) {
  const [identity, peer, link] = await Promise.all([
    deps.identity(),
    deps.authorized.read(),
    deps.link.read(),
  ]);
  return { identity, peer, link: link ?? { state: "idle", verified: false } };
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

async function forget(deps: Deps) {
  await close(deps);
  await deps.authorized.write(null);
  await deps.mirror.write(null);
  deps.tabs.write(undefined);
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
  disconnect: (deps) => close(deps),
  forget: (deps) => forget(deps),
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
