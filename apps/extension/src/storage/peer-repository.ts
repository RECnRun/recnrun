import * as v from "valibot";
import { storage } from "wxt/utils/storage";
import { ProfileIdSchema, SessionStatusSchema } from "@/p2p/protocol";

const DisplayNameSchema = v.pipe(v.string(), v.trim(), v.nonEmpty(), v.maxLength(64));

/** Who this installation is to its peers; generated once, never the extension id. */
export const ProfileIdentitySchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
});

export type ProfileIdentity = v.InferOutput<typeof ProfileIdentitySchema>;

/** The one peer the user confirmed, pinned to its certificate fingerprint. */
export const AuthorizedPeerSchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
  fingerprint: v.pipe(v.string(), v.regex(/^[0-9A-F:]+$/)),
});

export type AuthorizedPeer = v.InferOutput<typeof AuthorizedPeerSchema>;

export const PeerLinkStatusSchema = v.strictObject({
  state: v.picklist(["idle", "connecting", "connected", "disconnected", "failed"]),
  /** Set once the authorized peer said HELLO over a link with its pinned certificate. */
  verified: v.boolean(),
});

export type PeerLinkStatus = v.InferOutput<typeof PeerLinkStatusSchema>;

/** The offer this profile is waiting an answer for. */
const PendingOfferSchema = v.strictObject({
  pairingId: v.pipe(v.string(), v.uuid()),
  expiresAt: v.number(),
});

/** The controller's copy of the session its peer runs; the executor's own is the truth. */
export const RemoteRecordingSchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
  ...SessionStatusSchema.entries,
  link: v.picklist(["connected", "disconnected"]),
});

export type RemoteRecording = v.InferOutput<typeof RemoteRecordingSchema>;

/** On the executor: which peer started the session that runs here. */
const RemoteControllerSchema = v.strictObject({ profileId: ProfileIdSchema });

function repository<T>(key: `local:${string}` | `session:${string}`, schema: v.GenericSchema<T>) {
  const item = storage.defineItem<unknown>(key);
  return {
    /** Null when absent; a value that no longer matches its schema counts as absent. */
    read: async (): Promise<T | null> => {
      const parsed = v.safeParse(schema, await item.getValue());
      return parsed.success ? parsed.output : null;
    },
    write: (value: T | null) => item.setValue(value),
    watch: (onChange: () => void) => item.watch(onChange),
  };
}

export const identityRepository = repository("local:profileIdentity", ProfileIdentitySchema);
export const authorizedPeerRepository = repository("local:authorizedPeer", AuthorizedPeerSchema);
export const peerLinkRepository = repository("session:peerLink", PeerLinkStatusSchema);
export const pendingOfferRepository = repository("session:pendingOffer", PendingOfferSchema);
export const remoteRecordingRepository = repository(
  "session:remoteRecording",
  RemoteRecordingSchema,
);
export const remoteControllerRepository = repository(
  "session:remoteController",
  RemoteControllerSchema,
);

/** This profile's identity, created on first use with a short default name. */
export async function readIdentity(): Promise<ProfileIdentity> {
  const stored = await identityRepository.read();
  if (stored) return stored;
  const profileId = crypto.randomUUID();
  const identity = { profileId, displayName: `Profile ${profileId.slice(0, 4).toUpperCase()}` };
  await identityRepository.write(identity);
  return identity;
}

export type Repository<T> = ReturnType<typeof repository<T>>;

/** Calls back when the identity, the authorized peer, or the link changes. */
export function watchPeer(onChange: () => void): () => void {
  const stops = [identityRepository, authorizedPeerRepository, peerLinkRepository].map((each) =>
    each.watch(onChange),
  );
  return () => {
    for (const stop of stops) stop();
  };
}
