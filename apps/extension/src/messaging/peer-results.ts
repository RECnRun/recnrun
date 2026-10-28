import * as v from "valibot";
import { LinkStateSchema } from "@/messaging/peer-messages";
import { FingerprintSchema, ProfileIdSchema } from "@/p2p/protocol";
import { DisplayNameSchema } from "@/p2p/pairing-code";

/** Who this installation is to its peers: generated once, never the extension id. */
export const ProfileIdentitySchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
});

/** A profile this one paired with, pinned to its DTLS certificate fingerprint. */
export const AuthorizedPeerSchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
  fingerprint: FingerprintSchema,
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

/** One paired profile, its link, and its session as this profile knows them. */
const PeerEntrySchema = v.object({
  peer: AuthorizedPeerSchema,
  link: PeerLinkSchema,
  peerSession: v.nullable(PeerSessionSchema),
});

export type PeerEntry = v.InferOutput<typeof PeerEntrySchema>;

/** What a page learns about this profile and its links, as the background answers `status`. */
export const PeerStatusSchema = v.object({
  identity: ProfileIdentitySchema,
  peers: v.array(PeerEntrySchema),
  /** The peer that started the session running here, while its link holds. */
  controlledBy: v.nullable(ProfileIdSchema),
  /** The profiles the user disconnected or forgot, which the folder does not pair with. */
  paused: v.array(ProfileIdSchema),
  folder: FolderAccessSchema,
  /** Whether this profile waits in the folder to pair, or to reconnect with its peers. */
  folderPairing: v.boolean(),
  /** The profiles in the folder, as this one last looked, that it has no link with nor paused. */
});

export type PeerStatus = v.InferOutput<typeof PeerStatusSchema>;
