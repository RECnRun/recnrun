import { lstat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

type Stat = (path: string) => Promise<unknown>;

/** The POC namespace folder under the owner's Downloads, when a run created it; nothing in it is read. */
export async function leakedPresence(
  home: string = homedir(),
  stat: Stat = lstat,
): Promise<string | undefined> {
  const folder = join(home, "Downloads", "RECnRun", "poc");
  try {
    await stat(folder);
    return folder;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Fails the run when any host spec wrote a POC presence into the owner's Downloads folder. */
export default async function globalTeardown(): Promise<void> {
  const leaked = await leakedPresence();
  if (leaked)
    throw new Error(`${leaked}: host specs wrote a POC presence into the owner's Downloads`);
}
