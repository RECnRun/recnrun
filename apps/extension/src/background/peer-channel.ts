import { parsePeerFrame, peerMessage } from "@/p2p/protocol";
import type { PeerMessage, PeerPayload, PeerType } from "@/p2p/protocol";
import type {
  AuthorizedPeer,
  PeerLinkStatus,
  ProfileIdentity,
  Repository,
} from "@/storage/peer-repository";

export const NOT_CONNECTED = "The other profile is not connected.";
const REPLY_TIMEOUT_MS = 5000;

export interface PeerChannelDependencies {
  askLink: (
    command: { type: "link-send"; frame: string } | { type: "link-close" },
  ) => Promise<unknown>;
  identity: () => Promise<ProfileIdentity>;
  authorized: Pick<Repository<AuthorizedPeer>, "read">;
  link: Pick<Repository<PeerLinkStatus>, "read">;
  log?: (entry: string) => void;
}

interface Waiting {
  resolve: (message: PeerMessage) => void;
  reject: (error: Error) => void;
}

type Log = (entry: string) => void;

/** Requests waiting for their reply, each failing after a timeout. */
function createWaiting() {
  const waiting = new Map<string, Waiting>();
  const wait = (id: string) =>
    new Promise<PeerMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        reject(new Error("The other profile did not answer in time."));
      }, REPLY_TIMEOUT_MS);
      const settle = (done: () => void) => {
        clearTimeout(timer);
        waiting.delete(id);
        done();
      };
      waiting.set(id, {
        resolve: (reply) => settle(() => resolve(reply)),
        reject: (error) => settle(() => reject(error)),
      });
    });
  const answer = (message: PeerMessage) => {
    const requestId = "requestId" in message ? message.requestId : undefined;
    if (requestId) waiting.get(requestId)?.resolve(message);
  };
  const fail = (id: string, error: unknown) =>
    waiting.get(id)?.reject(error instanceof Error ? error : new Error(NOT_CONNECTED));
  // Settling deletes from the map, so iterate over a copy.
  const failAll = () => {
    for (const each of Array.from(waiting.values())) each.reject(new Error(NOT_CONNECTED));
  };
  return { wait, answer, fail, failAll };
}

/** Validates a frame and its sender; undefined when it must be ignored. */
async function accepted(
  frame: string,
  deps: PeerChannelDependencies,
  log: Log,
): Promise<PeerMessage | undefined> {
  const drop = (reason: string) => {
    log(`dropped: ${reason}`);
    return undefined;
  };
  const message = parsePeerFrame(frame);
  if (!message) return drop("invalid frame");
  const [me, peer, status] = await Promise.all([
    deps.identity(),
    deps.authorized.read(),
    deps.link.read(),
  ]);
  if (message.to !== me.profileId || message.from !== peer?.profileId) {
    return drop(`unauthorized ${message.type}`);
  }
  // The link is verified once its certificate matches the confirmed peer's.
  if (!status?.verified) return drop(`${message.type} on an unverified link`);
  log(`received ${message.type}`);
  return message;
}

/**
 * The background's side of the DataChannel: it sends only to the authorized peer, accepts only
 * from it, and pairs each reply with the request it answers by `requestId`.
 */
export function createPeerChannel(deps: PeerChannelDependencies) {
  const log = deps.log ?? (() => {});
  const waiting = createWaiting();
  const route = async () => {
    const [me, peer] = await Promise.all([deps.identity(), deps.authorized.read()]);
    if (!peer) throw new Error(NOT_CONNECTED);
    return { from: me.profileId, to: peer.profileId };
  };
  const compose = async <T extends PeerType>(type: T, payload: PeerPayload<T>) => {
    if (!(await deps.link.read())?.verified) throw new Error(NOT_CONNECTED);
    return peerMessage(type, await route(), payload);
  };
  const transmit = async (message: PeerMessage) => {
    const sent = (await deps.askLink({ type: "link-send", frame: JSON.stringify(message) })) as {
      sent?: boolean;
    };
    if (!sent?.sent) throw new Error(NOT_CONNECTED);
    log(`sent ${message.type}`);
  };
  const send = async <T extends PeerType>(type: T, payload: PeerPayload<T>) => {
    const message = await compose(type, payload);
    await transmit(message);
    return message;
  };
  // Waits before sending, so a reply cannot arrive ahead of its waiter.
  const request = async <T extends PeerType>(type: T, payload: PeerPayload<T>) => {
    const message = await compose(type, payload);
    const reply = waiting.wait(message.id);
    await transmit(message).catch((error: unknown) => waiting.fail(message.id, error));
    return reply;
  };
  const receive = async (frame: string) => {
    const message = await accepted(frame, deps, log);
    if (message) waiting.answer(message);
    return message;
  };
  return { send, request, receive, failAll: waiting.failAll };
}

export type PeerChannel = ReturnType<typeof createPeerChannel>;
