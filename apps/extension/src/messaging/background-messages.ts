import { RequestTypeSchema } from "@recnrun/bridge";
import * as v from "valibot";
import { ResponseUrlRequestSchema } from "@/messaging/response-url-protocol";
import { SessionRequestSchema } from "@/messaging/session-protocol";
import { WorkspaceRequestSchema } from "@/messaging/workspace-protocol";

/** What the content script relays from the website: a bridge request type, and nothing else. */
const BridgeRequestSchema = v.object({ type: RequestTypeSchema });

/** Every message the background answers, told apart by `type`, so one listener validates once. */
export const BackgroundMessageSchema = v.variant("type", [
  BridgeRequestSchema,
  SessionRequestSchema,
  WorkspaceRequestSchema,
  ResponseUrlRequestSchema,
]);

export type BackgroundMessage = v.InferOutput<typeof BackgroundMessageSchema>;

/** The one reply shape: a bridge request and `workspace-status` get a `result`, the others only `ok`. */
export const BackgroundReplySchema = v.variant("ok", [
  v.object({ ok: v.literal(true), result: v.optional(v.unknown()) }),
  v.object({ ok: v.literal(false), error: v.string() }),
]);

export type BackgroundReply = v.InferOutput<typeof BackgroundReplySchema>;
