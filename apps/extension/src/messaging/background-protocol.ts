import { isRequestType } from "@recnrun/bridge";
import type { RequestType } from "@recnrun/bridge";
import { RecordingStatusSchema, StepDraftSchema, StepSchema } from "@recnrun/domain";
import * as v from "valibot";

/** Control requests pages on the allowed origins may send with `chrome.runtime.sendMessage`. */
const EXTERNAL_REQUEST_TYPES = [
  "getRecordingStatus",
  "startWorkflow",
  "stopWorkflow",
  "resumeWorkflow",
] as const satisfies readonly RequestType[];

/** What the content script and the popup ask the background, which alone reads storage. */
const BackgroundRequestSchema = v.object({
  kind: v.literal("request"),
  type: v.custom<RequestType>(isRequestType),
  payload: v.optional(v.unknown()),
});

/** What the recorder reports from the user's applications. */
const StepReportSchema = v.object({
  kind: v.literal("step"),
  step: StepDraftSchema,
});

export const BackgroundMessageSchema = v.variant("kind", [
  BackgroundRequestSchema,
  StepReportSchema,
]);

export const ExternalRequestSchema = v.object({
  kind: v.literal("request"),
  type: v.picklist(EXTERNAL_REQUEST_TYPES),
  payload: v.optional(v.unknown()),
});

export const BackgroundReplySchema = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.unknown() }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);

/** Name of the long-lived port the content script opens to receive pushed events. */
export const TIMELINE_PORT = "timeline";

export const TimelineMessageSchema = v.variant("name", [
  v.object({ name: v.literal("stepRecorded"), data: StepSchema }),
  v.object({ name: v.literal("recordingChanged"), data: RecordingStatusSchema }),
]);

export type BackgroundReply = v.InferOutput<typeof BackgroundReplySchema>;
export type TimelineMessage = v.InferOutput<typeof TimelineMessageSchema>;
