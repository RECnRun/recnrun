import * as v from "valibot";
import { IdSchema, NameSchema } from "./ids.ts";
import { TagsSchema } from "./tag.ts";
import { TimestampSchema } from "./time.ts";

export const WorkflowStatusSchema = v.picklist(["recording", "stopped"]);

/** What a caller provides to start a workflow. */
export const WorkflowDraftSchema = v.object({
  title: NameSchema,
  description: v.optional(v.string()),
  tags: TagsSchema,
});

/** One recorded test scenario: steps are recorded while its status is `recording`. */
export const WorkflowSchema = v.object({
  ...WorkflowDraftSchema.entries,
  id: IdSchema,
  status: WorkflowStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});

export type WorkflowDraft = v.InferOutput<typeof WorkflowDraftSchema>;
export type Workflow = v.InferOutput<typeof WorkflowSchema>;
export type WorkflowStatus = v.InferOutput<typeof WorkflowStatusSchema>;

/** The recording of the caller's tab group, and the origins it still cannot record. */
export const RecordingStatusSchema = v.object({
  workflow: v.optional(WorkflowSchema),
  missingOrigins: v.array(v.string()),
});

export const StartResultSchema = v.variant("status", [
  v.object({ status: v.literal("recording"), workflow: WorkflowSchema }),
  v.object({ status: v.literal("permission-required"), origins: v.array(v.string()) }),
]);

export type RecordingStatus = v.InferOutput<typeof RecordingStatusSchema>;
export type StartResult = v.InferOutput<typeof StartResultSchema>;
