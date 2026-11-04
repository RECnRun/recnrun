import type { LinkCommand } from "@/messaging/peer-messages";
import { authorizeCommand } from "@/p2p/authorization";
import type { Hierarchy, Sender } from "@/p2p/authorization";
import { parsePeerFrame, peerMessage } from "@/p2p/protocol";
import type { MessageOf, PeerMessage, PeerPayload, PeerType } from "@/p2p/protocol";
import { storedRoles } from "@/storage/hierarchy-repository";
import type {
  AuthorizedPeer,
  PeerLink,
  PeerRecords,
  ProfileIdentity,
} from "@/storage/peer-repository";

export const NOT_CONNECTED = "The other profile is not connected.";

export interface PeerChannelDependencies {
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  authorized: Pick<PeerRecords<AuthorizedPeer>, "get">;
  link: Pick<PeerRecords<PeerLink>, "get">;
  /** Message types and verdicts only, never payloads. */
  log: (entry: string) => void;
  /** The recorded hierarchy that authorizes each message; this profile's storage by default. */
  roles?: Hierarchy;
  replyTimeoutMs?: number;
}

/** What a received frame turned out to be. */
export type Received =
  | { kind: "accepted"; message: PeerMessage }
  | { kind: "invalid" }
  | { kind: "unauthorized" }
  | { kind: "refused"; reason: string };

interface Waiter {
  peer: string;
  resolve: (message: PeerMessage) => void;
  reject: (error: Error) => void;
}

/** Requests waiting for the reply that names them, each failing after a timeout. */
function createWaiters(timeoutMs: number) {
  const waiters = new Map<string, Waiter>();
  const wait = (id: string, peer: string) =>
    new Promise<PeerMessage>((resolve, reject) => {
      const settle = (done: () => void) => {
        clearTimeout(timer);
        waiters.delete(id);
        done();
      };
      const timer = setTimeout(
        () => settle(() => reject(new Error("The other profile did not answer in time."))),
        timeoutMs,
      );
      waiters.set(id, {
        peer,
        resolve: (reply) => settle(() => resolve(reply)),
        reject: (error) => settle(() => reject(error)),
      });
    });
  const answer = (message: PeerMessage) => {
    if ("requestId" in message && message.requestId)
      waiters.get(message.requestId)?.resolve(message);
  };
  const fail = (id: string, error: Error) => waiters.get(id)?.reject(error);
  // A Map iterates safely while settling deletes the visited entry.
  const failPeer = (peer: string) => {
    for (const waiter of waiters.values())
      if (waiter.peer === peer) waiter.reject(new Error(NOT_CONNECTED));
  };
  return { wait, answer, fail, failPeer };
}

/** The authorized `peer` while its own link is verified, whose certificate the link proved. */
async function verifiedPeer(deps: PeerChannelDependencies, peer: string) {
  const [authorized, link] = await Promise.all([deps.authorized.get(peer), deps.link.get(peer)]);
  return link?.verified === true ? authorized : null;
}

/** The verified peer of the link `peer` when it addressed `message` to this profile, else null. */
async function senderOf(
  deps: PeerChannelDependencies,
  message: PeerMessage,
  peer: string,
): Promise<Sender | null> {
  const me = await deps.identity();
  // A verified peer could otherwise claim another's id over its own link.
  if (message.to !== me.profileId || message.from !== peer) return null;
  const authorized = await verifiedPeer(deps, peer);
  return authorized && { profileId: peer, fingerprint: authorized.fingerprint };
}

/** What `frame` from `peer` is: parsed, addressed by a verified peer, and authorized. */
async function admit(
  deps: PeerChannelDependencies,
  roles: Hierarchy,
  frame: string,
  peer: string,
): Promise<Received> {
  const message = parsePeerFrame(frame);
  if (!message) return { kind: "invalid" };
  const sender = await senderOf(deps, message, peer);
  if (!sender) return { kind: "unauthorized" };
  const verdict = await authorizeCommand(message, sender, roles);
  if (!verdict.ok) {
    deps.log(`REFUSED ${message.type} from ${message.from}: ${verdict.reason}`);
    return { kind: "refused", reason: verdict.reason };
  }
  deps.log(`received ${message.type}`);
  return { kind: "accepted", message };
}

/**
 * The background's side of the DataChannels: it sends to an authorized peer only over that peer's
 * verified link, accepts only what the peer of a connection addressed to this profile over it, and
 * pairs replies with requests.
 */
export function createPeerChannel(deps: PeerChannelDependencies) {
  const waiters = createWaiters(deps.replyTimeoutMs ?? 5000);
  const roles = deps.roles ?? storedRoles();
  let refusals = 0;
  const compose = async <T extends PeerType>(to: string, type: T, payload: PeerPayload<T>) => {
    const me = await deps.identity();
    if (!(await verifiedPeer(deps, to))) throw new Error(NOT_CONNECTED);
    return peerMessage(type, { from: me.profileId, to }, payload);
  };
  const transmit = async (message: PeerMessage) => {
    const frame = JSON.stringify(message);
    const result = await deps.askLink({ type: "send", peer: message.to, frame });
    if ((result as { sent?: boolean } | undefined)?.sent !== true) throw new Error(NOT_CONNECTED);
    deps.log(`sent ${message.type}`);
  };
  const send = async <T extends PeerType>(to: string, type: T, payload: PeerPayload<T>) => {
    const message = await compose(to, type, payload);
    await transmit(message);
    return message;
  };
  // Waits before sending, so a fast reply cannot arrive ahead of its waiter.
  const request = async <T extends PeerType>(to: string, type: T, payload: PeerPayload<T>) => {
    const message: MessageOf<T> = await compose(to, type, payload);
    const reply = waiters.wait(message.id, to);
    await transmit(message).catch((error: unknown) =>
      waiters.fail(message.id, error instanceof Error ? error : new Error(NOT_CONNECTED)),
    );
    return reply;
  };
  /** A frame that came over the link to `peer`, which alone may have sent it. */
  const receive = async (frame: string, peer: string): Promise<Received> => {
    const received = await admit(deps, roles, frame, peer);
    // A refused reply answers no request, so nothing it carries reaches a caller.
    if (received.kind === "accepted") waiters.answer(received.message);
    if (received.kind === "refused") refusals += 1;
    return received;
  };
  /** How many authorized peers' frames the hierarchy refused, for tests. */
  const refused = () => refusals;
  return { send, request, receive, refused, failPeer: waiters.failPeer };
}

export type PeerChannel = ReturnType<typeof createPeerChannel>;
