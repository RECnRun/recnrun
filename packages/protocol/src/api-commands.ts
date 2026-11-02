import * as v from "valibot";
import { AssertionStepSchema } from "./actions.ts";
import { ProfileBindingSchema } from "./bindings.ts";
import { CapabilityMatrixSchema } from "./capabilities.ts";
import { CountSchema, IdSchema, NameSchema, NonEmptyStringSchema } from "./common.ts";
import { DiscoveryResultSchema } from "./discovery.ts";
import { EventCategorySchema, EventSchema } from "./events.ts";
import { TargetSchema } from "./locators.ts";
import { RunSummarySchema } from "./run.ts";
import { LeaseSchema } from "./lease.ts";
import { PidSchema } from "./service-state.ts";
import {
  ControlStateSchema,
  PauseModeSchema,
  SessionPausesSchema,
  SessionStateSchema,
} from "./states.ts";
import { FlowValidationResultSchema } from "./validate.ts";
import { SchemaVersionSchema } from "./version.ts";

const NoParamsSchema = v.strictObject({});
const SessionRefSchema = v.strictObject({ sessionId: NonEmptyStringSchema });
const RunRefSchema = v.strictObject({ runId: NonEmptyStringSchema });
const SessionPauseSchema = v.strictObject({
  sessionId: NonEmptyStringSchema,
  mode: PauseModeSchema,
});

/** A session's state, who controls its target, each pause, and the lease when one is held. */
export const SessionStatusSchema = v.strictObject({
  sessionId: NonEmptyStringSchema,
  state: SessionStateSchema,
  control: ControlStateSchema,
  pauses: SessionPausesSchema,
  lease: v.optional(LeaseSchema),
});

export type SessionStatus = v.InferOutput<typeof SessionStatusSchema>;

const session = { params: SessionRefSchema, result: SessionStatusSchema };

// Shapes a later phase specifies; until then the service accepts and returns any JSON.
const unspecified = { params: v.unknown(), result: v.unknown() };

/** Params and result of every command of the service API and the MCP tools. */
export const SERVICE_COMMANDS = {
  "capabilities.get": { params: NoParamsSchema, result: CapabilityMatrixSchema },
  health: {
    params: NoParamsSchema,
    result: v.strictObject({
      status: v.literal("ok"),
      serviceVersion: NonEmptyStringSchema,
      protocolVersion: SchemaVersionSchema,
      pid: PidSchema,
      uptimeMs: CountSchema,
      // What `adapter.discover()` finds for the default Chrome profile right now.
      chrome: DiscoveryResultSchema,
    }),
  },
  "profiles.list": {
    params: NoParamsSchema,
    result: v.strictObject({ profiles: v.array(ProfileBindingSchema) }),
  },
  "session.start": {
    params: v.strictObject({
      flowId: v.optional(IdSchema),
      // Actor to the friendly name of a profile binding.
      actors: v.optional(v.record(NameSchema, NonEmptyStringSchema)),
    }),
    result: SessionStatusSchema,
  },
  "session.status": session,
  "session.handoff": {
    params: v.strictObject({ sessionId: NonEmptyStringSchema, to: ControlStateSchema }),
    result: SessionStatusSchema,
  },
  "session.pause": {
    params: SessionPauseSchema,
    result: SessionStatusSchema,
  },
  // Each pause resumes on its own.
  "session.resume": { params: SessionPauseSchema, result: SessionStatusSchema },
  "session.stop": session,
  // F5.1 defines the page inspection and the agent's action shapes.
  "browser.inspect": unspecified,
  "browser.act": unspecified,
  "flow.validate": {
    params: v.strictObject({ flow: v.unknown() }),
    result: FlowValidationResultSchema,
  },
  "flow.addAssertion": {
    params: v.strictObject({ sessionId: NonEmptyStringSchema, step: AssertionStepSchema }),
    result: v.strictObject({ stepId: IdSchema }),
  },
  "flow.finalize": {
    params: SessionRefSchema,
    result: v.strictObject({ flowId: IdSchema, revision: NonEmptyStringSchema }),
  },
  "flow.replay": {
    params: v.strictObject({
      flowId: IdSchema,
      dataset: v.optional(NonEmptyStringSchema),
      inputs: v.optional(v.record(NameSchema, v.unknown())),
    }),
    result: RunRefSchema,
  },
  "run.summary": { params: RunRefSchema, result: RunSummarySchema },
  "run.queryEvents": {
    params: v.strictObject({
      runId: NonEmptyStringSchema,
      category: v.optional(EventCategorySchema),
      stepId: v.optional(IdSchema),
      cursor: v.optional(NonEmptyStringSchema),
      limit: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000))),
    }),
    result: v.strictObject({
      events: v.array(EventSchema),
      nextCursor: v.optional(NonEmptyStringSchema),
    }),
  },
  // F3 defines artifact retrieval, F3.8 the comparison.
  "run.getArtifact": unspecified,
  "run.compare": unspecified,
  // F5.5 defines the reproducer folder.
  "issue.createReproducer": unspecified,
  "locators.validate": { params: v.strictObject({ target: TargetSchema }), result: v.unknown() },
  // F4A.1 and F4A.6 define previews; F4A.2 the function registry; F4A.6 macro extraction.
  "locators.preview": unspecified,
  "functions.list": unspecified,
  "functions.register": unspecified,
  "functions.validate": unspecified,
  "functions.test": unspecified,
  "functions.call": unspecified,
  "functions.proposeBuiltin": unspecified,
  "macros.extract": unspecified,
} as const;

export type CommandName = keyof typeof SERVICE_COMMANDS;

export const COMMAND_NAMES = Object.keys(SERVICE_COMMANDS) as CommandName[];
