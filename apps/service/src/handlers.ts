import {
  CAPABILITY_MATRIX,
  PROTOCOL_SCHEMA_VERSION,
  type DiscoveryResult,
} from "@recnrun/protocol";
import type { CommandHandlers } from "./dispatch.ts";
import { SERVICE_VERSION } from "./version.ts";

export interface HandlerContext {
  /** When the service started, in `now()` milliseconds. */
  startedAt: number;
  /** Chrome discovery for the default profile (`adapter.discover()`). */
  discover: () => Promise<DiscoveryResult>;
  now?: () => number;
}

/** The commands F2.1 implements; every other command answers `capability-unavailable`. */
export function createHandlers({
  startedAt,
  discover,
  now = Date.now,
}: HandlerContext): CommandHandlers {
  return {
    "capabilities.get": async () => CAPABILITY_MATRIX,
    health: async () => ({
      status: "ok",
      serviceVersion: SERVICE_VERSION,
      protocolVersion: PROTOCOL_SCHEMA_VERSION,
      pid: process.pid,
      uptimeMs: Math.max(0, now() - startedAt),
      chrome: await discover(),
    }),
  };
}
