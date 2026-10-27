import * as v from "valibot";
import { LinkStateSchema } from "@/messaging/peer-messages";
import { ProfileIdSchema } from "@/p2p/protocol";
import { DisplayNameSchema } from "@/p2p/pairing-code";

/** Who this installation is to its peers: generated once, never the extension id. */
export const ProfileIdentitySchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
});

/** The peer this profile paired with, pinned to its DTLS certificate fingerprint. */
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

/** The session that runs in the peer, from its last report; `live` while the link carries reports. */
const PeerSessionSchema = v.strictObject({
  status: v.picklist(["recording", "paused"]),
  /** Whether this profile's dashboard started it, so it may control it. */
  mine: v.boolean(),
  live: v.boolean(),
});

/** Whether this profile may use the RECnRun folder: none chosen, Chrome asks again, or granted. */
export const FolderAccessSchema = v.picklist(["none", "prompt", "granted"]);

/** What a page learns about this profile and its link, as the background answers `status`. */
export const PeerStatusSchema = v.object({
  identity: ProfileIdentitySchema,
  peer: v.nullable(AuthorizedPeerSchema),
  link: PeerLinkSchema,
  peerSession: v.nullable(PeerSessionSchema),
  /** Whether the session that runs here was started by the peer, over a link that still holds. */
  controlledByPeer: v.boolean(),
  folder: FolderAccessSchema,
  /** Whether this profile waits in the folder to pair, or to reconnect with its peer. */
  folderPairing: v.boolean(),
});

export type PeerStatus = v.InferOutput<typeof PeerStatusSchema>;
