import * as v from "valibot";
import { SessionStatusSchema } from "./api-commands.ts";
import { CapturedEventSchema, DomTargetSchema } from "./capture.ts";
import { NonEmptyStringSchema } from "./common.ts";
import { EventSchema } from "./events.ts";
import { LocatorListSchema } from "./locators.ts";
import { RunSummarySchema } from "./run.ts";

const sessionId = NonEmptyStringSchema;
const runId = NonEmptyStringSchema;

/** What the service pushes on a `/ws` channel after `events.subscribe`; replies carry `requestId` instead. */
export const ServiceMessageSchema = v.variant("type", [
  v.strictObject({ type: v.literal("session.event"), sessionId, event: CapturedEventSchema }),
  v.strictObject({ type: v.literal("session.status"), sessionId, status: SessionStatusSchema }),
  v.strictObject({
    type: v.literal("picker.picked"),
    sessionId,
    target: DomTargetSchema,
    locators: LocatorListSchema,
  }),
  v.strictObject({ type: v.literal("run.step"), runId, event: EventSchema }),
  v.strictObject({ type: v.literal("run.finished"), runId, summary: RunSummarySchema }),
]);

export type ServiceMessage = v.InferOutput<typeof ServiceMessageSchema>;
