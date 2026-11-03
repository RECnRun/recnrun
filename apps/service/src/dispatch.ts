import * as v from "valibot";
import {
  RequestEnvelopeSchema,
  SERVICE_COMMANDS,
  type CommandName,
  type LeaseFence,
  type ResponseEnvelope,
  type ServiceError,
  type ServiceMessage,
} from "@recnrun/protocol";

type Commands = typeof SERVICE_COMMANDS;

/** A `/ws` channel a handler may push messages to until it closes. */
export interface PushChannel {
  push(message: ServiceMessage): void;
  onClose(listener: () => void): void;
}

/** What a handler knows about the request besides its params. */
export interface CallContext {
  /** The lease fence the envelope carried, for commands that act on a controlled target. */
  lease?: LeaseFence | undefined;
  /** Present only for requests that came over the WebSocket. */
  channel?: PushChannel | undefined;
}

/** One handler per implemented command, typed by its protocol params and result. */
export type CommandHandlers = {
  [K in CommandName]?: (
    params: v.InferOutput<Commands[K]["params"]>,
    call: CallContext,
  ) => Promise<v.InferOutput<Commands[K]["result"]>>;
};

/** A refusal a client can act on, answered with its own code instead of `internal`. */
export class ServiceFailure extends Error {
  readonly code: ServiceError["code"];

  constructor(code: ServiceError["code"], message: string) {
    super(message);
    this.name = "ServiceFailure";
    this.code = code;
  }
}

/** A request that cannot name its own id (malformed, or refused before its body was read). */
export const UNKNOWN_REQUEST_ID = "none";

export function failure(
  requestId: string,
  code: ServiceError["code"],
  message: string,
): ResponseEnvelope {
  return { requestId, ok: false, error: { code, message, retryable: code === "internal" } };
}

function requestIdOf(input: unknown): string {
  if (typeof input !== "object" || input === null || !("requestId" in input))
    return UNKNOWN_REQUEST_ID;
  const { requestId } = input;
  return typeof requestId === "string" && requestId !== "" ? requestId : UNKNOWN_REQUEST_ID;
}

const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Validates the envelope and the params, runs the handler, and validates its result. */
export async function dispatch(
  input: unknown,
  handlers: CommandHandlers,
  channel?: PushChannel,
): Promise<ResponseEnvelope> {
  const envelope = v.safeParse(RequestEnvelopeSchema, input);
  if (!envelope.success)
    return failure(requestIdOf(input), "invalid-request", v.summarize(envelope.issues));
  const { requestId, command, params, lease } = envelope.output;
  const table: Partial<
    Record<CommandName, (params: never, call: CallContext) => Promise<unknown>>
  > = handlers;
  const handler = table[command];
  if (handler === undefined)
    return failure(requestId, "capability-unavailable", `${command} is not available yet.`);
  const schemas: { params: v.GenericSchema; result: v.GenericSchema } = SERVICE_COMMANDS[command];
  const parsed = v.safeParse(schemas.params, params);
  if (!parsed.success)
    return failure(requestId, "invalid-request", `${command}: ${v.summarize(parsed.issues)}`);
  let result: unknown;
  try {
    result = await handler(parsed.output as never, { lease, channel });
  } catch (error) {
    if (error instanceof ServiceFailure) return failure(requestId, error.code, error.message);
    return failure(requestId, "internal", `${command} failed: ${describe(error)}`);
  }
  const checked = v.safeParse(schemas.result, result);
  if (!checked.success)
    return failure(requestId, "internal", `${command} returned ${v.summarize(checked.issues)}`);
  return { requestId, ok: true, result: checked.output };
}
