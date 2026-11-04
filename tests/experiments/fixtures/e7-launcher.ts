import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
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

/** Rewrites one presence by a rename, unless the profile replaced the file since it was read. */
async function restamp(downloads: string, profileId: string): Promise<boolean> {
  const path = presencePath(downloads, profileId);
  const read = await readFile(path, "utf8").catch(() => undefined);
  const presence = await presenceIn(downloads, profileId);
  if (read === undefined || presence === undefined) return false;
  const now = Date.now();
  const text = JSON.stringify({ ...presence, createdAt: now, expiresAt: now + PRESENCE_TTL_MS });
  const temporary = `${path}.${randomUUID()}.tmp`;
  await writeFile(temporary, text);
  // A profile's own write between the read and here carries a newer boot; it wins.
  if ((await readFile(path, "utf8").catch(() => undefined)) !== read) {
    await rm(temporary, { force: true });
    return false;
  }
  await rename(temporary, path);
  return true;
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
