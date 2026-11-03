import { existsSync, lstatSync, realpathSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join, sep } from "node:path";

/** The only folder host runs may use for Chrome roots (POC PLAN.md §8). */
export const HOST_FOLDER = join(homedir(), "Documents", "RECnRun", "poc-downloads-launcher");

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

/** Creates `<roots>/roots/<runId>/<name>/` and checks it is still inside `folder` once created. */
export async function rootFor(
  roots: string,
  runId: string,
  name: string,
  folder: string = HOST_FOLDER,
): Promise<string> {
  for (const segment of [runId, name]) {
    if (!SAFE_NAME.test(segment)) throw new Error(`Unsafe root name segment: ${segment}`);
  }
  let path = hostRoots(roots, folder);
  // One level at a time, so a symlink planted on the way is refused before anything is written through it.
  for (const segment of ["roots", runId, name]) {
    path = join(path, segment);
    if (!existsSync(path)) await mkdir(path);
    path = requireInside(path, folder);
  }
  return path;
}
