import { MarkerSchema } from "@recnrun/isolation-core";
import * as v from "valibot";

// The harness calls Route B through Runtime.evaluate, so every argument is checked where it enters.
const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const ArmRequestSchema = v.object({
  tabId: TabIdSchema,
  marker: MarkerSchema,
  /** The `Fetch.enable` URL pattern; the harness names the fixture's scripts, the isolator does not. */
  urlPattern: v.pipe(v.string(), v.minLength(1)),
  /** `Fetch.enable` on the tab's own session. */
  tabFetch: v.optional(v.boolean(), true),
  /** `Fetch.enable` on each auto-attached worker's session before it is released. */
  workerFetch: v.optional(v.boolean(), true),
  /** Whether scripts a worker imports are wrapped too, or only let through. */
  imports: v.optional(v.picklist(["continue", "transform"]), "continue"),
  /** `Network.enable` on each worker's session, to record why its requests failed. */
  network: v.optional(v.boolean(), false),
});

export type ArmRequest = v.InferOutput<typeof ArmRequestSchema>;

const TabRequestSchema = v.object({ tabId: TabIdSchema });
const TargetRequestSchema = v.object({ targetId: v.pipe(v.string(), v.minLength(1)) });

function parse<const T extends v.GenericSchema>(
  schema: T,
  request: unknown,
  expected: string,
): v.InferOutput<T> {
  const result = v.safeParse(schema, request);
  if (result.success) return result.output;
  throw new Error(
    `expected ${expected}, got ${JSON.stringify(request)}: ${v.summarize(result.issues)}`,
  );
}

export function armRequestOf(request: unknown): ArmRequest {
  return parse(ArmRequestSchema, request, "{ tabId, marker, urlPattern }");
}

export function tabIdOf(request: unknown): number {
  return parse(TabRequestSchema, request, "{ tabId: <integer> }").tabId;
}

export function targetIdOf(request: unknown): string {
  return parse(TargetRequestSchema, request, "{ targetId: <string> }").targetId;
}
