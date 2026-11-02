import { randomUUID } from "node:crypto";
import type { ServiceStateStore } from "@recnrun/persistence";
import {
  SERVICE_STATE_SCHEMA_VERSION,
  type ServiceLock,
  type ServiceState,
} from "@recnrun/protocol";

/** This process holds the lock (`nonce`), or another live instance answers at `state`. */
export type Claim = { kind: "claimed"; nonce: string } | { kind: "running"; state: ServiceState };

export interface ClaimOptions {
  store: ServiceStateStore;
  pid: number;
  /** Whether the service named by `state` answers its API with its token. */
  answers(state: ServiceState): Promise<boolean>;
  isAlive?(pid: number): boolean;
  now?(): number;
  pause?(ms: number): Promise<void>;
  /** A live lock without service.json is starting up for at most this long. */
  startupGraceMs?: number;
  timeoutMs?: number;
}

type Inspection =
  | { kind: "running"; state: ServiceState }
  | { kind: "stale"; nonce: string | undefined }
  | { kind: "starting" }
  | { kind: "retry" };

export class InstanceStartingError extends Error {
  constructor(lockPath: string) {
    super(`Another RECnRun service is still starting (${lockPath}); try again in a moment.`);
    this.name = "InstanceStartingError";
  }
}

/** `kill(pid, 0)` delivers nothing: ESRCH means gone, EPERM means alive under another user. */
export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

async function inspect(options: Required<ClaimOptions>): Promise<Inspection> {
  const { store } = options;
  const reading = await store.readLock();
  if (reading.kind === "absent") return { kind: "retry" };
  if (reading.kind === "invalid") return { kind: "stale", nonce: undefined };
  const { lock } = reading;
  if (!options.isAlive(lock.pid)) return { kind: "stale", nonce: lock.nonce };
  const state = await store.readState();
  if (state?.pid === lock.pid) {
    if (await options.answers(state)) return { kind: "running", state };
    return { kind: "stale", nonce: lock.nonce };
  }
  // A recycled pid that never writes service.json must not hold the lock forever.
  const age = options.now() - Date.parse(lock.createdAt);
  return age > options.startupGraceMs ? { kind: "stale", nonce: lock.nonce } : { kind: "starting" };
}

const defaults = {
  isAlive: isProcessAlive,
  now: Date.now,
  pause: (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)),
  startupGraceMs: 10_000,
  timeoutMs: 15_000,
};

/** Takes the per-user lock, recovering a stale one, or finds the instance that already runs. */
export async function claimInstance(claimOptions: ClaimOptions): Promise<Claim> {
  const options: Required<ClaimOptions> = { ...defaults, ...claimOptions };
  const { store, pid, now } = options;
  const deadline = now() + options.timeoutMs;
  for (;;) {
    const nonce = randomUUID();
    const createdAt = new Date(now()).toISOString();
    const lock: ServiceLock = {
      schemaVersion: SERVICE_STATE_SCHEMA_VERSION,
      pid,
      nonce,
      createdAt,
    };
    if (await store.createLock(lock)) return { kind: "claimed", nonce };
    const found = await inspect(options);
    if (found.kind === "running") return found;
    if (found.kind === "stale") await store.removeLock(found.nonce);
    if (found.kind !== "starting") continue;
    if (now() > deadline) throw new InstanceStartingError(store.lockPath);
    await options.pause(50);
  }
}
