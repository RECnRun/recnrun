import * as v from "valibot";
import { OriginSchema } from "./origin-data.ts";
import { SkippedOriginSchema } from "./skipped-origin.ts";

/**
 * A cache entry a restore wrote as captured but without the type, URL, and redirect it was fetched
 * with: named by cache, method, and URL without its query, with the reason.
 */
const RebuiltEntrySchema = v.object({
  origin: OriginSchema,
  item: v.pipe(v.string(), v.nonEmpty()),
  reason: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});

export type RebuiltEntry = v.InferOutput<typeof RebuiltEntrySchema>;

/** A workspace operation as RECnRun records it while it runs and after it ends. */
export const WorkspaceOperationSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist([
    "start-with-identity",
    "switch",
    "suspend",
    "resume",
    "new-identity",
    "delete-identity",
  ]),
  step: v.string(),
  status: v.picklist(["running", "failed", "done"]),
  started: v.number(),
  generation: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  windowId: v.optional(v.number()),
  error: v.optional(v.string()),
  /** The visited origins the operation left out, each with its step. */
  skipped: v.optional(v.array(SkippedOriginSchema)),
  rebuilt: v.optional(v.array(RebuiltEntrySchema)),
});

export type WorkspaceOperation = v.InferOutput<typeof WorkspaceOperationSchema>;
