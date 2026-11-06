import * as v from "valibot";
import { CloneControlChoiceSchema } from "@/p2p/clone-control";

/** The dashboard of the master asks the background to write a clone-control request (P7.6). */
export const PocCloneControlSchema = v.strictObject({
  type: v.literal("POC_CLONE_CONTROL"),
  choice: CloneControlChoiceSchema,
});
export type PocCloneControl = v.InferOutput<typeof PocCloneControlSchema>;
