import * as v from "valibot";

const PROTOCOL_VERSION = 1;

const envelope = {
  channel: v.literal("recnrun"),
  protocol: v.literal(PROTOCOL_VERSION),
};

/** Result schema per request type. A new request type starts here. */
export const RESULT_SCHEMAS = {
  ping: v.object({ extensionVersion: v.string() }),
} as const;

export type RequestType = keyof typeof RESULT_SCHEMAS;
export type RequestResult<T extends RequestType> = v.InferOutput<(typeof RESULT_SCHEMAS)[T]>;

const REQUEST_TYPES = Object.keys(RESULT_SCHEMAS) as RequestType[];

export const RequestSchema = v.object({
  ...envelope,
  kind: v.literal("request"),
  id: v.string(),
  type: v.picklist(REQUEST_TYPES),
});

export const ResponseSchema = v.variant("ok", [
  v.object({
    ...envelope,
    kind: v.literal("response"),
    id: v.string(),
    ok: v.literal(true),
    result: v.unknown(),
  }),
  v.object({
    ...envelope,
    kind: v.literal("response"),
    id: v.string(),
    ok: v.literal(false),
    error: v.string(),
  }),
]);

export const AnnounceSchema = v.object({
  ...envelope,
  kind: v.literal("announce"),
  extensionVersion: v.string(),
});

type Request = v.InferOutput<typeof RequestSchema>;
type Response = v.InferOutput<typeof ResponseSchema>;
type Announce = v.InferOutput<typeof AnnounceSchema>;

const header = { channel: "recnrun", protocol: PROTOCOL_VERSION } as const;

export const messages = {
  request: (id: string, type: RequestType): Request => ({ ...header, kind: "request", id, type }),
  success: (id: string, result: unknown): Response => ({
    ...header,
    kind: "response",
    id,
    ok: true,
    result,
  }),
  failure: (id: string, error: string): Response => ({
    ...header,
    kind: "response",
    id,
    ok: false,
    error,
  }),
  announce: (extensionVersion: string): Announce => ({
    ...header,
    kind: "announce",
    extensionVersion,
  }),
};

export function isRequestType(value: unknown): value is RequestType {
  return (REQUEST_TYPES as unknown[]).includes(value);
}
