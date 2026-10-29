import * as v from "valibot";
import { OriginCaptureSchema, OriginDataSchema } from "./origin-data.ts";

/** A host name as Chrome writes a cookie's host: letters, digits, dots, and hyphens. */
const HostSchema = v.pipe(v.string(), v.regex(/^[a-z0-9.-]+$/i));

/**
 * One cookie to restore; no `domain` means a host-only cookie, of `host` or else of the target's
 * host, and no `expirationDate` a session one.
 */
const SiteCookieFieldsSchema = v.object({
  name: v.string(),
  value: v.string(),
  domain: v.optional(v.string()),
  /** Present only on a host-only cookie of a host other than the target's. */
  host: v.optional(HostSchema),
  path: v.pipe(v.string(), v.startsWith("/")),
  secure: v.boolean(),
  httpOnly: v.boolean(),
  sameSite: v.picklist(["no_restriction", "lax", "strict", "unspecified"]),
  expirationDate: v.optional(v.number()),
  /** Present only on a partitioned (CHIPS) cookie. */
  partitionKey: v.optional(
    v.object({
      topLevelSite: v.optional(v.string()),
      hasCrossSiteAncestor: v.optional(v.boolean()),
    }),
  ),
});

export const SiteCookieSchema = v.pipe(
  SiteCookieFieldsSchema,
  v.check(
    ({ domain, host }) => domain === undefined || host === undefined,
    "A cookie is host-only or has a domain, never both.",
  ),
);

export type SiteCookie = v.InferOutput<typeof SiteCookieSchema>;

/**
 * What a start with an identity restores: its cookies, the target origin's site data, and the
 * other origins the session visited, each restored in a helper tab before the app runs.
 */
export const IdentityDataSchema = v.object({
  cookies: v.array(SiteCookieSchema),
  site: OriginDataSchema,
  // Data captured before visited origins were kept named only the target's.
  origins: v.optional(v.array(OriginCaptureSchema), []),
});

export type IdentityData = v.InferOutput<typeof IdentityDataSchema>;
