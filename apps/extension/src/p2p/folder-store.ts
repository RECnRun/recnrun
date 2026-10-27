import { readStored, writeStored } from "@/p2p/p2p-database";

const STORE = "folders";
const KEY = "recnrun";
/** Where each profile pairs; recordings/ beside it is reserved for M1. */
export const PAIRING_FOLDER = "pairing";
const RECORDINGS_FOLDER = "recordings";

/** Whether this profile may use the folder: none chosen, Chrome asks again, or granted. */
export type FolderAccess = "none" | "prompt" | "granted";

interface PermissionHandle {
  queryPermission: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
  requestPermission: (descriptor: { mode: "readwrite" }) => Promise<PermissionState>;
}

interface PickerWindow {
  showDirectoryPicker?: (options: {
    id: string;
    mode: "readwrite";
    startIn: "documents";
  }) => Promise<FileSystemDirectoryHandle>;
}

/** The RECnRun folder this profile chose, as IndexedDB keeps its handle. */
export async function loadFolder(): Promise<FileSystemDirectoryHandle | undefined> {
  const stored = await readStored(STORE, KEY);
  return stored instanceof FileSystemDirectoryHandle ? stored : undefined;
}

export async function folderAccess(
  folder: FileSystemDirectoryHandle | undefined,
): Promise<FolderAccess> {
  if (!folder) return "none";
  const state = await (folder as unknown as PermissionHandle).queryPermission({
    mode: "readwrite",
  });
  return state === "granted" ? "granted" : "prompt";
}

/** Asks the user for the folder; only a top-level page may. */
export async function pickFolder(page: Window = window): Promise<FileSystemDirectoryHandle> {
  const { showDirectoryPicker } = page as unknown as PickerWindow;
  if (!showDirectoryPicker) throw new Error("This browser cannot share a folder with a page.");
  // Chrome refuses the home folder and Documents itself, so the user makes RECnRun inside.
  return showDirectoryPicker.call(page, {
    id: "recnrun-folder",
    mode: "readwrite",
    startIn: "documents",
  });
}

/** Asks for the folder, lays it out, and keeps its handle for the offscreen document. */
export async function chooseFolder(pick: () => Promise<FileSystemDirectoryHandle> = pickFolder) {
  const folder = await pick();
  await folder.getDirectoryHandle(PAIRING_FOLDER, { create: true });
  await folder.getDirectoryHandle(RECORDINGS_FOLDER, { create: true });
  await writeStored(STORE, KEY, folder);
}

/** Asks Chrome again for the folder chosen before, as it does once the grant ended. */
export async function allowFolder(load: typeof loadFolder = loadFolder): Promise<void> {
  const folder = await load();
  if (!folder) throw new Error("Choose the RECnRun folder first.");
  const state = await (folder as unknown as PermissionHandle).requestPermission({
    mode: "readwrite",
  });
  if (state !== "granted") throw new Error("Chrome did not allow RECnRun to use the folder.");
}
