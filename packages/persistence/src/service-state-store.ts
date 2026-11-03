import { createHash, randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  parseServiceLock,
  parseServiceState,
  type ServiceFileParse,
  type ServiceLock,
  type ServiceState,
} from "@recnrun/protocol";

/** What `service.lock` holds right now. */
export type LockReading =
  | { kind: "absent" }
  | { kind: "invalid" }
  | { kind: "held"; lock: ServiceLock };

/** The running service's files in `<home>/.recnrun`: `service.json`, `service.lock`, `logs/`. */
export interface ServiceStateStore {
  readonly statePath: string;
  readonly lockPath: string;
  readonly logsFolder: string;
  /** The state a running service wrote; absent or unreadable is undefined, since it is rewritten. */
  readState(): Promise<ServiceState | undefined>;
  /** Writes `service.json` atomically at mode 0600. */
  writeState(state: ServiceState): Promise<void>;
  /** Removes `service.json` only when `pid` wrote it. */
  removeState(pid: number): Promise<boolean>;
  /** Creates `service.lock` only when none exists; false when another claim holds it. */
  createLock(lock: ServiceLock): Promise<boolean>;
  readLock(): Promise<LockReading>;
  /** Removes the lock only while it holds `nonce`; `undefined` removes an unreadable lock. */
  removeLock(nonce: string | undefined): Promise<boolean>;
}

const errorCode = (error: unknown): unknown =>
  error instanceof Error && "code" in error ? error.code : undefined;

async function readJson<T>(
  path: string,
  parse: (input: unknown) => ServiceFileParse<T>,
): Promise<ServiceFileParse<T> | undefined> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (errorCode(error) === "ENOENT") return undefined;
    throw error;
  }
  try {
    return parse(JSON.parse(text));
  } catch {
    return { ok: false, message: "not JSON" };
  }
}

async function privateFolder(folder: string): Promise<void> {
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await chmod(folder, 0o700);
}

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Validates `value` and writes it to a new private file in `folder`; returns that file's path. */
async function stage<T>(
  folder: string,
  name: string,
  parse: (input: unknown) => ServiceFileParse<T>,
  value: T,
): Promise<string> {
  const parsed = parse(value);
  if (!parsed.ok) throw new Error(`Refusing to write an invalid ${name}: ${parsed.message}`);
  await privateFolder(folder);
  const staging = join(folder, `.${name}.${randomUUID()}.tmp`);
  await writeFile(staging, serialize(parsed.value), { mode: 0o600, flag: "wx" });
  return staging;
}

type LockFile = Pick<ServiceStateStore, "createLock" | "readLock" | "removeLock">;

// A removal claim lives for a read and a rename; one this old belongs to a remover that died.
const CLAIM_STALE_MS = 10_000;

const claimKey = (nonce: string | undefined) =>
  nonce === undefined ? "invalid" : createHash("sha256").update(nonce).digest("hex").slice(0, 32);

const holds = (reading: LockReading, nonce: string | undefined) =>
  reading.kind === "invalid"
    ? nonce === undefined
    : reading.kind === "held" && reading.lock.nonce === nonce;

/** Takes the sole right to remove the lock holding `key`; undefined while a live remover has it. */
async function claimRemoval(folder: string, key: string): Promise<string[] | undefined> {
  const attempts: string[] = [];
  for (let attempt = 1; ; attempt += 1) {
    const path = join(folder, `.service.lock.${key}.${attempt}.claim`);
    attempts.push(path);
    try {
      await writeFile(path, "", { mode: 0o600, flag: "wx" });
      return attempts;
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
    }
    const held = await stat(path).catch(() => undefined);
    if (held === undefined || Date.now() - held.mtimeMs < CLAIM_STALE_MS) return undefined;
  }
}

function openLockFile(folder: string, lockPath: string): LockFile {
  const readLockAt = async (path: string): Promise<LockReading> => {
    const parsed = await readJson(path, parseServiceLock);
    if (parsed === undefined) return { kind: "absent" };
    return parsed.ok ? { kind: "held", lock: parsed.value } : { kind: "invalid" };
  };
  const readLock = () => readLockAt(lockPath);
  // Moved aside before the check, so the lock checked is the lock removed, never a newer one.
  const displace = async (nonce: string | undefined): Promise<boolean> => {
    if (!holds(await readLock(), nonce)) return false;
    const moved = join(folder, `.service.lock.${randomUUID()}.removed`);
    try {
      await rename(lockPath, moved);
    } catch (error) {
      if (errorCode(error) === "ENOENT") return false;
      throw error;
    }
    const removed = holds(await readLockAt(moved), nonce);
    // A remover that outlived its claim moved a newer owner's lock: put it back.
    if (!removed) await link(moved, lockPath).catch(() => undefined);
    await rm(moved, { force: true });
    return removed;
  };
  return {
    async createLock(lock) {
      const staging = await stage(folder, "service.lock", parseServiceLock, lock);
      // Linked from a complete file, so no reader ever sees a lock without its content.
      try {
        await link(staging, lockPath);
        return true;
      } catch (error) {
        if (errorCode(error) === "EEXIST") return false;
        throw error;
      } finally {
        await rm(staging, { force: true });
      }
    },
    readLock,
    async removeLock(nonce) {
      const claim = await claimRemoval(folder, claimKey(nonce));
      if (claim === undefined) return false;
      try {
        return await displace(nonce);
      } finally {
        await Promise.all(claim.map((path) => rm(path, { force: true })));
      }
    },
  };
}

/** Opens the service files of the user whose home folder is `home`. */
export function openServiceStateStore({ home }: { home: string }): ServiceStateStore {
  const folder = join(home, ".recnrun");
  const statePath = join(folder, "service.json");
  const lockPath = join(folder, "service.lock");
  const readState = async () => {
    const parsed = await readJson(statePath, parseServiceState);
    return parsed?.ok ? parsed.value : undefined;
  };
  return {
    statePath,
    lockPath,
    logsFolder: join(folder, "logs"),
    readState,
    async writeState(state) {
      const staging = await stage(folder, "service.json", parseServiceState, state);
      // Renamed over the target, so a reader sees the old file or the new one, never half of one.
      await rename(staging, statePath).catch(async (error: unknown) => {
        await rm(staging, { force: true });
        throw error;
      });
    },
    async removeState(pid) {
      if ((await readState())?.pid !== pid) return false;
      await rm(statePath, { force: true });
      return true;
    },
    ...openLockFile(folder, lockPath),
  };
}
