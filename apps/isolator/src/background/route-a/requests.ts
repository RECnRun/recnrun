import { MarkerSchema } from "@recnrun/isolation-core";
import * as v from "valibot";
import { isLoopbackUrl } from "@/background/probes/loopback";

// The harness calls Route A through Runtime.evaluate, so every argument is checked where it enters.

const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

const TabSchema = v.object({ tabId: TabIdSchema });

const ArmSchema = v.object({
  tabId: TabIdSchema,
  pauseBeforeScript: v.optional(v.boolean(), false),
});

const TargetSchema = v.object({ targetId: v.pipe(v.string(), v.minLength(1)) });

/** Default milliseconds between two `getTargets()` polls of `watch`. */
const WATCH_INTERVAL_MS = 10;

// R11: watch attaches only to targets of a loopback origin, given as an origin, not a page URL.
const OriginSchema = v.pipe(
  v.string(),
  v.check((value) => URL.canParse(value) && new URL(value).origin === value),
  v.check(isLoopbackUrl),
);

const WatchSchema = v.object({
  origin: OriginSchema,
  marker: MarkerSchema,
  intervalMs: v.optional(
    v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(1000)),
    WATCH_INTERVAL_MS,
  ),
});

export type ArmRequest = v.InferOutput<typeof ArmSchema>;
export type WatchRequest = v.InferOutput<typeof WatchSchema>;

function parsed<T extends v.GenericSchema>(schema: T, request: unknown, expected: string) {
  const result = v.safeParse(schema, request);
  if (result.success) return result.output as v.InferOutput<T>;
  throw new Error(`expected ${expected}, got ${JSON.stringify(request)}`);
}

export function tabIdOf(request: unknown): number {
  return parsed(TabSchema, request, "{ tabId: <integer> }").tabId;
}

export function armRequestOf(request: unknown): ArmRequest {
  return parsed(ArmSchema, request, "{ tabId: <integer> } with pauseBeforeScript?: <boolean>");
}

export function targetIdOf(request: unknown): string {
  return parsed(TargetSchema, request, "{ targetId: <string> }").targetId;
}

export function watchRequestOf(request: unknown): WatchRequest {
  const expected = "{ origin: <loopback origin>, marker: <marker>, intervalMs?: <1-1000> }";
  return parsed(WatchSchema, request, expected);
}
