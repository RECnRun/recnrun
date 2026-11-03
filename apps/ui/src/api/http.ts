import { type LeaseFence, ResponseEnvelopeSchema } from "@recnrun/protocol";
import { type Params, type Result, UI_COMMANDS, type UiCommand } from "@/api/commands";
import { ApiError } from "@/api/error";
import { check } from "@/api/schema";

export type CallOptions = { lease?: LeaseFence | undefined };

export type Call = <C extends UiCommand>(
  command: C,
  params: Params<C>,
  options?: CallOptions,
) => Promise<Result<C>>;

type HttpOptions = { token: string; endpoint?: string; fetch?: typeof globalThis.fetch };

async function post(options: HttpOptions, body: unknown): Promise<unknown> {
  const send = options.fetch ?? globalThis.fetch.bind(globalThis);
  let response: Response;
  try {
    response = await send(options.endpoint ?? "/api", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${options.token}` },
      body: JSON.stringify(body),
    });
  } catch (error) {
    throw new ApiError("unreachable", `The service did not answer: ${String(error)}`);
  }
  // Anything but JSON (a 404 page, an empty body) means this service is not the one answering.
  const answer: unknown = await response.json().catch(() => undefined);
  if (answer === undefined)
    throw new ApiError("unreachable", `No service answered at /api (HTTP ${response.status}).`);
  return answer;
}

function invalid(command: string, message: string): ApiError {
  return new ApiError(
    "invalid-response",
    `The service answered ${command} unexpectedly: ${message}`,
  );
}

/** Sends commands as `POST /api` envelopes with the bearer token; params and results are validated. */
export function createCall(options: HttpOptions): Call {
  return async (command, params, callOptions) => {
    const spec = UI_COMMANDS[command];
    const checkedParams = check(spec.params, params);
    if (!checkedParams.ok) {
      throw new ApiError("invalid-request", `Invalid ${command} params: ${checkedParams.message}`);
    }
    const lease = callOptions?.lease;
    const body = await post(options, {
      requestId: crypto.randomUUID(),
      command,
      params: checkedParams.value,
      ...(lease ? { lease: { leaseId: lease.leaseId, fencingToken: lease.fencingToken } } : {}),
    });
    const envelope = check(ResponseEnvelopeSchema, body);
    if (!envelope.ok) throw invalid(command, envelope.message);
    if (!envelope.value.ok)
      throw new ApiError(envelope.value.error.code, envelope.value.error.message);
    const result = check(spec.result, envelope.value.result);
    if (!result.ok) throw invalid(command, result.message);
    return result.value as Result<typeof command>;
  };
}
