import * as v from "valibot";
import { AnnounceSchema, messages, RESULT_SCHEMAS, ResponseSchema } from "./protocol.ts";
import type { RequestResult, RequestType } from "./protocol.ts";
import type { Transport } from "./transport.ts";

export type Detection = { status: "installed"; extensionVersion: string } | { status: "missing" };

export interface BridgeClient {
  detect(): Promise<Detection>;
  request<T extends RequestType>(type: T): Promise<RequestResult<T>>;
}

interface BridgeClientOptions {
  timeoutMs?: number;
  createId?: () => string;
}

export class BridgeError extends Error {
  override name = "BridgeError";
}

const DEFAULT_TIMEOUT_MS = 1500;

export function createBridgeClient(
  transport: Transport,
  {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    createId = () => crypto.randomUUID(),
  }: BridgeClientOptions = {},
): BridgeClient {
  function waitFor<T>(match: (message: unknown) => T | undefined, what: string): Promise<T> {
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

  async function request<T extends RequestType>(type: T): Promise<RequestResult<T>> {
    const id = createId();
    const reply = waitFor((message) => {
      const parsed = v.safeParse(ResponseSchema, message);
      return parsed.success && parsed.output.id === id ? parsed.output : undefined;
    }, `the ${type} response`);
    transport.send(messages.request(id, type));
    const response = await reply;
    if (!response.ok) throw new BridgeError(response.error);
    const result = v.safeParse(RESULT_SCHEMAS[type], response.result);
    if (!result.success) throw new BridgeError(`The extension sent an invalid ${type} result.`);
    return result.output;
  }

  async function detect(): Promise<Detection> {
    const announced = waitFor((message) => {
      const parsed = v.safeParse(AnnounceSchema, message);
      return parsed.success ? parsed.output.extensionVersion : undefined;
    }, "the extension announcement");
    const pinged = request("ping").then((result) => result.extensionVersion);
    try {
      return { status: "installed", extensionVersion: await Promise.any([announced, pinged]) };
    } catch {
      return { status: "missing" };
    }
  }

  return { detect, request };
}
