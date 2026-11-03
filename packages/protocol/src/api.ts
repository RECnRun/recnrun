import * as v from "valibot";
import { COMMAND_NAMES } from "./api-commands.ts";
import { NonEmptyStringSchema } from "./common.ts";
import { LeaseFenceSchema } from "./lease.ts";

/** Every request: `requestId` makes it idempotent; controlled commands carry the caller's lease fence. */
export const RequestEnvelopeSchema = v.strictObject({
  requestId: NonEmptyStringSchema,
  command: v.picklist(COMMAND_NAMES),
  // Validated per command with SERVICE_COMMANDS[command].params.
  params: v.unknown(),
  lease: v.optional(LeaseFenceSchema),
});

export const ERROR_CODES = [
  "invalid-request",
  "unauthorized",
  "forbidden",
  "not-found",
  "conflict",
  "stale-lease",
  "capability-unavailable",
  "step-failed",
  "timeout",
  "internal",
] as const;

/** An error a client can act on: what failed, where, whether to retry, and what to try instead. */
export const ServiceErrorSchema = v.strictObject({
  code: v.picklist(ERROR_CODES),
  message: NonEmptyStringSchema,
  step: v.optional(NonEmptyStringSchema),
  capability: v.optional(NonEmptyStringSchema),
  retryable: v.boolean(),
  evidence: v.optional(v.array(NonEmptyStringSchema)),
  alternative: v.optional(NonEmptyStringSchema),
});

export const ResponseEnvelopeSchema = v.variant("ok", [
  v.strictObject({ requestId: NonEmptyStringSchema, ok: v.literal(true), result: v.unknown() }),
  v.strictObject({
    requestId: NonEmptyStringSchema,
    ok: v.literal(false),
    error: ServiceErrorSchema,
  }),
]);

export type RequestEnvelope = v.InferOutput<typeof RequestEnvelopeSchema>;
export type ResponseEnvelope = v.InferOutput<typeof ResponseEnvelopeSchema>;
export type ServiceError = v.InferOutput<typeof ServiceErrorSchema>;
