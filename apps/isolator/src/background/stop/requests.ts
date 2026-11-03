import * as v from "valibot";

// The harness calls the stop mechanisms through Runtime.evaluate, so every argument is checked where it enters.
const TargetId = v.pipe(v.string(), v.nonEmpty());
const TabId = v.pipe(v.number(), v.integer(), v.minValue(0));

const WorkerClose = v.strictObject({ targetId: TargetId, via: v.optional(v.literal("worker")) });
const TabClose = v.strictObject({ targetId: TargetId, via: v.literal("tab"), tabId: TabId });

export const CloseRequest = v.union([WorkerClose, TabClose]);
export const TargetRequest = v.strictObject({ targetId: TargetId });
export const TabRequest = v.strictObject({ tabId: TabId });

export const OriginRequest = v.strictObject({
  origin: v.pipe(
    v.string(),
    v.url(),
    v.check((value) => new URL(value).origin === value, "expected an origin"),
  ),
});

/** What a client of the worker can do to wake it, or ask about its registration. */
export const ClientRequest = v.variant("action", [
  v.strictObject({ tabId: TabId, action: v.literal("status") }),
  v.strictObject({ tabId: TabId, action: v.literal("post-message") }),
  v.strictObject({ tabId: TabId, action: v.literal("update") }),
  v.strictObject({
    tabId: TabId,
    action: v.literal("sync"),
    tag: v.pipe(v.string(), v.regex(/^[a-z0-9-]{1,64}$/)),
  }),
]);

export const WatchRequest = v.strictObject({ marker: v.optional(v.string()) });

export type ClientAction = v.InferOutput<typeof ClientRequest>;

/** The request as `schema` describes it, or an error that names what was wrong. */
export function parse<const Schema extends v.GenericSchema>(
  schema: Schema,
  request: unknown,
): v.InferOutput<Schema> {
  const result = v.safeParse(schema, request);
  if (result.success) return result.output;
  const issues = result.issues.map((issue) => issue.message).join("; ");
  throw new Error(`invalid request ${JSON.stringify(request)}: ${issues}`);
}
