import * as v from "valibot";
import { CapturedTextSchema as TextSchema } from "./captured-text.ts";
import { typedEvent as typed } from "./events.ts";

/** The Web Storage areas the capture follows. */
export const STORAGE_AREAS = ["local", "session"] as const;

/** The Web Storage calls the hook wraps. */
export const STORAGE_OPERATIONS = ["setItem", "removeItem", "clear"] as const;

/**
 * How the capture knows what it reports: `snapshot` reads the whole state, `observed-change` is a
 * change Chrome reported, and `observed-operation` is a call the page made through a hooked API.
 */
export const STORAGE_OBSERVATIONS = ["snapshot", "observed-operation", "observed-change"] as const;

/** Why a snapshot was read: the target was attached, or one of its frames navigated. */
export const SNAPSHOT_REASONS = ["attach", "navigation"] as const;

/** A snapshot keeps at most this many items or cookies, flagged when cut. */
export const MAX_STORAGE_ITEMS = 100;

const Truncated = v.optional(v.literal(true));
const AreaSchema = v.picklist(STORAGE_AREAS);
// Chrome's serialized storage key, such as `http://127.0.0.1:4600/`.
const StorageKeySchema = v.pipe(v.string(), v.maxLength(2048));
const limited = <T extends v.GenericSchema>(item: T) =>
  v.pipe(v.array(item), v.maxLength(MAX_STORAGE_ITEMS));

const changeEntries = {
  observation: v.literal("observed-change"),
  area: AreaSchema,
  storageKey: StorageKeySchema,
  truncated: Truncated,
};

/** One Web Storage call as the hook saw it; an exception the call threw is kept as `error`. */
export const StorageOperationPayloadSchema = v.strictObject({
  area: AreaSchema,
  operation: v.picklist(STORAGE_OPERATIONS),
  key: v.optional(TextSchema),
  value: v.optional(TextSchema),
  error: v.optional(TextSchema),
  truncated: Truncated,
});

/**
 * A cookie as the CDP cookie API reports it. The value of an HttpOnly or Secure cookie is never
 * kept: the cookie says `redacted` and has no `value`.
 */
export const CookieSchema = v.strictObject({
  name: TextSchema,
  domain: TextSchema,
  path: TextSchema,
  value: v.optional(TextSchema),
  redacted: v.optional(v.literal(true)),
  httpOnly: v.boolean(),
  secure: v.boolean(),
  session: v.boolean(),
  expires: v.optional(v.number()),
  sameSite: v.optional(v.picklist(["Strict", "Lax", "None"])),
  truncated: Truncated,
});

const cookieChange = v.strictObject({
  observation: v.literal("observed-change"),
  cookie: CookieSchema,
});

export const StorageEventSchema = v.variant("type", [
  typed(
    "storage",
    "snapshot",
    v.strictObject({
      observation: v.literal("snapshot"),
      reason: v.picklist(SNAPSHOT_REASONS),
      area: AreaSchema,
      storageKey: StorageKeySchema,
      items: limited(v.strictObject({ key: TextSchema, value: TextSchema })),
      truncated: Truncated,
    }),
  ),
  typed(
    "storage",
    "item-added",
    v.strictObject({ ...changeEntries, key: TextSchema, newValue: TextSchema }),
  ),
  typed(
    "storage",
    "item-updated",
    v.strictObject({
      ...changeEntries,
      key: TextSchema,
      oldValue: TextSchema,
      newValue: TextSchema,
    }),
  ),
  typed("storage", "item-removed", v.strictObject({ ...changeEntries, key: TextSchema })),
  typed("storage", "items-cleared", v.strictObject(changeEntries)),
  typed(
    "storage",
    "operation",
    v.strictObject({
      observation: v.literal("observed-operation"),
      ...StorageOperationPayloadSchema.entries,
    }),
  ),
  typed(
    "storage",
    "cookies-snapshot",
    v.strictObject({
      observation: v.literal("snapshot"),
      reason: v.picklist(SNAPSHOT_REASONS),
      cookies: limited(CookieSchema),
      truncated: Truncated,
    }),
  ),
  typed("storage", "cookie-added", cookieChange),
  typed("storage", "cookie-changed", cookieChange),
  typed("storage", "cookie-removed", cookieChange),
]);

export type StorageArea = (typeof STORAGE_AREAS)[number];
export type SnapshotReason = (typeof SNAPSHOT_REASONS)[number];
export type StorageOperationPayload = v.InferOutput<typeof StorageOperationPayloadSchema>;
export type Cookie = v.InferOutput<typeof CookieSchema>;
