import * as v from "valibot";
import { PrepareChoiceSchema } from "@/p2p/prepare";
import { TokenSchema } from "@/p2p/downloads-rendezvous";

/** The dashboard of the master asks the background to write a "Prepare workers" file (P6.1). */
export const PocPrepareWorkersSchema = v.variant("op", [
  v.strictObject({
    type: v.literal("POC_PREPARE_WORKERS"),
    op: v.literal("request"),
    choice: PrepareChoiceSchema,
  }),
  v.strictObject({
    type: v.literal("POC_PREPARE_WORKERS"),
    op: v.literal("retry"),
    operationId: TokenSchema,
  }),
]);
export type PocPrepareWorkers = v.InferOutput<typeof PocPrepareWorkersSchema>;
