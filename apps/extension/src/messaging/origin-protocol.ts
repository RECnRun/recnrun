import { OriginDataSchema } from "@recnrun/domain";
import * as v from "valibot";

/** The name of the port the origin agent opens to the background. */
export const ORIGIN_AGENT_PORT = "recnrun-origin-agent";

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Every command and reply names its operation, so a late one from an older operation is dropped. */
const OPERATION = {
  operationId: v.pipe(v.string(), v.nonEmpty()),
  generation: CountSchema,
};

/** The background asks the agent to restore one origin's data into its page. */
const OriginRestoreCommandSchema = v.object({
  type: v.literal("restore"),
  ...OPERATION,
  payload: OriginDataSchema,
});

/** The background asks the agent to read its page's IndexedDB, `chunk` records per message. */
const OriginCaptureCommandSchema = v.object({
  type: v.literal("capture"),
  ...OPERATION,
  chunk: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)), 500),
});

/** The agent acts on one command only, the first it gets. */
export const OriginCommandSchema = v.variant("type", [
  OriginRestoreCommandSchema,
  OriginCaptureCommandSchema,
]);

export type OriginCommand = v.InferOutput<typeof OriginCommandSchema>;

const DatabaseSchema = OriginDataSchema.entries.indexedDB.item;
const StoreRecordsSchema = DatabaseSchema.entries.stores.item.entries.records;

const CapturedCountsSchema = v.object({ databases: CountSchema, records: CountSchema });

export type CapturedCounts = v.InferOutput<typeof CapturedCountsSchema>;

const RestoredCountsSchema = v.object({
  localStorage: CountSchema,
  sessionStorage: CountSchema,
  databases: CountSchema,
  records: CountSchema,
});

export type RestoredCounts = v.InferOutput<typeof RestoredCountsSchema>;

/**
 * The agent's answers: restore counts; a capture's schemas, records, and counts; or a failed step
 * and an error name, never a stored value.
 */
export const OriginReplySchema = v.variant("type", [
  v.object({ type: v.literal("restored"), ...OPERATION, counts: RestoredCountsSchema }),
  // A database's schema comes before its records, and its stores carry no records of their own.
  v.object({ type: v.literal("capture-database"), ...OPERATION, database: DatabaseSchema }),
  v.object({
    type: v.literal("capture-records"),
    ...OPERATION,
    database: v.string(),
    store: v.string(),
    records: StoreRecordsSchema,
  }),
  v.object({ type: v.literal("captured"), ...OPERATION, counts: CapturedCountsSchema }),
  v.object({
    type: v.literal("failed"),
    ...OPERATION,
    error: v.pipe(v.string(), v.maxLength(200)),
  }),
]);

export type OriginReply = v.InferOutput<typeof OriginReplySchema>;

/** Who opened a port, as Chrome reports it to the background. */
export interface OriginSender {
  tab?: { id?: number };
  frameId?: number;
  documentId?: string;
  origin?: string;
}

interface PortEvent<A extends unknown[]> {
  addListener: (listener: (...args: A) => void) => void;
  removeListener: (listener: (...args: A) => void) => void;
}

/** The part of a `runtime.Port` the agent and the background use. */
export interface OriginPort {
  name: string;
  sender?: OriginSender;
  postMessage: (message: unknown) => void;
  disconnect: () => void;
  onMessage: PortEvent<[unknown]>;
  onDisconnect: PortEvent<[]>;
}
