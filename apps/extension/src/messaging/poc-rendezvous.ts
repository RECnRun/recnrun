import * as v from "valibot";
import { NamespaceSchema } from "@/p2p/downloads-rendezvous";
import { BootSchema } from "@/p2p/folder-rendezvous";
import { MAX_CODE_LENGTH } from "@/p2p/protocol";

/*
 * P3.1 (POC PLAN.md): the offscreen document reads the Downloads rendezvous itself, through
 * file://, but only the background holds chrome.downloads and chrome.storage, so it asks there.
 */

const type = v.literal("POC_RENDEZVOUS");
const ItemIdSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

export const PocRendezvousRequestSchema = v.variant("op", [
  v.strictObject({ type, op: v.literal("context") }),
  v.strictObject({ type, op: v.literal("boot") }),
  v.strictObject({
    type,
    op: v.literal("write"),
    path: v.pipe(v.string(), v.maxLength(1024)),
    text: v.pipe(v.string(), v.maxLength(MAX_CODE_LENGTH)),
  }),
  v.strictObject({ type, op: v.literal("erase"), id: ItemIdSchema }),
]);

export type PocRendezvousRequest = v.InferOutput<typeof PocRendezvousRequestSchema>;

type Op = PocRendezvousRequest["op"];
type Fields<O extends Op> = Omit<Extract<PocRendezvousRequest, { op: O }>, "type" | "op">;

export const pocRendezvousRequest = <O extends Op>(op: O, fields: Fields<O>) =>
  ({ type: "POC_RENDEZVOUS", op, ...fields }) as Extract<PocRendezvousRequest, { op: O }>;

/** What each request answers. */
export const PocRendezvousResults = {
  context: v.strictObject({ namespace: NamespaceSchema, root: v.nullable(v.string()) }),
  boot: BootSchema,
  write: ItemIdSchema,
  erase: v.undefined(),
} as const;
