import type { BrowserAdapter, ReplayDriver } from "@recnrun/engine";
import type { AdapterEvent } from "@recnrun/protocol";
import { connect, type CdpConnection, type ConnectOptions } from "./connection.ts";
import { discover } from "./discovery.ts";
import { createPageDriver } from "./replay.ts";

export type AdapterDependencies = Pick<ConnectOptions, "transport" | "discover" | "now">;

/** `connect()` while a connection is open; `disconnect()` first. */
export class AlreadyConnectedError extends Error {
  readonly code = "already-connected";

  constructor(endpoint: string) {
    super(`Already connected to ${endpoint}; call disconnect() before connecting again.`);
    this.name = "AlreadyConnectedError";
  }
}

/** Runs each lifecycle call after the previous one settles, so connects and disconnects never interleave. */
function serialized() {
  let tail: Promise<unknown> = Promise.resolve();
  return <T>(work: () => Promise<T>): Promise<T> => {
    const next = tail.then(work);
    tail = next.catch(() => undefined);
    return next;
  };
}

function fanOut() {
  const listeners = new Set<(event: AdapterEvent) => void>();
  return {
    emit: (event: AdapterEvent) => {
      for (const listener of listeners) listener(event);
    },
    subscribe: (listener: (event: AdapterEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** The engine's browser adapter over CDP: one connection at a time, events fanned out. */
export function createCdpAdapter(deps: AdapterDependencies = {}): BrowserAdapter {
  let current: CdpConnection | undefined;
  const lifecycle = serialized();
  const events = fanOut();
  const connected = (): CdpConnection => {
    if (!current) throw new Error("Not connected to Chrome; call connect() first.");
    return current;
  };
  // Replay tabs belong to one connection; a new connection opens its own on the next write.
  let driver: ReplayDriver | undefined;
  const replay = (): ReplayDriver => {
    driver ??= createPageDriver(async () => connected().openPage());
    return driver;
  };
  return {
    discover: (options) => (deps.discover ?? discover)(options ?? {}),
    connect: (endpoint, options) =>
      lifecycle(async () => {
        if (current) throw new AlreadyConnectedError(current.endpoint);
        current = await connect(endpoint, {
          ...deps,
          onEvent: events.emit,
          source: options?.source,
        });
        driver = undefined;
        return current.handshake;
      }),
    listTargets: async () => connected().listTargets(),
    reconnect: () =>
      lifecycle(async () => {
        const outcome = await connected().reconnect();
        if (!outcome.ok) return outcome;
        current = outcome.connection;
        driver = undefined;
        return { ok: true, handshake: current.handshake };
      }),
    disconnect: () =>
      lifecycle(async () => {
        await current?.disconnect();
        current = undefined;
        driver = undefined;
      }),
    onEvent: events.subscribe,
    describeProfile: async () => connected().describeProfile(),
    inspect: (target, options) => replay().inspect(target, options),
    readAttribute: (target, name, options) => replay().readAttribute(target, name, options),
    tabs: () => replay().tabs(),
    act: (command, options) => replay().act(command, options),
  };
}
