import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The server modules shape every response, so they are frozen with the files they serve.
const FROZEN_ROOTS = ["src", "public"];
const FIXTURE_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const FREEZE_PATH = join(FIXTURE_ROOT, "freeze.json");

async function listFiles(root: string): Promise<string[]> {
  const entries = await readdir(join(FIXTURE_ROOT, root), { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) =>
      relative(FIXTURE_ROOT, join(entry.parentPath, entry.name)).split(sep).join("/"),
    );
}

/** SHA-256 of every frozen file, keyed by its path relative to apps/fixture, sorted by path. */
export async function hashAssets(): Promise<Record<string, string>> {
  const paths = (await Promise.all(FROZEN_ROOTS.map(listFiles))).flat().sort();
  const hashes: Record<string, string> = {};
  for (const path of paths) {
    hashes[path] = createHash("sha256")
      .update(await readFile(join(FIXTURE_ROOT, path)))
      .digest("hex");
  }
  return hashes;
}

/** The frozen hashes, or an empty set before the first freeze. */
export async function readFreeze(): Promise<Record<string, string>> {
  try {
    return JSON.parse(await readFile(FREEZE_PATH, "utf8")) as Record<string, string>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
