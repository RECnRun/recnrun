import {
  IdSchema,
  RecordingStatusSchema,
  SnapshotSchema,
  StartResultSchema,
  StepSchema,
  WorkflowDraftSchema,
  WorkflowSchema,
} from "@recnrun/domain";
import * as v from "valibot";

const PROTOCOL_VERSION = 1;

const envelope = {
  channel: v.literal("recnrun"),
  protocol: v.literal(PROTOCOL_VERSION),
};

const NoPayload = v.optional(v.undefined());
const ById = v.object({ id: IdSchema });

/** Payload and result schema per request type. A new request type starts here. */
export const REQUESTS = {
  ping: { payload: NoPayload, result: v.object({ extensionVersion: v.string() }) },
  getSnapshot: { payload: NoPayload, result: SnapshotSchema },
  getRecordingStatus: { payload: NoPayload, result: RecordingStatusSchema },
  startWorkflow: {
    payload: v.object({
      ...WorkflowDraftSchema.entries,
      url: v.optional(v.pipe(v.string(), v.url())),
    }),
    result: StartResultSchema,
  },
  stopWorkflow: {
    payload: v.optional(v.object({ id: v.optional(IdSchema) })),
    result: WorkflowSchema,
  },
  resumeWorkflow: { payload: ById, result: StartResultSchema },
  grantOrigins: {
    payload: v.object({ origins: v.array(v.string()) }),
    result: v.object({ granted: v.boolean() }),
  },
  listWorkflows: { payload: NoPayload, result: v.array(WorkflowSchema) },
  listSteps: { payload: v.object({ workflowId: IdSchema }), result: v.array(StepSchema) },
  deleteWorkflow: { payload: ById, result: v.object({ deleted: v.literal(true) }) },
} as const;

/** Data schema per event the extension pushes to the page. */
export const EVENTS = {
  stepRecorded: StepSchema,
  recordingChanged: RecordingStatusSchema,
} as const;

export type RequestType = keyof typeof REQUESTS;
export type RequestPayload<T extends RequestType> = v.InferOutput<(typeof REQUESTS)[T]["payload"]>;
export type RequestResult<T extends RequestType> = v.InferOutput<(typeof REQUESTS)[T]["result"]>;
export type EventName = keyof typeof EVENTS;
export type EventData<N extends EventName> = v.InferOutput<(typeof EVENTS)[N]>;

const REQUEST_TYPES = Object.keys(REQUESTS) as RequestType[];
const EVENT_NAMES = Object.keys(EVENTS) as EventName[];

export const RequestSchema = v.object({
  ...envelope,
  kind: v.literal("request"),
  id: v.string(),
  type: v.picklist(REQUEST_TYPES),
  payload: v.optional(v.unknown()),
});

export const ResponseSchema = v.variant("ok", [
  v.object({
    ...envelope,
    kind: v.literal("response"),
    id: v.string(),
    ok: v.literal(true),
    result: v.unknown(),
  }),
  v.object({
    ...envelope,
    kind: v.literal("response"),
    id: v.string(),
    ok: v.literal(false),
    error: v.string(),
  }),
]);

export const AnnounceSchema = v.object({
  ...envelope,
  kind: v.literal("announce"),
  extensionVersion: v.string(),
});

export const EventSchema = v.object({
  ...envelope,
  kind: v.literal("event"),
  name: v.picklist(EVENT_NAMES),
  data: v.unknown(),
});

type Request = v.InferOutput<typeof RequestSchema>;
type Response = v.InferOutput<typeof ResponseSchema>;
type Announce = v.InferOutput<typeof AnnounceSchema>;
type Event = v.InferOutput<typeof EventSchema>;

const header = { channel: "recnrun", protocol: PROTOCOL_VERSION } as const;

export const messages = {
  request: (id: string, type: RequestType, payload?: unknown): Request =>
    payload === undefined
      ? { ...header, kind: "request", id, type }
      : { ...header, kind: "request", id, type, payload },
  success: (id: string, result: unknown): Response => ({
    ...header,
    kind: "response",
    id,
    ok: true,
    result,
  }),
  failure: (id: string, error: string): Response => ({
    ...header,
    kind: "response",
    id,
    ok: false,
    error,
  }),
  announce: (extensionVersion: string): Announce => ({
    ...header,
    kind: "announce",
    extensionVersion,
  }),
  event: (name: EventName, data: unknown): Event => ({ ...header, kind: "event", name, data }),
};

export function isRequestType(value: unknown): value is RequestType {
  return (REQUEST_TYPES as unknown[]).includes(value);
}
