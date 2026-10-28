import { RecordingSessionSchema } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";
// The schemas pages validate with live in messaging, so a page never defines storage items.
import {
  AuthorizedPeerSchema,
  PeerLinkSchema,
  ProfileIdentitySchema,
} from "@/messaging/peer-results";
import { MAX_CODE_LENGTH, MemberSchema, ProfileIdSchema, SharedTabsSchema } from "@/p2p/protocol";

export type ProfileIdentity = v.InferOutput<typeof ProfileIdentitySchema>;
export type AuthorizedPeer = v.InferOutput<typeof AuthorizedPeerSchema>;
export type PeerLink = v.InferOutput<typeof PeerLinkSchema>;

const PairingIdSchema = v.pipe(v.string(), v.uuid());

/** The offer this profile waits an answer for, whom it is for, and its code to send again. */
const PendingOfferSchema = v.strictObject({
  pairingId: PairingIdSchema,
  expiresAt: v.number(),
  to: ProfileIdSchema,
  code: v.pipe(v.string(), v.maxLength(MAX_CODE_LENGTH)),
});

export type PendingOffer = v.InferOutput<typeof PendingOfferSchema>;

/**
 * Present while this profile pairs through the folder, paired or not, so its peers reconnect on
 * their own; `paused` are the profiles the user disconnected or forgot. Not strict: an older
 * build's fields are dropped instead of refused.
 */
const FolderPairingSchema = v.object({ paused: v.optional(v.array(ProfileIdSchema)) });

export type FolderPairing = v.InferOutput<typeof FolderPairingSchema>;

/** This profile's last answer, or accepted answer, with one peer in the folder. */
const FolderActedSchema = v.strictObject({ pairingId: PairingIdSchema, at: v.number() });

export type FolderActed = v.InferOutput<typeof FolderActedSchema>;

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
export type RemoteController = v.InferOutput<typeof RemoteControllerSchema>;

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

/** One value per peer, keyed by its profile id; writes to one peer never lose another's. */
function peerRecords<T>(key: `local:${string}` | `session:${string}`, schema: v.GenericSchema<T>) {
  const whole = repository(key, v.record(ProfileIdSchema, schema));
  const all = async (): Promise<Record<string, T>> => (await whole.read()) ?? {};
  let queue = Promise.resolve();
  // Each write reads the record first, so two at once would otherwise drop one of them.
  const serial = (change: (records: Record<string, T>) => Record<string, T>) => {
    const next = queue.then(async () => whole.write(change(await all())));
    queue = next.catch(() => {});
    return next;
  };
  return {
    all,
    get: async (peer: string): Promise<T | null> => (await all())[peer] ?? null,
    /** Null removes the peer's value. */
    set: (peer: string, value: T | null) =>
      serial((records) => {
        const rest = Object.fromEntries(Object.entries(records).filter(([id]) => id !== peer));
        return value === null ? rest : { ...rest, [peer]: value };
      }),
    watch: whole.watch,
  };
}

export type PeerRecords<T> = ReturnType<typeof peerRecords<T>>;

export const identityRepository = repository("local:profileIdentity", ProfileIdentitySchema);
export const authorizedPeersRepository = peerRecords("local:authorizedPeers", AuthorizedPeerSchema);
// Local, so waiting in the folder survives a restart of the browser.
export const folderPairingRepository = repository("local:folderPairing", FolderPairingSchema);
// Session storage ends with the browser, as the link and anything it carried do.
export const peerLinksRepository = peerRecords("session:peerLinks", PeerLinkSchema);
export const pendingOffersRepository = peerRecords("session:pendingOffers", PendingOfferSchema);
export const folderActedRepository = peerRecords("session:folderActed", FolderActedSchema);
/** The profiles each linked peer said its links reach, under that peer. */
export const meshMembersRepository = peerRecords("session:meshMembers", v.array(MemberSchema));
export const remoteRecordingsRepository = peerRecords(
  "session:remoteRecordings",
  RemoteRecordingSchema,
);
/** On the controller: each peer's tabs as last reported, so they outlive a sleeping worker. */
export const peerTabsRepository = peerRecords("session:peerTabs", SharedTabsSchema);
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
