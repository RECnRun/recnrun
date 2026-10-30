import * as v from "valibot";
import { IdSchema } from "./ids.ts";
import { TimestampSchema } from "./time.ts";

/** `user`: trusted DOM event; `page`: dispatched by page scripts; `browser`: recorded by the extension. */
export const StepAuthorSchema = v.picklist(["user", "page", "browser", "unknown"]);

/** What the recorder observes; the background adds the identity fields. */
export const StepDraftSchema = v.object({
  recordedAt: TimestampSchema,
  url: v.pipe(v.string(), v.url()),
  author: StepAuthorSchema,
  command: v.pipe(v.string(), v.nonEmpty()),
  selector: v.optional(v.string()),
  value: v.optional(v.string()),
});

export const StepSchema = v.object({
  ...StepDraftSchema.entries,
  id: IdSchema,
  workflowId: IdSchema,
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
});

export type StepAuthor = v.InferOutput<typeof StepAuthorSchema>;
export type StepDraft = v.InferOutput<typeof StepDraftSchema>;
export type Step = v.InferOutput<typeof StepSchema>;
