import type { BrowserAdapter, CaptureHandle, CaptureSink } from "@recnrun/engine";
import type { AdapterEvent } from "@recnrun/protocol";
import { connect, type CdpConnection, type ConnectOptions } from "./connection.ts";
import { discover } from "./discovery.ts";
import { createPageDriver, type PageDriver } from "./replay.ts";
import { observeReplay, type ObserveOptions, type ReplayObserver } from "./replay-observer.ts";

export type AdapterDependencies = Pick<ConnectOptions, "transport" | "discover" | "now"> &
  Pick<ObserveOptions, "openChannel">;

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

/** Replay's tabs and their capture; both belong to one connection and reset with it. */
function replaySide(connected: () => CdpConnection, deps: AdapterDependencies) {
  let driver: PageDriver | undefined;
  let observer: ReplayObserver | undefined;
  const stopCapture = () => {
    observer?.stop();
    observer = undefined;
  };
  return {
    // A new connection opens its own tab on the next write.
    reset: () => (driver = undefined),
    stopCapture,
    driver: (): PageDriver => {
      driver ??= createPageDriver(
        async () => {
          const page = await connected().openPage();
          await observer?.adopt(page);
          return page;
        },
        async (work, ms) => (observer ? observer.muted(work, ms) : work()),
      );
      return driver;
    },
    async onCapture(sink: CaptureSink): Promise<CaptureHandle> {
      stopCapture();
      observer = await observeReplay(connected().endpoint, sink, deps);
      return observer;
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
  const side = replaySide(connected, deps);
  const replay = side.driver;
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
        side.reset();
        return current.handshake;
      }),
    listTargets: async () => connected().listTargets(),
    reconnect: () =>
      lifecycle(async () => {
        const outcome = await connected().reconnect();
        if (!outcome.ok) return outcome;
        current = outcome.connection;
        side.reset();
        return { ok: true, handshake: current.handshake };
      }),
    disconnect: () =>
      lifecycle(async () => {
        side.stopCapture();
        await current?.disconnect();
        current = undefined;
        side.reset();
      }),
    onEvent: events.subscribe,
    onCapture: (sink) => side.onCapture(sink),
    describeProfile: async () => connected().describeProfile(),
    inspect: (target, options) => replay().inspect(target, options),
    readAttribute: (target, name, options) => replay().readAttribute(target, name, options),
    tabs: (options) => replay().tabs(options),
    act: (command, options) => replay().act(command, options),
    capture: (options) => replay().capture(options),
  };
}
