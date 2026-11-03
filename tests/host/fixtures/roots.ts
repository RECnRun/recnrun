import { existsSync, lstatSync, realpathSync } from "node:fs";
import { lstat, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, sep } from "node:path";

/** The only folder host runs may use for Chrome roots (POC PLAN.md §8). */
export const HOST_FOLDER = join(homedir(), "Documents", "RECnRun", "poc-downloads-launcher");

/** The file every host root holds with its run id; teardown deletes only roots that hold it. */
export const ROOT_MARKER = ".recnrun-host-root";

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** The folder's real path; a symlinked folder could send every root anywhere. */
function realFolder(folder: string): string {
  if (!existsSync(folder)) throw new Error(`The host folder ${folder} does not exist; create it.`);
  if (lstatSync(folder).isSymbolicLink())
    throw new Error(`The host folder ${folder} is a symlink.`);
  return realpathSync(folder);
}

function requireInside(path: string, folder: string): string {
  const real = realpathSync(path);
  const base = realFolder(folder);
  if (real === base || real.startsWith(base + sep)) return real;
  throw new Error(`${path} resolves to ${real}, outside ${base}; host roots live only there.`);
}

/**
 * The real path of RECNRUN_HOST_ROOTS, which must be `folder` or a folder inside it after every
 * symlink is resolved. Throws on anything else, so a host run never names a root elsewhere.
 */
export function hostRoots(
  value = process.env.RECNRUN_HOST_ROOTS,
  folder: string = HOST_FOLDER,
): string {
  if (!value) {
    throw new Error(`RECNRUN_HOST_ROOTS is not set; set it to ${folder} or a folder inside it.`);
  }
  if (!isAbsolute(value))
    throw new Error(`RECNRUN_HOST_ROOTS (${value}) must be an absolute path.`);
  if (value.split("/").includes("..")) {
    throw new Error(`RECNRUN_HOST_ROOTS (${value}) must not contain .. segments.`);
  }
  if (!existsSync(value)) throw new Error(`RECNRUN_HOST_ROOTS (${value}) does not exist.`);
  return requireInside(value, folder);
}

/** `parent/segment` as a real folder, created when missing; a symlink in its place is refused. */
async function childFolder(parent: string, segment: string, folder: string): Promise<string> {
  const path = join(parent, segment);
  if (!existsSync(path)) await mkdir(path);
  const real = requireInside(path, folder);
  if (real !== path)
    throw new Error(`${path} is a symlink to ${real}; host roots never go through one.`);
  return real;
}

/** Creates `<parent>/<name>` exclusively, so a root is never an existing folder or a planted symlink. */
async function freshFolder(parent: string, name: string): Promise<string> {
  const path = join(parent, name);
  try {
    await mkdir(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    throw new Error(`${path} already exists; every host root starts fresh.`);
  }
  if (realpathSync(path) !== path || dirname(path) !== parent) {
    throw new Error(`${path} is not a folder of its own below ${parent}.`);
  }
  return path;
}

/**
 * Creates `<roots>/roots/<runId>/<name>/` fresh, strictly below the run folder, and marks it with
 * the run id so teardown deletes only roots this run created.
 */
export async function rootFor(
  roots: string,
  runId: string,
  name: string,
  folder: string = HOST_FOLDER,
): Promise<string> {
  for (const segment of [runId, name]) {
    if (!SAFE_NAME.test(segment)) throw new Error(`Unsafe root name segment: ${segment}`);
  }
  let parent = hostRoots(roots, folder);
  // One level at a time, so a symlink planted on the way is refused before anything is written through it.
  for (const segment of ["roots", runId]) parent = await childFolder(parent, segment, folder);
  const root = await freshFolder(parent, name);
  await writeFile(join(root, ROOT_MARKER), runId, { flag: "wx" });
  return root;
}

async function markerOf(root: string): Promise<string | undefined> {
  const marker = join(root, ROOT_MARKER);
  const entry = await lstat(marker).catch(() => undefined);
  return entry?.isFile() ? readFile(marker, "utf8") : undefined;
}

/** Deletes a root only when it is a real folder `roots/<runId>/<name>` holding this run's marker. */
export async function removeHostRoot(
  root: string,
  runId: string,
  folder: string = HOST_FOLDER,
): Promise<void> {
  const entry = await lstat(root);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`${root} is a symlink or not a folder; refusing to delete it.`);
  }
  const real = requireInside(root, folder);
  const run = dirname(real);
  if (real !== root || basename(run) !== runId || basename(dirname(run)) !== "roots") {
    throw new Error(`${root} is not a root of run ${runId}; refusing to delete it.`);
  }
  if ((await markerOf(root)) !== runId) {
    throw new Error(`${root} has no ${ROOT_MARKER} marker of run ${runId}; refusing to delete it.`);
  }
  // Chrome's helper processes can still hold files for a moment after the browser exits.
  await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
