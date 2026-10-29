import { OriginDataSchema } from "@recnrun/domain";
import * as v from "valibot";

/** The name of the port the origin agent opens to the background. */
export const ORIGIN_AGENT_PORT = "recnrun-origin-agent";

/**
 * The type a barrier document commits as: a `text/*` type Chrome renders as plain text
 * (mime_util.cc `IsSupportedNonImageMimeType`, document_init.cc:209-211), which no site serves, so
 * the agent tells its barrier document from a page of the origin in another tab.
 */
export const BARRIER_DOCUMENT_TYPE = "text/x-recnrun-barrier";

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** Every command and reply names its operation, so a late one from an older operation is dropped. */
const OPERATION = {
  operationId: v.pipe(v.string(), v.nonEmpty()),
  generation: CountSchema,
};

/**
 * What a command reads or writes: all of the origin's storage, or only the sessionStorage of the
 * agent's own tab, which no other tab shares.
 */
const ScopeSchema = v.optional(v.picklist(["origin", "session"]), "origin");

export type StorageScope = v.InferOutput<typeof ScopeSchema>;

/** The background asks the agent to restore one origin's data into its page. */
const OriginRestoreCommandSchema = v.object({
  type: v.literal("restore"),
  ...OPERATION,
  scope: ScopeSchema,
  payload: OriginDataSchema,
});

/** The background asks the agent to read its page's IndexedDB, `chunk` records per message. */
const OriginCaptureCommandSchema = v.object({
  type: v.literal("capture"),
  ...OPERATION,
  scope: ScopeSchema,
  chunk: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(10_000)), 500),
});

/**
 * The first message on every link: a `Date` the agent echoes. Anything else coming back means
 * messages lose their structured types, so the background sends no payload and trusts no value.
 */
export const OriginProbeSchema = v.object({
  type: v.literal("probe"),
  ...OPERATION,
  probe: v.unknown(),
});

/** After the probe, the agent acts on one command only, of the probe's operation. */
export const OriginCommandSchema = v.variant("type", [
  OriginRestoreCommandSchema,
  OriginCaptureCommandSchema,
]);

export type OriginCommand = v.InferOutput<typeof OriginCommandSchema>;

const DatabaseSchema = OriginDataSchema.entries.indexedDB.item;
const StoreRecordsSchema = DatabaseSchema.entries.stores.item.entries.records;
const CacheSchema = OriginDataSchema.entries.caches.wrapped.item;

/** A cache entry a capture met and could not keep: which one, and why, never its body. */
const UnsupportedEntrySchema = v.object({
  item: v.string(),
  reason: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
});

export type UnsupportedEntry = v.InferOutput<typeof UnsupportedEntrySchema>;

/** What a capture sent and a restore wrote: Web Storage entries, databases, records, and caches. */
const CountsSchema = v.object({
  localStorage: CountSchema,
  sessionStorage: CountSchema,
  databases: CountSchema,
  records: CountSchema,
  caches: CountSchema,
  cacheEntries: CountSchema,
});

export type CapturedCounts = v.InferOutput<typeof CountsSchema>;

/** What a capture's last reply reports: its counts and the names of the page's cookies. */
export interface CapturedPage {
  counts: CapturedCounts;
  cookieNames: string[];
}

export type RestoredCounts = v.InferOutput<typeof CountsSchema>;

/**
 * The agent's answers: the probe's echo; restore counts; a capture's Web Storage, schemas, records,
 * caches, and counts; or a failed step and an error name, never a stored value.
 */
export const OriginReplySchema = v.variant("type", [
  v.object({ type: v.literal("probe-echo"), ...OPERATION, probe: v.unknown() }),
  v.object({ type: v.literal("restored"), ...OPERATION, counts: CountsSchema }),
  // Web Storage comes first; a database's schema comes before its records, which travel apart.
  v.object({
    type: v.literal("capture-storage"),
    ...OPERATION,
    localStorage: OriginDataSchema.entries.localStorage,
    sessionStorage: OriginDataSchema.entries.sessionStorage,
  }),
  v.object({ type: v.literal("capture-database"), ...OPERATION, database: DatabaseSchema }),
  v.object({
    type: v.literal("capture-records"),
    ...OPERATION,
    database: v.string(),
    store: v.string(),
    records: StoreRecordsSchema,
  }),
  // One message per cache, with the entries no `Response` can rebuild named apart.
  v.object({
    type: v.literal("capture-cache"),
    ...OPERATION,
    cache: CacheSchema,
    unsupported: v.array(UnsupportedEntrySchema),
  }),
  // The names in the page's `document.cookie`, never a value, so the background can tell a cookie
  // Chrome did not list it from one the page never had.
  v.object({
    type: v.literal("captured"),
    ...OPERATION,
    counts: CountsSchema,
    cookieNames: v.array(v.string()),
  }),
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
