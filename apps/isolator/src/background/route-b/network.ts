import * as v from "valibot";
import type { Debuggee } from "@/background/probes/types";
import type { NetworkEntry } from "@/background/route-b/types";

// The Network events of a worker's session, as far as the `network` diagnostic reads them.
const SentSchema = v.object({ requestId: v.string(), request: v.object({ url: v.string() }) });
const ExtraInfoSchema = v.object({
  requestId: v.string(),
  clientSecurityState: v.optional(
    v.object({
      initiatorIPAddressSpace: v.optional(v.string()),
      localNetworkAccessRequestPolicy: v.optional(v.string()),
      privateNetworkRequestPolicy: v.optional(v.string()),
    }),
  ),
});
const FailedSchema = v.object({
  requestId: v.string(),
  errorText: v.string(),
  blockedReason: v.optional(v.string()),
  corsErrorStatus: v.optional(v.object({ corsError: v.string() })),
});

type Fields = Omit<NetworkEntry, "sessionId" | "requestId">;
type Reader = (params: unknown) => { requestId: string; fields: Fields } | undefined;

function read<const S extends v.GenericSchema<unknown, { requestId: string }>>(
  schema: S,
  fields: (event: v.InferOutput<S>) => Fields,
): Reader {
  return (params) => {
    const result = v.safeParse(schema, params);
    return result.success
      ? { requestId: result.output.requestId, fields: fields(result.output) }
      : undefined;
  };
}

/** The fields Chrome sent, without the ones it left out. */
function defined(fields: Fields): Fields {
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

const READERS: Record<string, Reader> = {
  "Network.requestWillBeSent": read(SentSchema, (event) => ({ url: event.request.url })),
  "Network.requestWillBeSentExtraInfo": read(ExtraInfoSchema, ({ clientSecurityState: state }) =>
    defined({
      initiatorIPAddressSpace: state?.initiatorIPAddressSpace,
      requestPolicy: state?.localNetworkAccessRequestPolicy ?? state?.privateNetworkRequestPolicy,
    }),
  ),
  "Network.loadingFailed": read(FailedSchema, (event) =>
    defined({
      errorText: event.errorText,
      blockedReason: event.blockedReason,
      corsError: event.corsErrorStatus?.corsError,
    }),
  ),
};

/** Requests of workers' sessions, merged by request id across the events Chrome sent for each. */
export class NetworkLog {
  #entries = new Map<string, NetworkEntry>();

  record(source: Debuggee, method: string, params: unknown): void {
    const read = source.sessionId === undefined ? undefined : READERS[method]?.(params);
    if (read === undefined || source.sessionId === undefined) return;
    const key = `${source.sessionId} ${read.requestId}`;
    const entry = this.#entries.get(key) ?? {
      sessionId: source.sessionId,
      requestId: read.requestId,
    };
    this.#entries.set(key, { ...entry, ...read.fields });
  }

  entries(): NetworkEntry[] {
    return [...this.#entries.values()].map((entry) => ({ ...entry }));
  }

  clear(): void {
    this.#entries.clear();
  }
}
