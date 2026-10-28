import { RequestTypeSchema } from "@recnrun/bridge";
import * as v from "valibot";
import { LinkEventSchema, PeerRequestSchema } from "@/messaging/peer-messages";
import { SessionRequestSchema } from "@/messaging/session-protocol";

/** What the content script relays from the website: a bridge request type, and nothing else. */
const BridgeRequestSchema = v.object({ type: RequestTypeSchema });

/** Every message the background answers, told apart by `type`, so one listener validates once. */
export const BackgroundMessageSchema = v.variant("type", [
  BridgeRequestSchema,
  SessionRequestSchema,
  // The cross-profile POC: a page's request about the other profile, and the link's reports.
  v.object({ type: v.literal("peer"), request: PeerRequestSchema }),
  v.object({ type: v.literal("link"), event: LinkEventSchema }),
]);

export type BackgroundMessage = v.InferOutput<typeof BackgroundMessageSchema>;
