import { randomUUID } from "node:crypto";
import * as v from "valibot";
import {
  ResponseEnvelopeSchema,
  SERVICE_COMMANDS,
  type CommandName,
  type ServiceError,
} from "@recnrun/protocol";

type Commands = typeof SERVICE_COMMANDS;

/** Where a running service answers, as `startService` and `service.json` give it. */
export interface ServiceTarget {
  port: number;
  token: string;
}

/** A call that failed: the service's error code, or `unreachable` when no valid answer came. */
export class ServiceCallError extends Error {
  readonly code: ServiceError["code"] | "unreachable";
  readonly retryable: boolean;
  constructor(code: ServiceCallError["code"], message: string, retryable = false) {
    super(message);
    this.name = "ServiceCallError";
    this.code = code;
    this.retryable = retryable;
  }
}

export interface ServiceClient {
  /** Sends one command to `127.0.0.1` and returns its validated result. */
  call<K extends CommandName>(
    command: K,
    params: v.InferInput<Commands[K]["params"]>,
  ): Promise<v.InferOutput<Commands[K]["result"]>>;
}

async function post(target: ServiceTarget, body: unknown, timeoutMs: number): Promise<unknown> {
  try {
    const response = await fetch(`http://127.0.0.1:${target.port}/api`, {
      method: "POST",
      headers: { authorization: `Bearer ${target.token}`, "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return await response.json();
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new ServiceCallError(
      "unreachable",
      `The RECnRun service did not answer: ${detail}`,
      true,
    );
  }
}

/** A client of the local API that validates every answer with the protocol schemas. */
export function createServiceClient(target: ServiceTarget, timeoutMs = 30_000): ServiceClient {
  return {
    async call(command, params) {
      const json = await post(target, { requestId: randomUUID(), command, params }, timeoutMs);
      const envelope = v.safeParse(ResponseEnvelopeSchema, json);
      if (!envelope.success)
        throw new ServiceCallError("unreachable", "The service answered with an unknown shape.");
      if (!envelope.output.ok) {
        const { code, message, retryable } = envelope.output.error;
        throw new ServiceCallError(code, message, retryable);
      }
      const schema: v.GenericSchema = SERVICE_COMMANDS[command].result;
      const result = v.safeParse(schema, envelope.output.result);
      if (!result.success)
        throw new ServiceCallError("internal", `${command}: ${v.summarize(result.issues)}`);
      return result.output as never;
    },
  };
}
