import * as v from "valibot";

/** The version every stored file and service message of this protocol carries. */
export const PROTOCOL_SCHEMA_VERSION = 1;

/** Accepts only the protocol version this build reads; a breaking change adds a migration. */
export const SchemaVersionSchema = v.literal(PROTOCOL_SCHEMA_VERSION);

export type SchemaVersion = v.InferOutput<typeof SchemaVersionSchema>;
