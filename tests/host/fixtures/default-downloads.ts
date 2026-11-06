import { existsSync, realpathSync } from "node:fs";
import { lstat, mkdir, readdir, readFile, rm, rmdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, relative } from "node:path";

/** The file the default-location folder holds with its run id; cleanup touches only a folder holding it. */
export const DOWNLOADS_MARKER = ".recnrun-host-downloads";

/** The only path of the owner's Downloads a host cell writes: `RECnRun/poc-downloads-launcher/<run>/`. */
const PARENTS = ["RECnRun", "poc-downloads-launcher"];
const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** A folder of the owner's Downloads this sample created exclusively and marked. */
export interface DefaultWorkspace {
  folder: string;
  /** The relative destination for chrome.downloads under the default directory. */
  relative: (name: string) => string;
  /** Removes every file in the folder, the folder, and the parents it created; `left` is what stayed. */
  clean: (reported: string[]) => Promise<{ removed: string[]; left: string[] }>;
}

async function requireRealFolder(path: string): Promise<void> {
  const entry = await lstat(path);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(
      `${path} is a symlink or not a folder; the default cell never writes through it.`,
    );
  }
}

/** Each parent below Downloads as a real folder, one level at a time; returns those created here. */
async function ownParents(downloads: string): Promise<{ parent: string; created: string[] }> {
  await requireRealFolder(downloads);
  if (realpathSync(downloads) !== downloads) {
    throw new Error(`${downloads} resolves through a symlink to ${realpathSync(downloads)}.`);
  }
  const created: string[] = [];
  let parent = downloads;
  for (const segment of PARENTS) {
    parent = join(parent, segment);
    if (await lstat(parent).catch(() => undefined)) await requireRealFolder(parent);
    else {
      await mkdir(parent);
      created.push(parent);
    }
  }
  return { parent, created };
}

async function createExclusively(folder: string, runId: string): Promise<void> {
  try {
    await mkdir(folder);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`${folder} already exists; the default cell writes only into a fresh folder.`);
  }
  await writeFile(join(folder, DOWNLOADS_MARKER), runId, { flag: "wx" });
}

async function requireMarker(folder: string, runId: string): Promise<void> {
  await requireRealFolder(folder);
  const marker = join(folder, DOWNLOADS_MARKER);
  const entry = await lstat(marker).catch(() => undefined);
  const held = entry?.isFile() ? await readFile(marker, "utf8") : undefined;
  if (held !== runId)
    throw new Error(`${folder} has no marker of run ${runId}; refusing to clean it.`);
}

/** Removes the folder's files (never following a link) and returns any entry it would not remove. */
async function emptyFolder(folder: string) {
  const removed: string[] = [];
  const kept: string[] = [];
  for (const name of await readdir(folder)) {
    const path = join(folder, name);
    if (name === DOWNLOADS_MARKER) continue;
    if ((await lstat(path)).isDirectory()) kept.push(path);
    else {
      await rm(path);
      removed.push(path);
    }
  }
  if (kept.length === 0) {
    await rm(join(folder, DOWNLOADS_MARKER));
    await rmdir(folder);
  }
  return { removed, kept };
}

/**
 * Prepares `<downloads>/RECnRun/poc-downloads-launcher/<runId>/` before a download: every ancestor
 * a real folder, the run folder created exclusively and marked, so cleanup removes only its own.
 */
export async function openDefaultWorkspace(
  runId: string,
  downloads = join(homedir(), "Downloads"),
): Promise<DefaultWorkspace> {
  if (!SAFE_NAME.test(runId)) throw new Error(`Unsafe run id: ${runId}`);
  const { parent, created } = await ownParents(downloads);
  const folder = join(parent, runId);
  await createExclusively(folder, runId);
  const shown = (path: string) => relative(dirname(downloads), path);
  const clean = async (reported: string[]) => {
    await requireMarker(folder, runId);
    const { removed, kept } = await emptyFolder(folder);
    for (const each of [...created].reverse()) await rmdir(each).catch(() => undefined);
    const left = [...kept, ...[folder, ...created].filter((each) => existsSync(each))];
    const outside = reported.filter((path) => dirname(path) !== folder);
    if (outside.length > 0)
      throw new Error(`Chrome wrote outside ${folder}: ${outside.join(", ")}`);
    return { removed: removed.map(shown), left: [...new Set(left)].map(shown) };
  };
  const relativeTo = (name: string) => [...PARENTS, runId, name].join("/");
  return { folder, relative: relativeTo, clean };
}
