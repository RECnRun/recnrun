import * as v from "valibot";
import { LinkStateSchema } from "@/messaging/peer-messages";
import { ProfileIdSchema } from "@/p2p/protocol";
import {
  AuthorizedPeerSchema,
  PeerLinkSchema,
  ProfileIdentitySchema,
} from "@/storage/peer-repository";

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
