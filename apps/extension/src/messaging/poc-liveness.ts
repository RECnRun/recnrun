import * as v from "valibot";
import { ProfileIdSchema } from "@/p2p/protocol";

/** P3.6 (POC PLAN.md): the background asks the offscreen document when each link last heard its peer. */
export const PocLivenessRequestSchema = v.strictObject({ type: v.literal("POC_LIVENESS") });

export const pocLivenessRequest = (): v.InferOutput<typeof PocLivenessRequestSchema> => ({
  type: "POC_LIVENESS",
});

const CountSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** Per peer: when its DataChannel last delivered anything, beats included, and the beats sent to it. */
const LinkLivenessSchema = v.strictObject({
  heardAt: v.optional(CountSchema),
  beats: CountSchema,
});

export type LinkLiveness = v.InferOutput<typeof LinkLivenessSchema>;

export const PocLivenessResultSchema = v.strictObject({
  peers: v.record(ProfileIdSchema, LinkLivenessSchema),
});
