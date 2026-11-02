import { randomUUID } from "node:crypto";
import { link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

export const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && "code" in error && error.code === code;

// A temporary file beside the target, so a rename or link never crosses file systems.
async function writeTemporary(path: string, text: string): Promise<string> {
  const folder = dirname(path);
  await mkdir(folder, { recursive: true });
  const temporary = join(folder, `.${basename(path)}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, text, { flag: "wx" });
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  return temporary;
}

/** Writes beside the target and renames over it, so a crash leaves the old file or the new one. */
export async function writeAtomic(path: string, text: string): Promise<void> {
  const temporary = await writeTemporary(path, text);
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

/** Writes a file that never changes once written: true when it holds `text`, false when it differs. */
export async function writeOnce(path: string, text: string): Promise<boolean> {
  const temporary = await writeTemporary(path, text);
  try {
    // link() fails when the target exists, so an existing file is never replaced.
    await link(temporary, path);
    return true;
  } catch (error) {
    if (!hasCode(error, "EEXIST")) throw error;
    return (await readFile(path, "utf8")) === text;
  } finally {
    await rm(temporary, { force: true });
  }
}
