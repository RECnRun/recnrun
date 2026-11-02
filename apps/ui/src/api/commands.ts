import {
  FlowCatalogEntrySchema,
  FlowManifestSchema,
  FlowSchema,
  GapPayloadSchema,
  IdSchema,
  NonEmptyStringSchema,
  NormalizationResultSchema,
  RevisionHashSchema,
  SERVICE_COMMANDS,
  SessionStatusSchema,
  StepResultSchema,
  TargetSchema,
} from "@recnrun/protocol";
import { type Output, array, object, optional } from "@/api/schema";

const FlowRefSchema = object({ flowId: IdSchema });
const SessionRefSchema = object({ sessionId: NonEmptyStringSchema });
const NoParamsSchema = object({});

// Commands F2.6a adds to the service; each moves to SERVICE_COMMANDS when the protocol has it.
const PENDING_COMMANDS = {
  "flow.list": {
    params: NoParamsSchema,
    result: object({ flows: array(FlowCatalogEntrySchema) }),
  },
  "flow.get": {
    params: FlowRefSchema,
    result: object({ flow: FlowSchema, manifest: FlowManifestSchema }),
  },
  "flow.save": {
    params: object({ flowId: IdSchema, flow: FlowSchema }),
    result: object({ flowId: IdSchema, revision: RevisionHashSchema }),
  },
  "session.suggestions": { params: SessionRefSchema, result: NormalizationResultSchema },
  "picker.start": {
    params: object({ sessionId: optional(NonEmptyStringSchema) }),
    result: object({ pickerId: NonEmptyStringSchema }),
  },
  "picker.stop": { params: object({ pickerId: NonEmptyStringSchema }), result: NoParamsSchema },
} as const;

/** Every command the UI sends: the protocol's, plus the ones still pending in the service. */
export const UI_COMMANDS = { ...SERVICE_COMMANDS, ...PENDING_COMMANDS };

export type UiCommand = keyof typeof UI_COMMANDS;
export type Params<C extends UiCommand> = Output<(typeof UI_COMMANDS)[C]["params"]>;
export type Result<C extends UiCommand> = Output<(typeof UI_COMMANDS)[C]["result"]>;

/** Messages the service pushes over the WebSocket, keyed by their `type`. */
export const PUSH_MESSAGES = {
  "session.event": object({
    sessionId: NonEmptyStringSchema,
    status: optional(SessionStatusSchema),
    suggestions: optional(NormalizationResultSchema),
    gap: optional(GapPayloadSchema),
  }),
  "picker.picked": object({ pickerId: NonEmptyStringSchema, target: TargetSchema }),
  "run.step": object({ runId: NonEmptyStringSchema, result: StepResultSchema }),
  "run.finished": object({ runId: NonEmptyStringSchema }),
};

export type PushType = keyof typeof PUSH_MESSAGES;
export type PushMessage<T extends PushType> = Output<(typeof PUSH_MESSAGES)[T]>;
