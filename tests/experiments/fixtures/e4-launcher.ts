import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import * as v from "valibot";

/*
 * E4's launcher, in Node until P4.2 moves the scan into sh: it scans candidate Downloads folders for
 * the presence that carries the token it opened a profile with, keeps a launcher record, and runs
 * scripts/poc-cross-profile/catalog.sh, the single writer of registry.json.
 */

const NAMESPACE = "lab";
const CATALOG = fileURLToPath(
  new URL("../../../scripts/poc-cross-profile/catalog.sh", import.meta.url),
);
const SCAN_POLL_MS = 100;

const Uuid = v.pipe(v.string(), v.uuid());
const Time = v.pipe(v.number(), v.safeInteger());

/** The extension's RegistrationSchema restated: a presence.json as the launcher reads it. */
const PresenceFileSchema = v.strictObject({
  profileId: Uuid,
  displayName: v.string(),
  fingerprint: v.pipe(v.string(), v.regex(/^[0-9A-F:]+$/)),
  createdAt: Time,
  expiresAt: Time,
  namespace: v.literal(NAMESPACE),
  boot: Uuid,
});
export type PresenceFile = v.InferOutput<typeof PresenceFileSchema>;

/** One peer of registry.json, as RegistrySchema in apps/extension/src/p2p/registry.ts has it. */
export const RegistryPeerSchema = v.strictObject({
  profileId: Uuid,
  displayName: v.string(),
  fingerprint: v.string(),
  root: v.pipe(v.string(), v.regex(/^r[0-9]{1,3}$/)),
  lastSeenAt: Time,
  expiresAt: Time,
  boot: Uuid,
});

const RegistryFileSchema = v.strictObject({
  version: v.literal(1),
  namespace: v.literal(NAMESPACE),
  writtenAt: Time,
  launcher: v.strictObject({ boot: Uuid, fingerprint: v.optional(v.string()) }),
  peers: v.record(Uuid, RegistryPeerSchema),
});
type RegistryFile = v.InferOutput<typeof RegistryFileSchema>;

/** The namespace's folder under a Downloads root: catalog.sh's out-dir. */
export const namespaceFolder = (downloads: string) => join(downloads, "RECnRun", "poc", NAMESPACE);

const presenceFile = (downloads: string, profileId: string) =>
  join(namespaceFolder(downloads), "peers", profileId, "presence.json");

async function parsedFile<T>(
  schema: v.GenericSchema<unknown, T>,
  path: string,
): Promise<T | undefined> {
  try {
    const parsed = v.safeParse(schema, JSON.parse(await readFile(path, "utf8")));
    return parsed.success ? parsed.output : undefined;
  } catch {
    return undefined;
  }
}

/** The valid presence of `profileId` under a Downloads folder, or undefined. */
export const presenceIn = (downloads: string, profileId: string) =>
  parsedFile(PresenceFileSchema, presenceFile(downloads, profileId));

/** Writes a presence in the exact bytes the extension writes: JSON.stringify in the schema's order. */
export const writePresence = (downloads: string, presence: PresenceFile) =>
  writeFile(presenceFile(downloads, presence.profileId), JSON.stringify(presence));

/** Every valid presence under a Downloads folder; any other file counts as none. */
async function presencesIn(downloads: string): Promise<PresenceFile[]> {
  const folders = await readdir(join(namespaceFolder(downloads), "peers")).catch(() => []);
  const read = await Promise.all(folders.map((folder) => presenceIn(downloads, folder)));
  return read.filter((presence) => presence !== undefined);
}

export interface Found {
  downloads: string;
  presence: PresenceFile;
}

/** The launcher's scan: the first candidate holding a presence whose boot is `token`. */
async function scanFor(candidates: readonly string[], token: string): Promise<Found | undefined> {
  for (const downloads of candidates) {
    const presence = (await presencesIn(downloads)).find((each) => each.boot === token);
    if (presence) return { downloads, presence };
  }
  return undefined;
}

/** Scans until a candidate holds the token's presence or `ms` pass. */
export async function waitForToken(
  candidates: readonly string[],
  token: string,
  ms: number,
): Promise<Found | undefined> {
  const deadline = Date.now() + ms;
  for (;;) {
    const found = await scanFor(candidates, token);
    if (found || Date.now() > deadline) return found;
    await delay(SCAN_POLL_MS);
  }
}

/** A profile as the launcher record knows it; a root-only block names a folder it created. */
export interface RecordEntry {
  userDataDir?: string;
  profileId?: string;
  downloadsRoot?: string;
}

/** The launcher record: blocks of key=value lines separated by a blank line (PLAN.md decision 11). */
export function recordText(entries: readonly RecordEntry[]): string {
  const block = ({ userDataDir, profileId, downloadsRoot }: RecordEntry) => {
    const profile = userDataDir
      ? [`userDataDir=${userDataDir}`, "profileDirectory=Default", `namespace=${NAMESPACE}`]
      : [];
    const id = profileId ? [`profileId=${profileId}`] : [];
    const root = downloadsRoot ? [`downloadsRoot=${downloadsRoot}`] : [];
    return [...profile, ...id, ...(userDataDir ? ["role=worker"] : []), ...root].join("\n");
  };
  return `${entries.map(block).join("\n\n")}\n`;
}

/** Each downloadsRoot of a record and the root id catalog.sh wrote back, if any. */
export function rootIds(text: string): Map<string, string | undefined> {
  const ids = new Map<string, string | undefined>();
  for (const block of text.split(/\n\s*\n/)) {
    const values = new Map(
      block.split("\n").map((line) => line.split(/=(.*)/s, 2) as [string, string]),
    );
    const downloads = values.get("downloadsRoot");
    if (downloads) ids.set(downloads, values.get("root") ?? ids.get(downloads));
  }
  return ids;
}

export interface CatalogRun {
  code: number;
  stderr: string;
  registry: RegistryFile | undefined;
}

/** Runs catalog.sh once for the namespace folder of `downloads`, then reads what it wrote. */
export async function runCatalog(record: string, downloads: string): Promise<CatalogRun> {
  const out = namespaceFolder(downloads);
  const { code, stderr } = await new Promise<{ code: number; stderr: string }>((resolve) => {
    execFile("sh", [CATALOG, record, NAMESPACE, out], (error, _stdout, stderr) => {
      const code = error ? Number((error as { code?: unknown }).code ?? 1) : 0;
      resolve({ code, stderr });
    });
  });
  return {
    code,
    stderr,
    registry: await parsedFile(RegistryFileSchema, join(out, "registry.json")),
  };
}
