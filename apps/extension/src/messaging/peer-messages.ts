import * as v from "valibot";
import { PresenceSchema, SignalFileSchema } from "@/p2p/folder-rendezvous";
import { DisplayNameSchema } from "@/p2p/pairing-code";
import { MAX_FRAME_LENGTH, ProfileIdSchema } from "@/p2p/protocol";

const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const SdpSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(64 * 1024));
const FrameSchema = v.pipe(v.string(), v.maxLength(MAX_FRAME_LENGTH));
export const LinkStateSchema = v.picklist([
  "idle",
  "connecting",
  "connected",
  "disconnected",
  "failed",
]);

export type LinkState = v.InferOutput<typeof LinkStateSchema>;

const kind = <T extends string, P extends v.ObjectEntries>(type: T, payload: P) =>
  v.strictObject({ type: v.literal(type), ...payload });

// Each peer has its own link, and every link command, link event, and request about one peer
// names the peer's profile id.
const peer = { peer: ProfileIdSchema };

/** What an extension page asks the background about the other profiles. */
export const PeerRequestSchema = v.variant("type", [
  kind("status", {}),
  kind("rename", { displayName: DisplayNameSchema }),
  kind("disconnect", peer),
  kind("reconnect", peer),
  kind("forget", peer),
  kind("pair-again", {}),
  kind("folder-pair", {}),
  kind("folder-release", {}),
  kind("tabs", peer),
  kind("activate", { ...peer, tabId: TabIdSchema }),
  kind("session-start", { ...peer, tabId: TabIdSchema }),
  kind("session-set", { ...peer, status: v.picklist(["recording", "paused"]) }),
  kind("session-stop", peer),
]);

export type PeerRequest = v.InferOutput<typeof PeerRequestSchema>;

/** What the offscreen document reports about its links. */
export const LinkEventSchema = v.variant("type", [
  kind("frame", { ...peer, frame: FrameSchema }),
  kind("state", { ...peer, state: LinkStateSchema, remoteFingerprint: v.optional(v.string()) }),
  /** What the other profiles left in the RECnRun folder for this one. */
  kind("folder", { presences: v.array(PresenceSchema), signals: v.array(SignalFileSchema) }),
]);

export type LinkEvent = v.InferOutput<typeof LinkEventSchema>;

/** What the background asks of the offscreen document, which alone holds the connections. */
const LinkCommandSchema = v.variant("type", [
  kind("offer", peer),
  kind("answer", { ...peer, sdp: SdpSchema }),
  kind("accept-answer", { ...peer, sdp: SdpSchema }),
  kind("send", { ...peer, frame: FrameSchema }),
  kind("close", peer),
  kind("folder-status", {}),
  kind("folder-watch", { profileId: ProfileIdSchema, displayName: DisplayNameSchema }),
  kind("folder-publish", { signal: SignalFileSchema }),
  kind("folder-stop", {}),
]);

export type LinkCommand = v.InferOutput<typeof LinkCommandSchema>;

/** Every extension page receives runtime messages; `target` keeps the link's own apart. */
export const LinkCommandMessageSchema = v.strictObject({
  target: v.literal("offscreen"),
  command: LinkCommandSchema,
});

export const linkCommandMessage = (command: LinkCommand) => ({
  target: "offscreen" as const,
  command,
});

/** The background tells every page that the other profile's tabs, link, or session changed. */
export const PeerNoticeSchema = v.strictObject({
  target: v.literal("pages"),
  type: v.literal("peer-changed"),
});

export const peerNotice = (): v.InferOutput<typeof PeerNoticeSchema> => ({
  target: "pages",
  type: "peer-changed",
});

export const peerRequestMessage = (request: PeerRequest) => ({ type: "peer" as const, request });
export const linkEventMessage = (event: LinkEvent) => ({ type: "link" as const, event });
