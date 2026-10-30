import * as v from "valibot";
import {
  AnnounceSchema,
  EVENTS,
  EventSchema,
  messages,
  REQUESTS,
  ResponseSchema,
} from "./protocol.ts";
import type {
  EventData,
  EventName,
  RequestPayload,
  RequestResult,
  RequestType,
} from "./protocol.ts";
import type { Transport } from "./transport.ts";

export type Detection = { status: "installed"; extensionVersion: string } | { status: "missing" };

/** The payload argument is optional only for request types that accept no payload. */
type PayloadArgs<T extends RequestType> =
  undefined extends RequestPayload<T>
    ? [payload?: RequestPayload<T>]
    : [payload: RequestPayload<T>];

export interface BridgeClient {
  detect(): Promise<Detection>;
  request<T extends RequestType>(type: T, ...args: PayloadArgs<T>): Promise<RequestResult<T>>;
  subscribe<N extends EventName>(name: N, listener: (data: EventData<N>) => void): () => void;
}

interface BridgeClientOptions {
  timeoutMs?: number;
  createId?: () => string;
}

export class BridgeError extends Error {
  override name = "BridgeError";
}

const DEFAULT_TIMEOUT_MS = 1500;

function waitFor<T>(
  transport: Transport,
  timeoutMs: number,
  match: (message: unknown) => T | undefined,
  what: string,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      stop();
      reject(new BridgeError(`Timed out waiting for ${what}.`));
    }, timeoutMs);
    const stop = transport.subscribe((message) => {
      const value = match(message);
      if (value === undefined) return;
      clearTimeout(timer);
      stop();
      resolve(value);
    });
  });
}

function responseTo(id: string) {
  return (message: unknown) => {
    const parsed = v.safeParse(ResponseSchema, message);
    return parsed.success && parsed.output.id === id ? parsed.output : undefined;
  };
}

function subscribeTo<N extends EventName>(
  transport: Transport,
  name: N,
  listener: (data: EventData<N>) => void,
): () => void {
  return transport.subscribe((message) => {
    const parsed = v.safeParse(EventSchema, message);
    if (!parsed.success || parsed.output.name !== name) return;
    const data = v.safeParse(EVENTS[name], parsed.output.data);
    if (data.success) listener(data.output as EventData<N>);
  });
}

export function createBridgeClient(
  transport: Transport,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    createId = () => crypto.randomUUID(),
  }: BridgeClientOptions = {},
): BridgeClient {
  async function request<T extends RequestType>(
    type: T,
    ...[payload]: PayloadArgs<T>
  ): Promise<RequestResult<T>> {
    const id = createId();
    const reply = waitFor(transport, timeoutMs, responseTo(id), `the ${type} response`);
    transport.send(messages.request(id, type, payload));
    const response = await reply;
    if (!response.ok) throw new BridgeError(response.error);
    const result = v.safeParse(REQUESTS[type].result, response.result);
    if (!result.success) throw new BridgeError(`The extension sent an invalid ${type} result.`);
    return result.output as RequestResult<T>;
  }

  async function detect(): Promise<Detection> {
    const announced = waitFor(
      transport,
      timeoutMs,
      (message) => {
        const parsed = v.safeParse(AnnounceSchema, message);
        return parsed.success ? parsed.output.extensionVersion : undefined;
      },
      "the extension announcement",
    );
    const pinged = request("ping").then((result) => result.extensionVersion);
    try {
      return { status: "installed", extensionVersion: await Promise.any([announced, pinged]) };
    } catch {
      return { status: "missing" };
    }
  }

  return {
    detect,
    request,
    subscribe: (name, listener) => subscribeTo(transport, name, listener),
  };
}
