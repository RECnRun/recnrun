import * as v from "valibot";
import type { RawSocket } from "./raw-cdp.ts";

/** A CDP event; `sessionId` names the flattened child session, absent for the browser's own. */
export interface CdpEvent {
  method: string;
  params: Record<string, unknown>;
  sessionId?: string;
}

/** A browser-level CDP client that reaches child sessions by `sessionId` (flatten mode). */
export interface CdpChannel {
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  onEvent(listener: (event: CdpEvent) => void): void;
  close(): void;
}

const MessageSchema = v.object({
  id: v.optional(v.number()),
  result: v.optional(v.unknown()),
  error: v.optional(v.object({ message: v.string() })),
  method: v.optional(v.string()),
  params: v.optional(v.record(v.string(), v.unknown())),
  sessionId: v.optional(v.string()),
});

type Message = v.InferOutput<typeof MessageSchema>;

interface Pending {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
}

function parseMessage(data: unknown): Message | undefined {
  try {
    const parsed = v.safeParse(MessageSchema, JSON.parse(String(data)));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

function settle(pending: Pending, message: Message): void {
  if (message.error)
    pending.reject(new Error(`${pending.method} failed: ${message.error.message}`));
  else pending.resolve(message.result ?? {});
}

/** Wraps an open socket; every reply settles its command, and the socket closing rejects the rest. */
function cdpChannel(socket: RawSocket, endpoint: string): CdpChannel {
  const pending = new Map<number, Pending>();
  const listeners: ((event: CdpEvent) => void)[] = [];
  let lastId = 0;
  let closed = false;
  const fail = () => {
    closed = true;
    for (const each of pending.values())
      each.reject(new Error(`CDP socket to ${endpoint} closed.`));
    pending.clear();
  };
  socket.addEventListener("close", fail);
  socket.addEventListener("error", fail);
  socket.addEventListener("message", ({ data }) => {
    const message = parseMessage(data);
    if (message?.id !== undefined) {
      const waiting = pending.get(message.id);
      pending.delete(message.id);
      if (waiting) settle(waiting, message);
    } else if (message?.method) {
      const event: CdpEvent = { method: message.method, params: message.params ?? {} };
      if (message.sessionId) event.sessionId = message.sessionId;
      for (const listener of listeners) listener(event);
    }
  });
  return {
    send: (method, params = {}, sessionId) =>
      new Promise((resolve, reject) => {
        if (closed) {
          reject(new Error(`CDP socket to ${endpoint} closed.`));
          return;
        }
        lastId += 1;
        pending.set(lastId, { method, resolve, reject });
        socket.send(
          JSON.stringify({ id: lastId, method, params, ...(sessionId && { sessionId }) }),
        );
      }),
    onEvent: (listener) => listeners.push(listener),
    close: () => {
      fail();
      socket.close();
    },
  };
}

/** Opens a browser-level CDP WebSocket of our own (Node's global WebSocket). */
export function openCdpChannel(
  endpoint: string,
  createSocket: (url: string) => RawSocket = (url) => new WebSocket(url),
): Promise<CdpChannel> {
  return new Promise((resolve, reject) => {
    const socket = createSocket(endpoint);
    const refuse = () => reject(new Error(`No CDP endpoint answered at ${endpoint}.`));
    socket.addEventListener("error", refuse);
    socket.addEventListener("open", () => resolve(cdpChannel(socket, endpoint)));
  });
}
