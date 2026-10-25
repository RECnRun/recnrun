import * as v from "valibot";
import { decodePairing } from "@/p2p/pairing-code";
import { ProfileIdSchema } from "@/p2p/protocol";

/** The folder's own subfolder; nothing outside it is read, written, or removed. */
const ROOT = "recnrun-signaling";
const FILE_NAME = /^(offer|answer)-[0-9a-f-]{36}\.json$/;
const MAX_FILE_BYTES = 128 * 1024;

const SignalFileSchema = v.strictObject({
  kind: v.picklist(["offer", "answer"]),
  pairingId: v.pipe(v.string(), v.uuid()),
  profileId: ProfileIdSchema,
  expiresAt: v.number(),
  code: v.pipe(v.string(), v.maxLength(MAX_FILE_BYTES)),
});

/**
 * One half of a pairing, as a file: the same code the user would paste, which holds no secret,
 * since the user still accepts the other profile and its certificate fingerprint.
 */
export type SignalFile = v.InferOutput<typeof SignalFileSchema>;

type Directory = Pick<
  FileSystemDirectoryHandle,
  "getDirectoryHandle" | "getFileHandle" | "removeEntry" | "keys"
>;

const fileName = (kind: SignalFile["kind"], pairingId: string) => `${kind}-${pairingId}.json`;

/** The file a pairing code makes; the code's own fields name it, so they cannot disagree. */
export function signalFileOf(code: string, now = Date.now()): SignalFile {
  const { kind, pairingId, profileId, expiresAt } = decodePairing(code, now);
  return { kind, pairingId, profileId, expiresAt, code };
}

async function readSignal(folder: Directory, name: string, owner: string, now: number) {
  const file = await (await folder.getFileHandle(name)).getFile();
  if (file.size > MAX_FILE_BYTES) return undefined;
  const parsed = v.safeParse(SignalFileSchema, JSON.parse(await file.text()));
  // A file counts only in its owner's folder, and only until it expires.
  if (!parsed.success || parsed.output.profileId !== owner || parsed.output.expiresAt <= now)
    return undefined;
  return parsed.output;
}

async function* othersFiles(root: Directory, me: string) {
  for await (const owner of root.keys()) {
    if (owner === me || !v.is(ProfileIdSchema, owner)) continue;
    const folder = await root.getDirectoryHandle(owner).catch(() => undefined);
    if (!folder) continue;
    for await (const name of folder.keys()) if (FILE_NAME.test(name)) yield { folder, name, owner };
  }
}

/**
 * Signaling through a folder the user chose in both profiles: each profile writes only into its
 * own subfolder, reads the other's, and removes only its own files.
 */
export function folderSignaling(picked: Directory, me: string, now: () => number = Date.now) {
  const root = () => picked.getDirectoryHandle(ROOT, { create: true });
  const own = async () => (await root()).getDirectoryHandle(me, { create: true });
  // createWritable writes a swap file and swaps it in on close, so no reader sees half a file.
  const publish = async (signal: SignalFile) => {
    const handle = await (
      await own()
    ).getFileHandle(fileName(signal.kind, signal.pairingId), {
      create: true,
    });
    const writable = await handle.createWritable();
    await writable.write(JSON.stringify(signal));
    await writable.close();
  };
  const find = async (kind: SignalFile["kind"], pairingId?: string) => {
    const prefix = pairingId ? fileName(kind, pairingId) : `${kind}-`;
    for await (const { folder, name, owner } of othersFiles(await root(), me)) {
      if (!name.startsWith(prefix)) continue;
      const signal = await readSignal(folder, name, owner, now()).catch(() => undefined);
      if (signal) return signal;
    }
    return undefined;
  };
  /** Removes this profile's files: every one when a pairing ends, else only the expired ones. */
  const clean = async (all: boolean) => {
    const folder = await own();
    for await (const name of folder.keys()) {
      if (!FILE_NAME.test(name)) continue;
      const signal = all
        ? undefined
        : await readSignal(folder, name, me, now()).catch(() => undefined);
      if (!signal) await folder.removeEntry(name);
    }
  };
  return { publish, find, clean };
}

export type FolderSignaling = ReturnType<typeof folderSignaling>;

interface PickerWindow {
  showDirectoryPicker?: (options: { id: string; mode: "readwrite" }) => Promise<Directory>;
}

/** Asks the user for the folder; only a top-level page may, so the framed dashboard cannot. */
export async function pickFolder(page: Window = window): Promise<Directory> {
  const { showDirectoryPicker } = page as unknown as PickerWindow;
  if (!showDirectoryPicker) throw new Error("This browser cannot share a folder with a page.");
  return showDirectoryPicker.call(page, { id: "recnrun-signaling", mode: "readwrite" });
}
