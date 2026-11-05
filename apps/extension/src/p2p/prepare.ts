import * as v from "valibot";
import { NamespaceSchema, TokenSchema } from "@/p2p/downloads-rendezvous";
import { IdentityStatementSchema } from "@/p2p/identity-key";
import { SettingSchema } from "@/p2p/poc-setting";
import { MAX_CODE_LENGTH, ProfileIdSchema } from "@/p2p/protocol";

/*
 * The "Prepare workers" operation (POC PLAN.md P6.1, decision 11): the master asks, in a request
 * file under its own Downloads root, for a base to be made and cloned; the launcher alone answers in
 * status.json beside it. The request's bytes are the schema's key order, which provision.sh reads.
 */

export const MAX_CLONES = 8;

const BASES_DIR_MESSAGE =
  "Use an absolute folder path of letters, digits, dot, underscore, hyphen, and slash only (no spaces, no empty, . or .. parts, no trailing slash).";

/** The folders that hold the bases: the launcher's canonical path grammar (is_plain_root). */
export const BasesDirSchema = v.pipe(
  v.string(),
  v.maxLength(1024),
  v.regex(/^(\/[A-Za-z0-9._-]+)+$/, BASES_DIR_MESSAGE),
  v.check(
    (path) => path.split("/").every((part) => part !== "." && part !== ".."),
    BASES_DIR_MESSAGE,
  ),
);

export const ClonesSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(MAX_CLONES));

const TimeSchema = v.pipe(v.number(), v.safeInteger(), v.minValue(0));

/** What the owner chooses; the background adds who asks and when. */
export const PrepareChoiceSchema = v.strictObject({
  operationId: TokenSchema,
  basesDir: BasesDirSchema,
  baseName: SettingSchema,
  clones: ClonesSchema,
});

export const PrepareRequestSchema = v.strictObject({
  operationId: TokenSchema,
  kind: v.literal("prepare-workers"),
  basesDir: BasesDirSchema,
  baseName: SettingSchema,
  clones: ClonesSchema,
  namespace: NamespaceSchema,
  masterProfileId: ProfileIdSchema,
  masterIdentity: IdentityStatementSchema,
  createdAt: TimeSchema,
});

const STEPS = [
  "create-base",
  "install",
  "template",
  "freeze",
  "create-clone",
  "open-clone",
  "done",
] as const;
const STATES = ["running", "pending-action", "error", "done"] as const;

/** Printable ASCII without a quote or backslash, at most 256 bytes: what provision.sh writes. */
const MessageSchema = v.pipe(v.string(), v.maxLength(256), v.regex(/^[ !#-[\]-~]*$/));

function hasUniqueWorkers(rows: readonly { name: string; instanceId: string }[]): boolean {
  return (
    new Set(rows.map((row) => row.name)).size === rows.length &&
    new Set(rows.map((row) => row.instanceId)).size === rows.length
  );
}

const PrepareCloneSchema = v.strictObject({
  name: v.pipe(v.string(), v.regex(/^w[1-8]$/)),
  instanceId: TokenSchema,
  /** The boot of the clone's ack; empty until it acked. */
  boot: v.union([v.literal(""), v.pipe(v.string(), v.uuid())]),
  acked: v.boolean(),
});

/** The launcher's status.json of one operation, in the key order provision.sh writes. */
export const PrepareStatusSchema = v.strictObject({
  operationId: TokenSchema,
  step: v.picklist(STEPS),
  state: v.picklist(STATES),
  message: MessageSchema,
  clones: v.pipe(
    v.array(PrepareCloneSchema),
    v.maxLength(MAX_CLONES),
    v.check((rows) => hasUniqueWorkers(rows), "Each worker name and instance id appears once."),
  ),
  updatedAt: TimeSchema,
});
export type PrepareStatus = v.InferOutput<typeof PrepareStatusSchema>;

/** The status in a file's text, or undefined when the text is no status. */
export function readStatus(text: string | undefined): PrepareStatus | undefined {
  if (text === undefined || text.length > MAX_CODE_LENGTH) return undefined;
  try {
    const parsed = v.safeParse(PrepareStatusSchema, JSON.parse(text));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}
