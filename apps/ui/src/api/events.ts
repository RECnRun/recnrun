import { ServiceMessageSchema } from "@recnrun/protocol";
import type { PushMessage, PushType } from "@/api/commands";
import { check } from "@/api/schema";

export type Handler<T extends PushType> = (message: PushMessage<T>) => void;

export type Subscribe = <T extends PushType>(type: T, handler: Handler<T>) => () => void;

export type EventBus = { on: Subscribe; close: () => void };

type Socket = Pick<WebSocket, "send" | "close"> & {
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
};

type BusOptions = {
  url: string;
  connect?: (url: string) => Socket;
  retryMs?: number;
  maxRetryMs?: number;
};

/** Parses one frame; anything that is not a valid push message (such as a response envelope) is dropped. */
function parse(data: unknown): PushMessage<PushType> | undefined {
  if (typeof data !== "string") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(data);
  } catch {
    return undefined;
  }
  const checked = check(ServiceMessageSchema, value);
  return checked.ok ? checked.value : undefined;
}

/** Listens to the service's WebSocket and reconnects with backoff until closed. */
export function createEventBus(options: BusOptions): EventBus {
  const handlers = new Map<PushType, Set<(message: unknown) => void>>();
  const connect = options.connect ?? ((url: string) => new WebSocket(url));
  const retryMs = options.retryMs ?? 500;
  let delay = retryMs;
  let closed = false;
  let socket: Socket | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const open = () => {
    const current = connect(options.url);
    socket = current;
    current.onopen = () => {
      delay = retryMs;
      const subscribe = { requestId: crypto.randomUUID(), command: "events.subscribe", params: {} };
      current.send(JSON.stringify(subscribe));
    };
    current.onmessage = (event) => {
      const message = parse(event.data);
      if (message) handlers.get(message.type)?.forEach((handler) => handler(message));
    };
    current.onclose = () => {
      if (closed) return;
      timer = setTimeout(open, delay);
      delay = Math.min(delay * 2, options.maxRetryMs ?? 10_000);
    };
  };
  open();

  return {
    on: (type, handler) => {
      const set = handlers.get(type) ?? new Set();
      handlers.set(type, set);
      const entry = handler as (message: unknown) => void;
      set.add(entry);
      return () => set.delete(entry);
    },
    close: () => {
      closed = true;
      clearTimeout(timer);
      socket?.close();
    },
  };
}
