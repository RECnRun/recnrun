import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

function git(cwd, ...args) {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    return undefined;
  }
}

/** HEAD's sha when the working tree has no change, untracked files included; else undefined. */
export function cleanHead(cwd) {
  if (git(cwd, "status", "--porcelain") !== "") return undefined;
  return git(cwd, "rev-parse", "--verify", "HEAD")?.trim();
}

function markerPath(cwd, sha) {
  return join(cwd, ".artifacts/verified", sha);
}

/** The marker of a verify that passed on commit `sha`, when there is one. */
export function commitMarker(cwd, sha) {
  const marker = sha && markerPath(cwd, sha);
  return marker && existsSync(marker) ? marker : undefined;
}

/** The marker of a verify that passed on HEAD, when the tree is still clean. */
export function verifiedMarker(cwd) {
  return commitMarker(cwd, cleanHead(cwd));
}

/** Records a passing verify when the tree was clean on the same commit before and after it. */
export async function recordVerified(cwd, before, runId) {
  if (!before || cleanHead(cwd) !== before) return undefined;
  const marker = markerPath(cwd, before);
  await mkdir(dirname(marker), { recursive: true });
  await writeFile(marker, `${runId}\n`);
  return marker;
}
