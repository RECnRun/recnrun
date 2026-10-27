import * as v from "valibot";
import { DisplayNameSchema, decodePairing } from "@/p2p/pairing-code";
import { ProfileIdSchema } from "@/p2p/protocol";

const PRESENCE_FILE = "presence.json";
const SIGNAL_NAME = /^(offer|answer)-[0-9a-f-]{36}\.json$/;
const MAX_FILE_BYTES = 128 * 1024;
/** A presence lasts this long unless refreshed, so a profile that stopped waiting drops out. */
export const PRESENCE_TTL_MS = 60 * 1000;

/** A profile waiting in the folder to pair: who it is, its certificate, and since when. */
export const PresenceSchema = v.strictObject({
  profileId: ProfileIdSchema,
  displayName: DisplayNameSchema,
  fingerprint: v.pipe(v.string(), v.regex(/^[0-9A-F:]+$/)),
  createdAt: v.number(),
  expiresAt: v.number(),
});

export type Presence = v.InferOutput<typeof PresenceSchema>;

export const SignalFileSchema = v.strictObject({
  kind: v.picklist(["offer", "answer"]),
  pairingId: v.pipe(v.string(), v.uuid()),
  profileId: ProfileIdSchema,
  /** The one profile it is for; every other ignores it. */
  to: ProfileIdSchema,
  expiresAt: v.number(),
  code: v.pipe(v.string(), v.maxLength(MAX_FILE_BYTES)),
});

/**
 * One half of a pairing, as a file: the same code the user would paste, which holds no secret,
 * since the link still proves the certificate fingerprint the code announces.
 */
export type SignalFile = v.InferOutput<typeof SignalFileSchema>;

/** What the other profiles left for this one. */
export interface Seen {
  presences: Presence[];
  signals: SignalFile[];
}

type Directory = Pick<
  FileSystemDirectoryHandle,
  "getDirectoryHandle" | "getFileHandle" | "removeEntry" | "keys"
>;

/** The file a pairing code makes; the code's own fields name it, so they cannot disagree. */
export function signalFileOf(code: string, to: string, now = Date.now()): SignalFile {
  const { kind, pairingId, profileId, expiresAt } = decodePairing(code, now);
  return { kind, pairingId, profileId, to, expiresAt, code };
}

async function readFile<T>(folder: Directory, name: string, schema: v.GenericSchema<T>) {
  const file = await (await folder.getFileHandle(name)).getFile();
  if (file.size > MAX_FILE_BYTES) return undefined;
  const parsed = v.safeParse(schema, JSON.parse(await file.text()));
  return parsed.success ? parsed.output : undefined;
}

async function writeFile(folder: Directory, name: string, value: unknown) {
  // createWritable writes a swap file and swaps it in on close, so no reader sees half a file.
  const writable = await (await folder.getFileHandle(name, { create: true })).createWritable();
  await writable.write(JSON.stringify(value));
  await writable.close();
}

async function namesIn(folder: Directory): Promise<string[]> {
  const names: string[] = [];
  for await (const name of folder.keys()) names.push(name);
  return names;
}

/** One other profile's folder: its presence, and its signals for this profile. */
async function readOwner(folder: Directory, owner: string, me: string, now: number) {
  // A file counts only in its owner's folder, and only until it expires.
  const current = (item: { profileId: string; expiresAt: number } | undefined) =>
    item?.profileId === owner && item.expiresAt > now ? item : undefined;
  const presence = await readFile(folder, PRESENCE_FILE, PresenceSchema).catch(() => undefined);
  const signals: SignalFile[] = [];
  for (const name of (await namesIn(folder)).filter((each) => SIGNAL_NAME.test(each))) {
    const signal = await readFile(folder, name, SignalFileSchema).catch(() => undefined);
    if (current(signal) && signal?.to === me) signals.push(signal);
  }
  return { presence: current(presence) && presence, signals };
}

/**
 * Pairing through the folder every profile chose: each writes only into its own subfolder of
 * `pairing`, reads the others', and removes only its own files.
 */
export function folderRendezvous(pairing: Directory, me: string, now: () => number = Date.now) {
  const own = () => pairing.getDirectoryHandle(me, { create: true });
  const remove = async (matches: (name: string) => boolean) => {
    const folder = await own();
    for (const name of (await namesIn(folder)).filter(matches)) await folder.removeEntry(name);
  };
  const announce = async (presence: Presence) => writeFile(await own(), PRESENCE_FILE, presence);
  /**
   * Replaces this profile's earlier signal of the same kind for the same profile, so only the
   * current one counts, and answers to two offerers both stay until each reads its own.
   */
  const publish = async (signal: SignalFile) =>
    writeFile(await own(), `${signal.kind}-${signal.to}.json`, signal);
  const look = async (): Promise<Seen> => {
    const seen: Seen = { presences: [], signals: [] };
    for (const owner of await namesIn(pairing)) {
      if (owner === me || !v.is(ProfileIdSchema, owner)) continue;
      const folder = await pairing.getDirectoryHandle(owner).catch(() => undefined);
      if (!folder) continue;
      const { presence, signals } = await readOwner(folder, owner, me, now());
      if (presence) seen.presences.push(presence);
      seen.signals.push(...signals);
    }
    return seen;
  };
  /** Removes this profile's presence and signals once it stops waiting. */
  const clean = () => remove((name) => name === PRESENCE_FILE || SIGNAL_NAME.test(name));
  return { announce, publish, look, clean };
}
