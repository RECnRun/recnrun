import * as v from "valibot";
import { ORIGIN_AGENT_PORT } from "@/messaging/origin-protocol";
import type { OriginPort } from "@/messaging/origin-protocol";

type ConnectListener = (port: OriginPort) => void;
type MessageListener = (message: unknown) => void;

/** Chrome's `runtime.onConnect`, as far as the agent links use it. */
export interface ConnectEvent {
  addListener: (listener: ConnectListener) => void;
  removeListener: (listener: ConnectListener) => void;
}

/** What the test build reaches: turn the replay on, and count the replies it delivered. */
export interface StaleReplies {
  setActive: (active: boolean) => void;
  delivered: () => number;
}

const OperationSchema = v.looseObject({
  type: v.string(),
  operationId: v.string(),
  generation: v.number(),
});

type Operation = v.InferOutput<typeof OperationSchema>;

/** Every agent reply heard so far, the last of each type, and how many were replayed. */
interface Memory {
  replies: Map<string, Operation>;
  delivered: number;
}

/** An earlier operation's replies, as sent and aged to another generation of `command`'s. */
function staleFor(memory: Memory, command: unknown): Operation[] {
  const current = v.safeParse(OperationSchema, command);
  if (!current.success) return [];
  const { operationId, generation } = current.output;
  const aged = generation === 0 ? 1 : generation - 1;
  return [...memory.replies.values()]
    .filter((reply) => reply.operationId !== operationId)
    .flatMap((reply) => [reply, { ...reply, operationId, generation: aged }]);
}

/** The agent's port, but each command is followed, ahead of the agent's answer, by stale replies. */
function replaying(port: OriginPort, memory: Memory): OriginPort {
  const listeners = new Map<MessageListener, MessageListener>();
  const remember = (message: unknown) => {
    const reply = v.safeParse(OperationSchema, message);
    if (reply.success) memory.replies.set(reply.output.type, reply.output);
  };
  return {
    name: port.name,
    sender: port.sender,
    onDisconnect: port.onDisconnect,
    disconnect: () => port.disconnect(),
    onMessage: {
      addListener: (listener) => {
        const heard = (message: unknown) => {
          remember(message);
          listener(message);
        };
        listeners.set(listener, heard);
        port.onMessage.addListener(heard);
      },
      removeListener: (listener) => {
        port.onMessage.removeListener(listeners.get(listener) ?? listener);
        listeners.delete(listener);
      },
    },
    postMessage: (message) => {
      port.postMessage(message);
      const stale = staleFor(memory, message);
      // The agent answers over IPC, so a microtask always comes first.
      queueMicrotask(() => {
        for (const reply of stale) {
          for (const listener of listeners.keys()) listener(reply);
          memory.delivered += 1;
        }
      });
    },
  };
}

/**
 * Test builds only: while active, each agent link the background receives replays the replies of
 * an earlier operation ahead of the agent's own, so a test can prove the background drops them.
 */
export function replayStaleReplies(onConnect: ConnectEvent): StaleReplies {
  const memory: Memory = { replies: new Map(), delivered: 0 };
  let active = false;
  const add = onConnect.addListener.bind(onConnect);
  const remove = onConnect.removeListener.bind(onConnect);
  const wrapped = new Map<ConnectListener, ConnectListener>();
  // One link per port, since the watches tell a link they took by its identity.
  const links = new WeakMap<OriginPort, OriginPort>();
  const linkOf = (port: OriginPort) => {
    const link = links.get(port) ?? replaying(port, memory);
    links.set(port, link);
    return link;
  };
  onConnect.addListener = (listener) => {
    const own: ConnectListener = (port) =>
      listener(active && port.name === ORIGIN_AGENT_PORT ? linkOf(port) : port);
    wrapped.set(listener, own);
    add(own);
  };
  onConnect.removeListener = (listener) => {
    remove(wrapped.get(listener) ?? listener);
    wrapped.delete(listener);
  };
  return {
    setActive: (on) => {
      active = on;
    },
    delivered: () => memory.delivered,
  };
}
