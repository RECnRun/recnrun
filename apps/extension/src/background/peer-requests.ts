import type { PeerChannel } from "@/background/peer-channel";
import type { createPairing } from "@/background/pairing";
import type { SessionStore } from "@/background/session-requests";
import type { PeerRequest } from "@/messaging/peer-protocol";
import type { PeerMessage } from "@/p2p/protocol";
import type {
  AuthorizedPeer,
  PeerLinkStatus,
  ProfileIdentity,
  RemoteRecording,
  Repository,
} from "@/storage/peer-repository";

export interface PeerRequestDependencies {
  channel: Pick<PeerChannel, "request">;
  pairing: ReturnType<typeof createPairing>;
  closeLink: () => Promise<unknown>;
  diagnostics: () => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  rename: (identity: ProfileIdentity) => Promise<void>;
  authorized: Pick<Repository<AuthorizedPeer>, "read" | "write">;
  link: Pick<Repository<PeerLinkStatus>, "read">;
  mirror: Pick<Repository<RemoteRecording>, "read" | "write">;
  localSession: Pick<SessionStore, "read">;
}

type Deps = PeerRequestDependencies;

/** A command's result: resolves on success, rejects with the executor's reason. */
async function command(message: Promise<PeerMessage>): Promise<void> {
  const reply = await message;
  if (reply.type === "COMMAND_RESULT" && !reply.ok) throw new Error(reply.reason ?? "Refused.");
}

async function remoteTabs(deps: Deps) {
  if (!(await deps.link.read())?.verified) return { tabs: [] };
  const reply = await deps.channel.request("GET_TABS", {});
  if (reply.type !== "TABS_SNAPSHOT") return { tabs: [] };
  return reply.currentId === undefined
    ? { tabs: reply.tabs }
    : { tabs: reply.tabs, currentId: reply.currentId };
}

async function startRemote(deps: Deps, tabId: number) {
  // One session per controlling profile, local or remote.
  if (await deps.localSession.read().catch(() => null)) {
    throw new Error("A session already runs in this profile.");
  }
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
  const sent = Date.now();
  await deps.channel.request("PING", { timestamp: sent });
  return { latencyMs: Date.now() - sent };
}

async function forget(deps: Deps) {
  await deps.authorized.write(null);
  await deps.mirror.write(null);
  await deps.closeLink();
}

async function rename(deps: Deps, displayName: string) {
  await deps.rename({ ...(await deps.identity()), displayName });
}

const HANDLERS: {
  [K in PeerRequest["type"]]: (deps: Deps, request: Extract<PeerRequest, { type: K }>) => unknown;
} = {
  "peer-status": (deps) => status(deps),
  "peer-rename": (deps, { displayName }) => rename(deps, displayName),
  "peer-create-offer": (deps) => deps.pairing.createOffer(),
  "peer-inspect": (deps, { code }) => deps.pairing.inspect(code),
  "peer-accept": (deps, { code }) => deps.pairing.accept(code),
  "peer-disconnect": (deps) => deps.closeLink(),
  "peer-forget": (deps) => forget(deps),
  "peer-ping": (deps) => ping(deps),
  "peer-diagnostics": (deps) => deps.diagnostics(),
  "peer-tabs": (deps) => remoteTabs(deps),
  "peer-activate": (deps, { tabId }) => command(deps.channel.request("ACTIVATE_TAB", { tabId })),
  "remote-session-start": (deps, { tabId }) => startRemote(deps, tabId),
  "remote-session-set": (deps, { status: next }) =>
    command(deps.channel.request("SESSION_SET_STATUS", { status: next })),
  "remote-session-stop": (deps) => command(deps.channel.request("SESSION_STOP", {})),
  "remote-session-forget": (deps) => deps.mirror.write(null),
};

/** Runs a page's peer request; the result goes back in the reply. */
export function handlePeerRequest(deps: Deps, request: PeerRequest): Promise<unknown> {
  const handler = HANDLERS[request.type] as (deps: Deps, request: PeerRequest) => unknown;
  return Promise.resolve(handler(deps, request));
}
