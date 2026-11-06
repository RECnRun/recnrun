import * as v from "valibot";
import { NamespaceSchema, TokenSchema } from "@/p2p/downloads-rendezvous";
import { IdentityStatementSchema } from "@/p2p/identity-key";
import { MAX_CODE_LENGTH, ProfileIdSchema } from "@/p2p/protocol";

/*
 * Dashboard control of the worker clones (POC PLAN.md P7.5-P7.6): the master asks, in a request file
 * under its own Downloads root, for a clone to be closed, opened, or reopened; the launcher alone
 * answers in status.json beside it and lists the clones in control/clones.json. The request's bytes
 * are the schema's key order, which clone-control.sh reads.
 */

export const CLONE_ACTIONS = [
  "close",
  "open-headless",
  "open-visible",
  "reopen-headless",
  "reopen-visible",
] as const;
export type CloneAction = (typeof CLONE_ACTIONS)[number];

const TimeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** What the owner chooses; the background adds who asks and when. */
export const CloneControlChoiceSchema = v.strictObject({
  requestId: TokenSchema,
  action: v.picklist(CLONE_ACTIONS),
  instanceId: TokenSchema,
});
export type CloneControlChoice = v.InferOutput<typeof CloneControlChoiceSchema>;

export const CloneControlRequestSchema = v.strictObject({
  requestId: TokenSchema,
  kind: v.literal("clone-control"),
  action: v.picklist(CLONE_ACTIONS),
  instanceId: TokenSchema,
  namespace: NamespaceSchema,
  masterProfileId: ProfileIdSchema,
  masterIdentity: IdentityStatementSchema,
  createdAt: TimeSchema,
});

/** Printable ASCII without a quote or backslash, at most 256 bytes: what clone-control.sh writes. */
const MessageSchema = v.pipe(v.string(), v.maxLength(256), v.regex(/^[ !#-[\]-~]*$/));

/** The launcher's status.json of one request; action and instance are empty when it could not read them. */
export const CloneStatusSchema = v.strictObject({
  requestId: TokenSchema,
  action: v.union([v.literal(""), v.picklist(CLONE_ACTIONS)]),
  instanceId: v.union([v.literal(""), TokenSchema]),
  state: v.picklist(["running", "done", "refused", "error"]),
  message: MessageSchema,
  updatedAt: TimeSchema,
});
export type CloneStatus = v.InferOutput<typeof CloneStatusSchema>;

const MAX_CLONES = 64;

const CloneRowSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^[A-Za-z0-9_-]{1,64}$/)),
  instanceId: TokenSchema,
  state: v.picklist(["closed", "opening", "open"]),
  mode: v.picklist(["", "headless", "headed"]),
  boot: v.union([v.literal(""), v.pipe(v.string(), v.uuid())]),
});
export type CloneRow = v.InferOutput<typeof CloneRowSchema>;

/** The launcher's control/clones.json, in the key order clone-control.sh writes. */
export const ClonesSchema = v.strictObject({
  clones: v.pipe(
    v.array(CloneRowSchema),
    v.maxLength(MAX_CLONES),
    v.check(
      (rows) => new Set(rows.map((row) => row.instanceId)).size === rows.length,
      "Each instance id appears once.",
    ),
  ),
  updatedAt: TimeSchema,
});
export type Clones = v.InferOutput<typeof ClonesSchema>;

function readJson<T>(schema: v.GenericSchema<unknown, T>, text: string | undefined): T | undefined {
  if (text === undefined || text.length > MAX_CODE_LENGTH) return undefined;
  try {
    const parsed = v.safeParse(schema, JSON.parse(text));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** The status in a file's text, or undefined when the text is no status. */
export function readCloneStatus(text: string | undefined): CloneStatus | undefined {
  return readJson(CloneStatusSchema, text);
}

/** The clone list in a file's text, or undefined when the text is no list. */
export function readClones(text: string | undefined): Clones | undefined {
  return readJson(ClonesSchema, text);
}
