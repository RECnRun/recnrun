import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import { join } from "node:path";
import { createLeaseRegistry } from "@recnrun/engine";
import {
  openBindingsStore,
  openFlowStore,
  openRotatingLog,
  openServiceStateStore,
  recoverRuns,
  type FlowStore,
  type ServiceStateStore,
} from "@recnrun/persistence";
import {
  SERVICE_STATE_SCHEMA_VERSION,
  type DiscoveryResult,
  type ServiceState,
} from "@recnrun/protocol";
import { createBrowserPort, type BrowserPort } from "./browser.ts";
import { createCommands, type CommandDeps } from "./commands.ts";
import { forbidEgress } from "./egress.ts";
import type { CommandHandlers } from "./dispatch.ts";
import { createHandlers } from "./handlers.ts";
import { createEventHub } from "./hub.ts";
import { claimInstance } from "./instance.ts";
import { createJournalRegistry, type JournalRegistry } from "./journals.ts";
import { createLogger, type Logger } from "./logger.ts";
import { cancelReplays } from "./runs.ts";
import { createApiServer, type ApiServer } from "./server.ts";
import { stopAll } from "./sessions.ts";
import { SERVICE_VERSION } from "./version.ts";

export interface ServiceOptions {
  /** The user's home folder; state lives in `<home>/.recnrun`. */
  home: string;
  /** 0 (the default) lets the system pick a free port, written to service.json. */
  port?: number;
  /** Discovery of the default profile; it overrides the adapter's, so tests can name their Chrome. */
  discover?: () => Promise<DiscoveryResult>;
  /** Chrome as the session, picker, and replay commands reach it; the CDP adapter by default. */
  adapter?: BrowserPort;
  /** The built UI served on `GET /`; `apps/ui/dist` by default. */
  uiRoot?: string;
  /** Handlers that replace or add to the built-in ones; the F2.5 executor and tests pass theirs here. */
  handlers?: CommandHandlers;
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

// A person's control lapses after this long without activity on their page.
const LEASE_TTL_MS = 10 * 60 * 1000;

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
  commands: CommandDeps;
  flows: FlowStore;
}

// A cancelled replay gets this long to finish its step under way before its journal closes.
const REPLAY_GRACE_MS = 5000;

/** Whether the work settled within the grace. */
const settledInGrace = (work: Promise<unknown>[]) =>
  Promise.race([
    Promise.allSettled(work).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), REPLAY_GRACE_MS).unref()),
  ]);

async function shutdown(parts: Parts): Promise<void> {
  const { store, nonce, api, journals, logger } = parts;
  logger.info("service.stopping");
  await api.close();
  await stopAll(parts.commands);
  cancelReplays(parts.commands);
  const active = [...parts.commands.active];
  if (!(await settledInGrace(active)))
    logger.warn("service.replay-unsettled", { count: parts.commands.active.size });
  await parts.commands.browser.close().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    logger.warn("service.browser-close-failed", { message });
  });
  const failures = await journals.drain();
  for (const message of failures) logger.error("journal.close-failed", { message });
  parts.flows.close();
  await store.removeState(process.pid);
  await store.removeLock(nonce);
  logger.info("service.stopped");
  await logger.close();
}

function commandDeps(
  options: ServiceOptions,
  parts: { logger: Logger; flows: FlowStore; journals: JournalRegistry },
) {
  const real = options.adapter ?? createBrowserPort();
  const discover = options.discover ?? (() => real.discover());
  // A binding's folder goes to the adapter; the default profile is whatever `discover` finds.
  const browser: BrowserPort = {
    ...real,
    discover: (found) => (found?.userDataDir ? real.discover(found) : discover()),
  };
  const commands: CommandDeps = {
    home: options.home,
    browser,
    logger: parts.logger,
    journals: parts.journals,
    bindings: openBindingsStore({ home: options.home }),
    hub: createEventHub(),
    leases: createLeaseRegistry({
      now: Date.now,
      ttlMs: LEASE_TTL_MS,
    }),
    now: Date.now,
    sessions: new Map(),
    store: () => parts.flows,
    runs: new Map(),
    active: new Set(),
  };
  return { commands, discover };
}

/** Closes the runs a killed service left open; a run it cannot read is logged and left as it is. */
async function recoverInterrupted(flows: FlowStore, logger: Logger) {
  const report = await recoverRuns(flows, () => new Date()).catch((error: unknown) => {
    logger.error("run.recovery-failed", { message: error instanceof Error ? error.message : "" });
    return { recovered: [], problems: [] };
  });
  for (const run of report.recovered) logger.warn("run.recovered", run);
  for (const problem of report.problems) logger.error("run.recovery-skipped", problem);
}

const openLogger = (options: ServiceOptions, store: ServiceStateStore) =>
  createLogger(
    openRotatingLog({
      folder: store.logsFolder,
      name: "service.log",
      maxBytes: options.log?.maxBytes ?? 1024 * 1024,
      keep: options.log?.keep ?? 3,
    }),
  );

async function listen(options: ServiceOptions, store: ServiceStateStore, nonce: string) {
  const startedAt = Date.now();
  const token = randomBytes(32).toString("base64url");
  const logger = openLogger(options, store);
  const flows = await openFlowStore({ home: options.home });
  await recoverInterrupted(flows, logger);
  const journals = createJournalRegistry();
  const { commands, discover } = commandDeps(options, { logger, flows, journals });
  const guard = { port: 0, token };
  const api = createApiServer({
    guard,
    handlers: {
      ...createHandlers({ startedAt, discover }),
      ...createCommands(commands),
      ...options.handlers,
    },
    logger,
    uiRoot: options.uiRoot ?? join(import.meta.dirname, "..", "..", "ui", "dist"),
  });
  guard.port = await bind(api.server, options.port ?? 0).catch((error: unknown) => {
    flows.close();
    throw error;
  });
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
      flows.close();
      throw error;
    });
  logger.info("service.started", { port: guard.port, version: SERVICE_VERSION });
  let stopped: Promise<void> | undefined;
  const service: RunningService = {
    port: guard.port,
    token,
    url: `http://127.0.0.1:${guard.port}`,
    journals,
    stop: () => (stopped ??= shutdown({ store, nonce, api, journals, logger, commands, flows })),
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
