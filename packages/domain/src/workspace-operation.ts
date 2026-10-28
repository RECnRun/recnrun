import * as v from "valibot";

/** A workspace operation as RECnRun records it while it runs and after it ends. */
export const WorkspaceOperationSchema = v.object({
  id: v.pipe(v.string(), v.minLength(1)),
  kind: v.picklist(["start-with-identity"]),
  step: v.string(),
  status: v.picklist(["running", "failed", "done"]),
  started: v.number(),
  generation: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0))),
  windowId: v.optional(v.number()),
  error: v.optional(v.string()),
});

export type WorkspaceOperation = v.InferOutput<typeof WorkspaceOperationSchema>;
