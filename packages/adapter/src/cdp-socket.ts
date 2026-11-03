import * as v from "valibot";
import { assertLoopbackEndpoint } from "./loopback.ts";
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
  /** Called once if the socket closes or fails without `close()`: whatever it carried is cut off. */
  onClose(listener: () => void): void;
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

/** A reply settles its command; anything else with a method is an event for the listeners. */
function dispatch(
  data: unknown,
  pending: Map<number, Pending>,
  listeners: ((event: CdpEvent) => void)[],
): void {
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
}

/** Wraps an open socket; every reply settles its command, and the socket closing rejects the rest. */
function cdpChannel(socket: RawSocket, endpoint: string): CdpChannel {
  const pending = new Map<number, Pending>();
  const listeners: ((event: CdpEvent) => void)[] = [];
  const closeListeners: (() => void)[] = [];
  let lastId = 0;
  let closed = false;
  const fail = () => {
    closed = true;
    for (const each of pending.values())
      each.reject(new Error(`CDP socket to ${endpoint} closed.`));
    pending.clear();
  };
  // A socket that closes on its own cuts off what it carried; `close()` has already marked it closed.
  const lost = () => {
    const unexpected = !closed;
    fail();
    if (unexpected) for (const listener of closeListeners) listener();
  };
  socket.addEventListener("close", lost);
  socket.addEventListener("error", lost);
  socket.addEventListener("message", ({ data }) => dispatch(data, pending, listeners));
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
    onClose: (listener) => closeListeners.push(listener),
    close: () => {
      fail();
      socket.close();
    },
  };
}

export type CdpOpenFailure = "refused" | "closed-before-open" | "open-timeout";

/** The CDP socket did not open: nothing answered, it closed first, or it missed the deadline. */
export class CdpOpenError extends Error {
  readonly code: CdpOpenFailure;

  constructor(code: CdpOpenFailure, message: string) {
    super(message);
    this.name = "CdpOpenError";
    this.code = code;
  }
}

const DEFAULT_OPEN_TIMEOUT_MS = 5_000;

/** Opens a browser-level CDP WebSocket of our own (Node's global WebSocket) within a deadline. */
export function openCdpChannel(
  endpoint: string,
  createSocket: (url: string) => RawSocket = (url) => new WebSocket(url),
  openTimeoutMs = DEFAULT_OPEN_TIMEOUT_MS,
): Promise<CdpChannel> {
  return new Promise((resolve, reject) => {
    assertLoopbackEndpoint(endpoint);
    const socket = createSocket(endpoint);
    let opening = true;
    const fail = (code: CdpOpenFailure, message: string) => {
      if (!opening) return;
      opening = false;
      clearTimeout(timer);
      socket.close();
      reject(new CdpOpenError(code, message));
    };
    const timer = setTimeout(
      () => fail("open-timeout", `${endpoint} did not open within ${openTimeoutMs} ms.`),
      openTimeoutMs,
    );
    socket.addEventListener("error", () =>
      fail("refused", `No CDP endpoint answered at ${endpoint}.`),
    );
    socket.addEventListener("close", () =>
      fail("closed-before-open", `The CDP socket to ${endpoint} closed before it opened.`),
    );
    socket.addEventListener("open", () => {
      if (!opening) return;
      opening = false;
      clearTimeout(timer);
      resolve(cdpChannel(socket, endpoint));
    });
  });
}
