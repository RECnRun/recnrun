import { randomUUID } from "node:crypto";
import { chmod, link, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

function openLockFile(folder: string, lockPath: string): LockFile {
  const readLock = async (): Promise<LockReading> => {
    const parsed = await readJson(lockPath, parseServiceLock);
    if (parsed === undefined) return { kind: "absent" };
    return parsed.ok ? { kind: "held", lock: parsed.value } : { kind: "invalid" };
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
      const reading = await readLock();
      if (reading.kind === "absent") return false;
      const matches =
        reading.kind === "invalid" ? nonce === undefined : reading.lock.nonce === nonce;
      if (!matches) return false;
      await rm(lockPath, { force: true });
      return true;
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
