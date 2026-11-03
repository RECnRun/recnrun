import * as v from "valibot";
import { NonEmptyStringSchema } from "./common.ts";

/** Release channels of Google Chrome; each keeps its own default user-data dir. */
export const CHROME_CHANNELS = ["stable", "beta", "dev", "canary"] as const;

/** Why discovery found no endpoint; each failure carries a remedy for the user. */
export const DISCOVERY_ERROR_CODES = [
  "missing-file",
  "malformed-file",
  "stale-file",
  // The operating system refused the read (macOS app-data protection), so the file may be fine.
  "unreadable-file",
] as const;

export const ChromeChannelSchema = v.picklist(CHROME_CHANNELS);

const PortSchema = v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65_535));

/** What the adapter, the service, and `doctor` report after reading `DevToolsActivePort`. */
export const DiscoveryResultSchema = v.variant("ok", [
  v.strictObject({
    ok: v.literal(true),
    wsEndpoint: v.pipe(v.string(), v.regex(/^ws:\/\/127\.0\.0\.1:\d+\/devtools\/browser\//)),
    userDataDir: NonEmptyStringSchema,
    source: v.literal("active-port-file"),
    port: PortSchema,
    path: v.pipe(v.string(), v.startsWith("/devtools/browser/")),
  }),
  v.strictObject({
    ok: v.literal(false),
    code: v.picklist(DISCOVERY_ERROR_CODES),
    remedy: NonEmptyStringSchema,
    userDataDir: NonEmptyStringSchema,
  }),
]);

export type ChromeChannel = v.InferOutput<typeof ChromeChannelSchema>;
export type DiscoveryResult = v.InferOutput<typeof DiscoveryResultSchema>;
export type DiscoveryErrorCode = (typeof DISCOVERY_ERROR_CODES)[number];
