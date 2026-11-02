import * as v from "valibot";
import { IsoTimestampSchema, NonEmptyStringSchema } from "./common.ts";

/** The version of `~/.recnrun/service.json` and `service.lock`; a breaking change bumps it. */
export const SERVICE_STATE_SCHEMA_VERSION = 1;

/** An operating-system process id. */
export const PidSchema = v.pipe(v.number(), v.integer(), v.minValue(1));

/** A TCP port the service listens on. */
export const ServicePortSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535));

/** The bearer token of the local API: 32 to 128 URL-safe characters. */
export const ServiceTokenSchema = v.pipe(
  v.string(),
  v.regex(/^[\w-]{32,128}$/, "A service token has 32 to 128 URL-safe characters."),
);

/** `~/.recnrun/service.json` (mode 0600): how clients reach the running service. */
export const ServiceStateSchema = v.strictObject({
  schemaVersion: v.literal(SERVICE_STATE_SCHEMA_VERSION),
  pid: PidSchema,
  port: ServicePortSchema,
  token: ServiceTokenSchema,
  startedAt: IsoTimestampSchema,
  serviceVersion: NonEmptyStringSchema,
});

/** `~/.recnrun/service.lock`: one instance per user; `nonce` tells one claim from the next. */
export const ServiceLockSchema = v.strictObject({
  schemaVersion: v.literal(SERVICE_STATE_SCHEMA_VERSION),
  pid: PidSchema,
  nonce: NonEmptyStringSchema,
  createdAt: IsoTimestampSchema,
});

export type ServiceState = v.InferOutput<typeof ServiceStateSchema>;
export type ServiceLock = v.InferOutput<typeof ServiceLockSchema>;

export type ServiceFileParse<T> = { ok: true; value: T } | { ok: false; message: string };

const parseWith =
  <T>(schema: v.GenericSchema<unknown, T>) =>
  (input: unknown): ServiceFileParse<T> => {
    const parsed = v.safeParse(schema, input);
    if (parsed.success) return { ok: true, value: parsed.output };
    return { ok: false, message: v.summarize(parsed.issues) };
  };

/** Validates a parsed `service.json`, so persistence reads it without importing Valibot. */
export const parseServiceState = parseWith(ServiceStateSchema);

/** Validates a parsed `service.lock`, so persistence reads it without importing Valibot. */
export const parseServiceLock = parseWith(ServiceLockSchema);
