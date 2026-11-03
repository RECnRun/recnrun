import { MarkerSchema } from "@recnrun/isolation-core";
import * as v from "valibot";
import { isLoopbackUrl } from "@/background/probes/loopback";
import { WORKER_STRATEGIES } from "@/content/route-c/names";

// The harness calls Route C through Runtime.evaluate, so every argument is checked where it enters.

/** The fixture app origins the manifest grants (wxt.config.ts host_permissions). */
export const APP_MATCHES = ["http://app.localhost:4600/*", "http://app.localhost:4603/*"];

// matchOriginAsFallback needs a pattern whose path is exactly "/*"; R11 keeps it on the loopback.
const LoopbackPatternSchema = v.pipe(
  v.string(),
  v.check(
    (pattern) => /^http:\/\/[^/*]+\/\*$/.test(pattern) && isLoopbackUrl(pattern),
    "expected an http match pattern on the loopback whose path is /*",
  ),
);

const InstallSchema = v.object({
  marker: MarkerSchema,
  matches: v.optional(v.pipe(v.array(LoopbackPatternSchema), v.minLength(1)), () => [
    ...APP_MATCHES,
  ]),
  workers: v.optional(v.picklist(WORKER_STRATEGIES), "fail-closed"),
});

const SetMarkerSchema = v.object({ marker: MarkerSchema });

export type InstallRequest = v.InferOutput<typeof InstallSchema>;

export function parseInstall(request: unknown): InstallRequest {
  return v.parse(InstallSchema, request);
}

export function parseSetMarker(request: unknown): string {
  return v.parse(SetMarkerSchema, request).marker;
}
