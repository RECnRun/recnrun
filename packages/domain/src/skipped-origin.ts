import * as v from "valibot";
import { OriginSchema } from "./origin-data.ts";

/** Where a visited origin's save or restore gave up, or why its last saved storage was kept. */
export const SKIP_STEPS = ["navigate", "save", "restore", "not-restored"] as const;

/**
 * A visited origin a save or a restore left out, so the identity still opens: its origin, the step,
 * and a short reason, never a stored value.
 */
export const SkippedOriginSchema = v.object({
  origin: OriginSchema,
  work: v.picklist(["save", "restore"]),
  step: v.picklist(SKIP_STEPS),
  reason: v.pipe(v.string(), v.nonEmpty(), v.maxLength(200)),
  /** Whether the identity's last saved storage of the origin stays in its capture. */
  kept: v.boolean(),
});

export type SkippedOrigin = v.InferOutput<typeof SkippedOriginSchema>;
