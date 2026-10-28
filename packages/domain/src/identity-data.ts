import * as v from "valibot";
import { OriginDataSchema } from "./origin-data.ts";

/** One cookie to restore; no `domain` means a host-only cookie, no `expirationDate` a session one. */
export const SiteCookieSchema = v.object({
  name: v.string(),
  value: v.string(),
  domain: v.optional(v.string()),
  path: v.pipe(v.string(), v.startsWith("/")),
  secure: v.boolean(),
  httpOnly: v.boolean(),
  sameSite: v.picklist(["no_restriction", "lax", "strict", "unspecified"]),
  expirationDate: v.optional(v.number()),
});

export type SiteCookie = v.InferOutput<typeof SiteCookieSchema>;

/** What a start with an identity restores: its cookies, then one origin's site data. */
export const IdentityDataSchema = v.object({
  cookies: v.array(SiteCookieSchema),
  site: OriginDataSchema,
});

export type IdentityData = v.InferOutput<typeof IdentityDataSchema>;
