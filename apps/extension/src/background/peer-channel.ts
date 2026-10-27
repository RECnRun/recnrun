import type { LinkCommand } from "@/messaging/peer-messages";
import { parsePeerFrame, peerMessage } from "@/p2p/protocol";
import type { MessageOf, PeerMessage, PeerPayload, PeerType } from "@/p2p/protocol";
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
  replyTimeoutMs?: number;
}

/** What a received frame turned out to be. */
export type Received =
  | { kind: "accepted"; message: PeerMessage }
  | { kind: "invalid" }
  | { kind: "unauthorized" };

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

/** Whether `peer` is authorized and its own link is verified. */
async function verifiedPeer(deps: PeerChannelDependencies, peer: string) {
  const [authorized, link] = await Promise.all([deps.authorized.get(peer), deps.link.get(peer)]);
  return authorized !== null && link?.verified === true;
}

/**
 * The background's side of the DataChannels: it sends to an authorized peer only over that peer's
 * verified link, accepts only what the peer of a connection addressed to this profile over it, and
 * pairs replies with requests.
 */
export function createPeerChannel(deps: PeerChannelDependencies) {
  const waiters = createWaiters(deps.replyTimeoutMs ?? 5000);
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
    const message = parsePeerFrame(frame);
    if (!message) return { kind: "invalid" };
    const me = await deps.identity();
    // A verified peer could otherwise claim another's id over its own link.
    const addressed = message.to === me.profileId && message.from === peer;
    if (!addressed || !(await verifiedPeer(deps, peer))) return { kind: "unauthorized" };
    deps.log(`received ${message.type}`);
    waiters.answer(message);
    return { kind: "accepted", message };
  };
  return { send, request, receive, failPeer: waiters.failPeer };
}

export type PeerChannel = ReturnType<typeof createPeerChannel>;
