import { RecordingSessionSchema } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
// The schemas pages validate with live in messaging, so a page never defines storage items.
import {
  AuthorizedPeerSchema,
  PeerLinkSchema,
  ProfileIdentitySchema,
} from "@/messaging/peer-results";
import { ProfileIdSchema } from "@/p2p/protocol";

export type ProfileIdentity = v.InferOutput<typeof ProfileIdentitySchema>;
export type AuthorizedPeer = v.InferOutput<typeof AuthorizedPeerSchema>;
export type PeerLink = v.InferOutput<typeof PeerLinkSchema>;

/** The offer this profile waits an answer for. */
const PendingOfferSchema = v.strictObject({
  pairingId: v.pipe(v.string(), v.uuid()),
  expiresAt: v.number(),
});

/**
 * On the controller: its copy of the session the peer runs, written only from the peer's reports.
 * The executor's own session is the truth; this copy is never sent back.
 */
const RemoteRecordingSchema = v.strictObject({
  profileId: ProfileIdSchema,
  session: v.nullable(RecordingSessionSchema),
  /** Whether this profile's dashboard started it, so it may control it. */
  mine: v.boolean(),
  /** Disconnected keeps the last report, whose state is then unknown. */
  connected: v.boolean(),
});

export type RemoteRecording = v.InferOutput<typeof RemoteRecordingSchema>;

/** On the executor: the peer whose dashboard started the session that runs here. */
const RemoteControllerSchema = v.strictObject({ profileId: ProfileIdSchema });

function repository<T>(key: `local:${string}` | `session:${string}`, schema: v.GenericSchema<T>) {
  const item = storage.defineItem<unknown>(key);
  return {
    /** Null when absent; a stored value that does not match is an error, never overwritten. */
    read: async (): Promise<T | null> => {
      const stored = await item.getValue();
      if (stored === null) return null;
      const parsed = v.safeParse(schema, stored);
      if (!parsed.success) throw new Error(`The stored ${key} does not match its schema.`);
      return parsed.output;
    },
    write: (value: T | null) => item.setValue(value),
    watch: (onChange: () => void) => item.watch(onChange),
  };
}

export type Repository<T> = ReturnType<typeof repository<T>>;

export const identityRepository = repository("local:profileIdentity", ProfileIdentitySchema);
export const authorizedPeerRepository = repository("local:authorizedPeer", AuthorizedPeerSchema);
// Session storage ends with the browser, as the link and anything it carried do.
export const peerLinkRepository = repository("session:peerLink", PeerLinkSchema);
export const pendingOfferRepository = repository("session:pendingOffer", PendingOfferSchema);
export const remoteRecordingRepository = repository(
  "session:remoteRecording",
  RemoteRecordingSchema,
);
export const remoteControllerRepository = repository(
  "session:remoteController",
  RemoteControllerSchema,
);

let creating: Promise<ProfileIdentity> | undefined;

async function createIdentity(): Promise<ProfileIdentity> {
  const profileId = crypto.randomUUID();
  const identity = { profileId, displayName: `Profile ${profileId.slice(0, 4).toUpperCase()}` };
  await identityRepository.write(identity);
  return identity;
}

/** This profile's identity, created once on first use with a short default name. */
export async function readIdentity(): Promise<ProfileIdentity> {
  const stored = await identityRepository.read();
  if (stored) return stored;
  // Two first reads at once would otherwise each create, and store, a different id.
  creating ??= createIdentity().finally(() => (creating = undefined));
  return creating;
}
