import * as v from "valibot";
import { NonEmptyStringSchema } from "./common.ts";

/** The CDP domains the handshake probes; capture and replay depend on each. */
export const CDP_PROBE_DOMAINS = [
  "Target",
  "Network",
  "Runtime",
  "Page",
  "Log",
  "DOMStorage",
  "Storage",
  "Fetch",
] as const;

/** `Browser.getVersion` as Chrome answers it; fields Chrome adds later are dropped. */
export const BrowserVersionSchema = v.object({
  product: NonEmptyStringSchema,
  protocolVersion: NonEmptyStringSchema,
  userAgent: NonEmptyStringSchema,
  jsVersion: v.optional(v.string()),
  revision: v.optional(v.string()),
});

/** Whether a domain answered on the session it was probed on (the browser or a page). */
export const DomainProbeSchema = v.strictObject({
  domain: v.picklist(CDP_PROBE_DOMAINS),
  scope: v.picklist(["browser", "page"]),
  status: v.picklist(["available", "unavailable"]),
  reason: v.optional(NonEmptyStringSchema),
});

/** What a connection learned about the browser when it attached. */
export const BrowserHandshakeSchema = v.strictObject({
  endpoint: NonEmptyStringSchema,
  version: BrowserVersionSchema,
  domains: v.array(DomainProbeSchema),
});

/** A `Target.getTargets` entry; fields Chrome adds later are dropped. */
export const CdpTargetSchema = v.object({
  targetId: NonEmptyStringSchema,
  type: NonEmptyStringSchema,
  url: v.string(),
  title: v.string(),
  attached: v.boolean(),
  browserContextId: v.optional(v.string()),
  openerId: v.optional(v.string()),
});

/** The DevToolsActivePort a reconnection must find valid again. */
export const ConnectionSourceSchema = v.union([
  v.strictObject({ userDataDir: NonEmptyStringSchema }),
  v.strictObject({ activePortFile: NonEmptyStringSchema }),
]);

/** A reconnection either reaches the same profile's Chrome again or reports it gone. */
export const ReconnectResultSchema = v.variant("ok", [
  v.strictObject({ ok: v.literal(true), handshake: BrowserHandshakeSchema }),
  v.strictObject({
    ok: v.literal(false),
    code: v.literal("endpoint-gone"),
    remedy: NonEmptyStringSchema,
  }),
]);

export type BrowserVersion = v.InferOutput<typeof BrowserVersionSchema>;
export type DomainProbe = v.InferOutput<typeof DomainProbeSchema>;
export type BrowserHandshake = v.InferOutput<typeof BrowserHandshakeSchema>;
export type CdpTarget = v.InferOutput<typeof CdpTargetSchema>;
export type ConnectionSource = v.InferOutput<typeof ConnectionSourceSchema>;
export type ReconnectResult = v.InferOutput<typeof ReconnectResultSchema>;
