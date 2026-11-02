import * as v from "valibot";
import { BindingNameSchema } from "./bindings.ts";
import { CountSchema, NonEmptyStringSchema } from "./common.ts";
import { DiscoveryResultSchema } from "./discovery.ts";
import { SchemaVersionSchema } from "./version.ts";

/** What `DevToolsActivePort` says: absent, unreadable, pointing at a dead port, or usable. */
export const REMOTE_DEBUGGING_STATES = ["found", "not-found", "malformed", "stale"] as const;

/** `recnrun doctor --json`: the state of the machine as RECnRun needs it. */
export const DoctorReportSchema = v.strictObject({
  schemaVersion: SchemaVersionSchema,
  // True when Chrome was found through its DevToolsActivePort.
  ok: v.boolean(),
  node: v.strictObject({
    version: NonEmptyStringSchema,
    required: NonEmptyStringSchema,
    satisfies: v.boolean(),
  }),
  chrome: DiscoveryResultSchema,
  remoteDebugging: v.strictObject({
    state: v.picklist(REMOTE_DEBUGGING_STATES),
    path: v.optional(NonEmptyStringSchema),
  }),
  bindings: v.strictObject({
    path: NonEmptyStringSchema,
    count: CountSchema,
    // Names of the bindings that no longer match the Chrome found now.
    stale: v.array(BindingNameSchema),
    // Why bindings.json could not be read, when it could not.
    error: v.optional(NonEmptyStringSchema),
  }),
  disk: v.strictObject({
    path: NonEmptyStringSchema,
    freeBytes: CountSchema,
    totalBytes: CountSchema,
  }),
  versions: v.strictObject({
    cli: NonEmptyStringSchema,
    service: NonEmptyStringSchema,
    protocol: SchemaVersionSchema,
  }),
});

export type DoctorReport = v.InferOutput<typeof DoctorReportSchema>;

/** Validates a doctor report, so the CLI checks it without importing Valibot. */
export function parseDoctorReport(
  input: unknown,
): { ok: true; value: DoctorReport } | { ok: false; message: string } {
  const parsed = v.safeParse(DoctorReportSchema, input);
  if (parsed.success) return { ok: true, value: parsed.output };
  return { ok: false, message: v.summarize(parsed.issues) };
}
