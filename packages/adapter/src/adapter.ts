import type { BrowserAdapter, ReplayDriver } from "@recnrun/engine";
import type { AdapterEvent } from "@recnrun/protocol";
import { connect, type CdpConnection, type ConnectOptions } from "./connection.ts";
import { discover } from "./discovery.ts";
import { createPageDriver } from "./replay.ts";

export type AdapterDependencies = Pick<ConnectOptions, "transport" | "discover" | "now">;

/** The engine's browser adapter over CDP: one connection at a time, events fanned out. */
export function createCdpAdapter(deps: AdapterDependencies = {}): BrowserAdapter {
  let current: CdpConnection | undefined;
  const listeners = new Set<(event: AdapterEvent) => void>();
  const onEvent = (event: AdapterEvent) => {
    for (const listener of listeners) listener(event);
  };
  const connected = (): CdpConnection => {
    if (!current) throw new Error("Not connected to Chrome; call connect() first.");
    return current;
  };
  // One replay tab per connection; a new connection opens its own on the next action.
  let driver: ReplayDriver | undefined;
  const replay = (): ReplayDriver => {
    driver ??= createPageDriver(async () => connected().openPage());
    return driver;
  };
  return {
    discover: (options) => (deps.discover ?? discover)(options ?? {}),
    async connect(endpoint, options) {
      current = await connect(endpoint, { ...deps, onEvent, source: options?.source });
      driver = undefined;
      return current.handshake;
    },
    listTargets: async () => connected().listTargets(),
    async reconnect() {
      const outcome = await connected().reconnect();
      if (!outcome.ok) return outcome;
      current = outcome.connection;
      driver = undefined;
      return { ok: true, handshake: current.handshake };
    },
    async disconnect() {
      await current?.disconnect();
      current = undefined;
      driver = undefined;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    describeProfile: async () => connected().describeProfile(),
    navigate: (url) => replay().navigate(url),
    fill: (target, value) => replay().fill(target, value),
    click: (target) => replay().click(target),
    readText: (target) => replay().readText(target),
  };
}
