import type { LinkCommand } from "@/messaging/peer-messages";
import { parsePeerFrame, peerMessage } from "@/p2p/protocol";
import type { MessageOf, PeerMessage, PeerPayload, PeerType } from "@/p2p/protocol";
import type {
  AuthorizedPeer,
  PeerLink,
  ProfileIdentity,
  Repository,
} from "@/storage/peer-repository";

export const NOT_CONNECTED = "The other profile is not connected.";

export interface PeerChannelDependencies {
  askLink: (command: LinkCommand) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  authorized: Pick<Repository<AuthorizedPeer>, "read">;
  link: Pick<Repository<PeerLink>, "read">;
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
  resolve: (message: PeerMessage) => void;
  reject: (error: Error) => void;
}

/** Requests waiting for the reply that names them, each failing after a timeout. */
function createWaiters(timeoutMs: number) {
  const waiters = new Map<string, Waiter>();
  const wait = (id: string) =>
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
  const failAll = () => {
    for (const waiter of waiters.values()) waiter.reject(new Error(NOT_CONNECTED));
  };
  return { wait, answer, fail, failAll };
}

/**
 * The background's side of the DataChannel: it sends only to the authorized peer over a verified
 * link, accepts only what that peer addressed to this profile, and pairs replies with requests.
 */
export function createPeerChannel(deps: PeerChannelDependencies) {
  const waiters = createWaiters(deps.replyTimeoutMs ?? 5000);
  const compose = async <T extends PeerType>(type: T, payload: PeerPayload<T>) => {
    const [me, peer, link] = await Promise.all([
      deps.identity(),
      deps.authorized.read(),
      deps.link.read(),
    ]);
    if (!peer || !link?.verified) throw new Error(NOT_CONNECTED);
    return peerMessage(type, { from: me.profileId, to: peer.profileId }, payload);
  };
  const transmit = async (message: PeerMessage) => {
    const frame = JSON.stringify(message);
    const result = await deps.askLink({ type: "send", peer: message.to, frame });
    if ((result as { sent?: boolean } | undefined)?.sent !== true) throw new Error(NOT_CONNECTED);
    deps.log(`sent ${message.type}`);
  };
  const send = async <T extends PeerType>(type: T, payload: PeerPayload<T>) => {
    const message = await compose(type, payload);
    await transmit(message);
    return message;
  };
  // Waits before sending, so a fast reply cannot arrive ahead of its waiter.
  const request = async <T extends PeerType>(type: T, payload: PeerPayload<T>) => {
    const message: MessageOf<T> = await compose(type, payload);
    const reply = waiters.wait(message.id);
    await transmit(message).catch((error: unknown) =>
      waiters.fail(message.id, error instanceof Error ? error : new Error(NOT_CONNECTED)),
    );
    return reply;
  };
  const receive = async (frame: string): Promise<Received> => {
    const message = parsePeerFrame(frame);
    if (!message) return { kind: "invalid" };
    const [me, peer, link] = await Promise.all([
      deps.identity(),
      deps.authorized.read(),
      deps.link.read(),
    ]);
    const authorized = message.to === me.profileId && message.from === peer?.profileId;
    if (!authorized || !link?.verified) return { kind: "unauthorized" };
    deps.log(`received ${message.type}`);
    waiters.answer(message);
    return { kind: "accepted", message };
  };
  return { send, request, receive, failAll: waiters.failAll };
}

export type PeerChannel = ReturnType<typeof createPeerChannel>;
