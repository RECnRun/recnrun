import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { createCdpAdapter } from "@recnrun/adapter";
import {
  openRotatingLog,
  openServiceStateStore,
  type ServiceStateStore,
} from "@recnrun/persistence";
import {
  SERVICE_STATE_SCHEMA_VERSION,
  type DiscoveryResult,
  type ServiceState,
} from "@recnrun/protocol";
import { forbidEgress } from "./egress.ts";
import { createHandlers } from "./handlers.ts";
import { claimInstance } from "./instance.ts";
import { createJournalRegistry, type JournalRegistry } from "./journals.ts";
import { createLogger, type Logger } from "./logger.ts";
import { createApiServer, type ApiServer } from "./server.ts";
import { SERVICE_VERSION } from "./version.ts";

export interface ServiceOptions {
  /** The user's home folder; state lives in `<home>/.recnrun`. */
  home: string;
  /** 0 (the default) lets the system pick a free port, written to service.json. */
  port?: number;
  discover?: () => Promise<DiscoveryResult>;
  /** `RECNRUN_FORBID_EGRESS=1` here forbids non-loopback connections in this process. */
  env?: Readonly<Record<string, string | undefined>>;
  log?: { maxBytes?: number; keep?: number };
}

/** The instance this process started. */
export interface RunningService {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly journals: JournalRegistry;
  /** Stops listening, drains every open journal, and removes service.json and the lock. */
  stop(): Promise<void>;
}

/** This process started the service, or another instance already answers for this user. */
export type StartResult =
  | { reused: false; service: RunningService }
  | { reused: true; state: ServiceState };

/** Whether the service named by `state` answers `capabilities.get` with its token. */
async function answers(state: ServiceState): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${state.port}/api`, {
      method: "POST",
      headers: { authorization: `Bearer ${state.token}`, "content-type": "application/json" },
      body: JSON.stringify({ requestId: "probe", command: "capabilities.get", params: {} }),
      signal: AbortSignal.timeout(1000),
    });
    const body: unknown = await response.json();
    return (
      response.ok && typeof body === "object" && body !== null && "ok" in body && body.ok === true
    );
  } catch {
    return false;
  }
}

function bind(server: Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      if (address !== null && typeof address === "object") resolve(address.port);
      else reject(new Error("The service socket has no TCP port."));
    });
  });
}

interface Parts {
  store: ServiceStateStore;
  nonce: string;
  api: ApiServer;
  journals: JournalRegistry;
  logger: Logger;
}

async function shutdown({ store, nonce, api, journals, logger }: Parts): Promise<void> {
  logger.info("service.stopping");
  await api.close();
  const failures = await journals.drain();
  for (const message of failures) logger.error("journal.close-failed", { message });
  await store.removeState(process.pid);
  await store.removeLock(nonce);
  logger.info("service.stopped");
  await logger.close();
}

async function listen(options: ServiceOptions, store: ServiceStateStore, nonce: string) {
  const startedAt = Date.now();
  const token = randomBytes(32).toString("base64url");
  const logger = createLogger(
    openRotatingLog({
      folder: store.logsFolder,
      name: "service.log",
      maxBytes: options.log?.maxBytes ?? 1024 * 1024,
      keep: options.log?.keep ?? 3,
    }),
  );
  const discover = options.discover ?? (() => createCdpAdapter().discover());
  const guard = { port: 0, token };
  const api = createApiServer({ guard, handlers: createHandlers({ startedAt, discover }), logger });
  guard.port = await bind(api.server, options.port ?? 0);
  await store
    .writeState({
      schemaVersion: SERVICE_STATE_SCHEMA_VERSION,
      pid: process.pid,
      port: guard.port,
      token,
      startedAt: new Date(startedAt).toISOString(),
      serviceVersion: SERVICE_VERSION,
    })
    .catch(async (error: unknown) => {
      await api.close();
      throw error;
    });
  logger.info("service.started", { port: guard.port, version: SERVICE_VERSION });
  const journals = createJournalRegistry();
  let stopped: Promise<void> | undefined;
  const service: RunningService = {
    port: guard.port,
    token,
    url: `http://127.0.0.1:${guard.port}`,
    journals,
    stop: () => (stopped ??= shutdown({ store, nonce, api, journals, logger })),
  };
  return service;
}

/** Starts the per-user service, or returns the one that already runs for `home`. */
export async function startService(options: ServiceOptions): Promise<StartResult> {
  if ((options.env ?? process.env).RECNRUN_FORBID_EGRESS === "1") forbidEgress();
  const store = openServiceStateStore({ home: options.home });
  const claim = await claimInstance({ store, pid: process.pid, answers });
  if (claim.kind === "running") return { reused: true, state: claim.state };
  try {
    return { reused: false, service: await listen(options, store, claim.nonce) };
  } catch (error) {
    await store.removeLock(claim.nonce);
    throw error;
  }
}
