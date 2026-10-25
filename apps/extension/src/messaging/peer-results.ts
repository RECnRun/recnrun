import * as v from "valibot";
import { LinkStateSchema } from "@/messaging/peer-messages";
import { ProfileIdSchema } from "@/p2p/protocol";
import { DisplayNameSchema } from "@/p2p/pairing-code";

/** Who this installation is to its peers: generated once, never the extension id. */
export const ProfileIdentitySchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
});

/** The one peer the user confirmed, pinned to its DTLS certificate fingerprint. */
export const AuthorizedPeerSchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
  fingerprint: v.pipe(v.string(), v.regex(/^[0-9A-F:]+$/)),
});

export const PeerLinkSchema = v.strictObject({
  state: LinkStateSchema,
  /** Set once the link's certificate matches the authorized peer's. */
  verified: v.boolean(),
  /** Why a link went down, when it is known; a new attempt clears it. */
  reason: v.optional(v.picklist(["closed-here", "closed-by-peer", "certificate"])),
});

/** What a page learns about this profile and its link, as the background answers `status`. */
export const PeerStatusSchema = v.object({
  identity: ProfileIdentitySchema,
  peer: v.nullable(AuthorizedPeerSchema),
  link: PeerLinkSchema,
});

export type PeerStatus = v.InferOutput<typeof PeerStatusSchema>;

/** A pairing code to hand to the other profile; accepting an answer returns none. */
export const PairingCodeResultSchema = v.object({ code: v.optional(v.string()) });

/** What the user checks before accepting a pasted code. */
export const PairingPreviewSchema = v.object({
  kind: v.picklist(["offer", "answer"]),
  profileId: ProfileIdSchema,
  displayName: v.string(),
  digits: v.pipe(v.string(), v.regex(/^\d{6}$/)),
  known: v.boolean(),
});

export type PairingPreview = v.InferOutput<typeof PairingPreviewSchema>;

export const PingResultSchema = v.object({ latencyMs: v.number() });

export const DiagnosticsSchema = v.object({
  state: LinkStateSchema,
  diagnostics: v.array(v.string()),
});
