import * as v from "valibot";
import {
  RequestEnvelopeSchema,
  SERVICE_COMMANDS,
  type CommandName,
  type ResponseEnvelope,
  type ServiceError,
} from "@recnrun/protocol";

type Commands = typeof SERVICE_COMMANDS;

/** One handler per implemented command, typed by its protocol params and result. */
export type CommandHandlers = {
  [K in CommandName]?: (
    params: v.InferOutput<Commands[K]["params"]>,
  ) => Promise<v.InferOutput<Commands[K]["result"]>>;
};

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
): Promise<ResponseEnvelope> {
  const envelope = v.safeParse(RequestEnvelopeSchema, input);
  if (!envelope.success)
    return failure(requestIdOf(input), "invalid-request", v.summarize(envelope.issues));
  const { requestId, command, params } = envelope.output;
  const table: Partial<Record<CommandName, (params: never) => Promise<unknown>>> = handlers;
  const handler = table[command];
  if (handler === undefined)
    return failure(requestId, "capability-unavailable", `${command} is not available yet.`);
  const schemas: { params: v.GenericSchema; result: v.GenericSchema } = SERVICE_COMMANDS[command];
  const parsed = v.safeParse(schemas.params, params);
  if (!parsed.success)
    return failure(requestId, "invalid-request", `${command}: ${v.summarize(parsed.issues)}`);
  let result: unknown;
  try {
    result = await handler(parsed.output as never);
  } catch (error) {
    return failure(requestId, "internal", `${command} failed: ${describe(error)}`);
  }
  const checked = v.safeParse(schemas.result, result);
  if (!checked.success)
    return failure(requestId, "internal", `${command} returned ${v.summarize(checked.issues)}`);
  return { requestId, ok: true, result: checked.output };
}
