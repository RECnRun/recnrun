import { randomUUID } from "node:crypto";
import { link, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { namespaceFolder, presenceIn } from "./e4-launcher.ts";

/*
 * E7's stand-in for a launcher that publishes the presences (POC PLAN.md P3.6): Node in the harness,
 * never the extension. Every renewal period it rewrites each listed profile's own presence.json
 * with fresh `createdAt` and `expiresAt`, keeping every other key the profile wrote, its signed
 * identity statement and its boot included, since a launcher can make neither.
 */

const PRESENCE_TTL_MS = 60_000;
const RENEWAL_MS = PRESENCE_TTL_MS / 2;

/** What the launcher takes from a profile's own last presence, and the keys it stamps itself. */
export const LAUNCHER_TAKES = [
  "profileId",
  "displayName",
  "fingerprint",
  "identity",
  "namespace",
  "boot",
];
export const LAUNCHER_STAMPS = ["createdAt", "expiresAt"];

const presencePath = (downloads: string, profileId: string) =>
  join(namespaceFolder(downloads), "peers", profileId, "presence.json");

/** The calls that replace a presence file; tests wrap them to interleave a profile's own publication. */
export const stampIo = { rename, link };

/** A rejection handler that answers `value` for the errno `code` and rethrows any other. */
const unless =
  <T>(code: string, value: T) =>
  (error: unknown) => {
    if ((error as NodeJS.ErrnoException).code === code) return value;
    throw error;
  };

async function fileAt(path: string) {
  const [text, info] = await Promise.all([readFile(path, "utf8"), stat(path)]);
  return { text, mtimeMs: info.mtimeMs };
}

/**
 * Takes the file aside by an atomic rename, so what was taken is what is judged, then puts the
 * stamped one back with a link that fails when the profile published in between: its newer boot,
 * certificate, or statement always wins, and a taken file that is newer goes back.
 */
async function replaceIfUnchanged(
  path: string,
  temporary: string,
  seen: Awaited<ReturnType<typeof fileAt>>,
) {
  const held = `${path}.${randomUUID()}.held`;
  try {
    const moved = await stampIo.rename(path, held).then(() => true, unless("ENOENT", false));
    if (!moved) return false;
    const taken = await fileAt(held);
    const unchanged = taken.text === seen.text && taken.mtimeMs === seen.mtimeMs;
    const linked = stampIo.link(unchanged ? temporary : held, path);
    return await linked.then(() => unchanged, unless("EEXIST", false));
  } finally {
    await Promise.all([rm(held, { force: true }), rm(temporary, { force: true })]);
  }
}

/** Rewrites one presence unless the profile replaced the file since it was read. */
export async function restamp(downloads: string, profileId: string): Promise<boolean> {
  const path = presencePath(downloads, profileId);
  const seen = await fileAt(path).catch(unless("ENOENT", undefined));
  const presence = await presenceIn(downloads, profileId);
  if (seen === undefined || presence === undefined) return false;
  const now = Date.now();
  const text = JSON.stringify({ ...presence, createdAt: now, expiresAt: now + PRESENCE_TTL_MS });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text);
  return replaceIfUnchanged(path, temporary, seen);
}

export interface LauncherPresence {
  /** Stops renewing a profile, as a launcher does once that profile's Chrome exited. */
  drop(profileId: string): void;
  /** Renews a profile again, as a launcher does once it relaunched it. */
  add(profileId: string): void;
  /** Ends the loop; answers the writes per profile and the identity statements it replayed. */
  stop(): Promise<{ writes: Record<string, number>; replayed: Record<string, number[]> }>;
}

/** The launcher's renewal loop: each renewal period, every profile it renews gets a fresh presence. */
export function launcherPresence(
  downloads: string,
  profileIds: readonly string[],
): LauncherPresence {
  const abort = new AbortController();
  const renewing = new Set(profileIds);
  const writes = new Map<string, number>(profileIds.map((id) => [id, 0]));
  const replayed = new Map<string, Set<number>>();
  let failure: unknown;
  const renew = async (id: string) => {
    const signedAt = (await presenceIn(downloads, id))?.identity.signedAt;
    if (!(await restamp(downloads, id))) return;
    writes.set(id, (writes.get(id) ?? 0) + 1);
    if (signedAt !== undefined) replayed.set(id, (replayed.get(id) ?? new Set()).add(signedAt));
  };
  const done = (async () => {
    while (!abort.signal.aborted) {
      for (const id of renewing) await renew(id).catch((error: unknown) => (failure ??= error));
      await delay(RENEWAL_MS, undefined, { signal: abort.signal }).catch(() => undefined);
    }
  })();
  return {
    drop: (id) => void renewing.delete(id),
    add: (id) => void renewing.add(id),
    stop: async () => {
      abort.abort();
      await done;
      if (failure !== undefined) throw failure;
      const statements = [...replayed].map(([id, set]): [string, number[]] => [id, [...set]]);
      return { writes: Object.fromEntries(writes), replayed: Object.fromEntries(statements) };
    },
  };
}
