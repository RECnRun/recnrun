import * as v from "valibot";
import { IdSchema } from "./ids.ts";
import { HostSchema, SiteCookieSchema } from "./identity-data.ts";
import type { IdentityData } from "./identity-data.ts";
import { TargetUrlSchema } from "./managed-window.ts";
import { OriginDataSchema } from "./origin-data.ts";

/** The capture format's own version, apart from `Snapshot`'s; a breaking change bumps it. */
export const IDENTITY_CAPTURE_VERSION = 1;

const ADAPTERS = [
  "indexedDB",
  "localStorage",
  "sessionStorage",
  "cookies",
  "cacheStorage",
] as const;

/** The structured-clone types a capture may carry in its `unknown` values. */
const VALUE_TYPES = [
  "primitive",
  "Object",
  "Array",
  "Date",
  "RegExp",
  "Map",
  "Set",
  "ArrayBuffer",
  "TypedArray",
  "DataView",
  "Blob",
  "File",
] as const;

const AdapterSchema = v.picklist(ADAPTERS);
const TimeSchema = v.pipe(v.number(), v.minValue(0));
/** An error name or a short reason; never long enough to hold a stored value. */
const ReasonSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(200));

/** `scheme://host[:port]` as `URL.origin` writes it: lower case, no path; the domain has no `URL`. */
const OriginSchema = v.pipe(
  v.string(),
  v.regex(/^https?:\/\/([a-z0-9.-]+|\[[0-9a-f:]+\])(:\d{1,5})?$/),
);

/** Whether `url` is a page of `origin`: the origin, then nothing or a path, query, or fragment. */
function isPageOf(url: string, origin: string): boolean {
  const rest = url.slice(origin.length);
  return url.startsWith(origin) && (rest === "" || "/?#".includes(rest.charAt(0)));
}

/** One origin's captured site data, Cache Storage included: what the origin agent restores. */
const OriginCaptureSchema = v.object({ origin: OriginSchema, ...OriginDataSchema.entries });

/** Declared capabilities widen what is captured, such as the cookies of an SSO host. */
export const CaptureCapabilitiesSchema = v.object({ cookieHosts: v.array(HostSchema) });

export type CaptureCapabilities = v.InferOutput<typeof CaptureCapabilitiesSchema>;

const AdapterResultSchema = v.object({
  adapter: AdapterSchema,
  status: v.picklist(["captured", "failed", "skipped"]),
  error: v.optional(ReasonSchema),
});

const CaptureFieldsSchema = v.object({
  formatVersion: v.literal(IDENTITY_CAPTURE_VERSION),
  id: IdSchema,
  identityId: IdSchema,
  url: TargetUrlSchema,
  capabilities: CaptureCapabilitiesSchema,
  status: v.picklist(["in-progress", "complete", "failed"]),
  startedAt: TimeSchema,
  endedAt: v.optional(TimeSchema),
  error: v.optional(ReasonSchema),
  adapters: v.array(AdapterResultSchema),
  valueTypes: v.array(v.picklist(VALUE_TYPES)),
  cookies: v.array(SiteCookieSchema),
  origins: v.array(OriginCaptureSchema),
  /** What a capture met and could not keep, with why; never left out silently. */
  unsupported: v.array(
    v.object({ adapter: AdapterSchema, item: v.string(), reason: ReasonSchema }),
  ),
});

type CaptureFields = v.InferOutput<typeof CaptureFieldsSchema>;

const distinct = (values: readonly unknown[]) => new Set(values).size === values.length;

function isComplete(capture: CaptureFields): boolean {
  const { endedAt, startedAt, error, adapters, origins, url } = capture;
  return (
    endedAt !== undefined &&
    endedAt >= startedAt &&
    error === undefined &&
    adapters.every(({ status }) => status !== "failed") &&
    origins.some(({ origin }) => isPageOf(url, origin))
  );
}

/** A complete capture holds every adapter's result and its target; a failed one says why. */
function hasConsistentStatus(capture: CaptureFields): boolean {
  switch (capture.status) {
    case "in-progress":
      return capture.endedAt === undefined;
    case "failed":
      return capture.endedAt !== undefined && capture.error !== undefined;
    case "complete":
      return isComplete(capture);
  }
}

/**
 * One identity's saved site data (versioned apart from `Snapshot`): its target, cookies, and each
 * origin's Web Storage, IndexedDB schema and records, and caches. Values stay `unknown` and pass
 * through by reference, so structured types keep their type; `valueTypes` declares which occur.
 */
export const IdentityCaptureSchema = v.pipe(
  CaptureFieldsSchema,
  v.check(({ origins }) => distinct(origins.map(({ origin }) => origin)), "Repeated origin."),
  v.check(({ adapters }) => distinct(adapters.map(({ adapter }) => adapter)), "Repeated adapter."),
  v.check(({ valueTypes }) => distinct(valueTypes), "Repeated value type."),
  v.check(hasConsistentStatus, "The capture's status does not match its contents."),
);

export type IdentityCapture = v.InferOutput<typeof IdentityCaptureSchema>;

/** What a start from `capture` restores: its cookies, then all site data of its target's origin. */
export function restorableData(capture: IdentityCapture): IdentityData {
  const target = capture.origins.find(({ origin }) => isPageOf(capture.url, origin));
  if (!target) throw new Error("The capture holds no data for its target's origin.");
  const { origin: _origin, ...site } = target;
  return { cookies: capture.cookies, site };
}
