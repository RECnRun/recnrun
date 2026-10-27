import * as v from "valibot";
import { PresenceSchema, SignalFileSchema } from "@/p2p/folder-rendezvous";
import { DisplayNameSchema } from "@/p2p/pairing-code";
import { MAX_FRAME_LENGTH, ProfileIdSchema } from "@/p2p/protocol";

const TabIdSchema = v.pipe(v.number(), v.integer(), v.minValue(0));
const CodeSchema = v.pipe(v.string(), v.nonEmpty(), v.maxLength(128 * 1024));
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

/** What an extension page asks the background about the other profile. */
export const PeerRequestSchema = v.variant("type", [
  kind("status", {}),
  kind("rename", { displayName: DisplayNameSchema }),
  kind("create-offer", {}),
  kind("inspect", { code: CodeSchema }),
  kind("accept", { code: CodeSchema }),
  kind("disconnect", {}),
  kind("forget", {}),
  kind("folder-pair", {}),
  kind("folder-release", {}),
  kind("ping", {}),
  kind("diagnostics", {}),
  kind("tabs", {}),
  kind("activate", { tabId: TabIdSchema }),
  kind("session-start", { tabId: TabIdSchema }),
  kind("session-set", { status: v.picklist(["recording", "paused"]) }),
  kind("session-stop", {}),
]);

export type PeerRequest = v.InferOutput<typeof PeerRequestSchema>;

/** What the offscreen document reports about its link. */
export const LinkEventSchema = v.variant("type", [
  kind("frame", { frame: FrameSchema }),
  kind("state", { state: LinkStateSchema, remoteFingerprint: v.optional(v.string()) }),
  /** What the other profiles left in the RECnRun folder for this one. */
  kind("folder", { presences: v.array(PresenceSchema), signals: v.array(SignalFileSchema) }),
]);

export type LinkEvent = v.InferOutput<typeof LinkEventSchema>;

/** What the background asks of the offscreen document, which alone holds the connection. */
const LinkCommandSchema = v.variant("type", [
  kind("fingerprint", {}),
  kind("offer", {}),
  kind("answer", { sdp: SdpSchema }),
  kind("accept-answer", { sdp: SdpSchema }),
  kind("send", { frame: FrameSchema }),
  kind("close", {}),
  kind("info", {}),
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
