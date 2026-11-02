import type { BrowserAdapter } from "@recnrun/engine";
import type { AdapterEvent } from "@recnrun/protocol";
import { connect, type CdpConnection, type ConnectOptions } from "./connection.ts";
import { discover } from "./discovery.ts";

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
  return {
    discover: (options) => (deps.discover ?? discover)(options ?? {}),
    async connect(endpoint, options) {
      current = await connect(endpoint, { ...deps, onEvent, source: options?.source });
      return current.handshake;
    },
    listTargets: async () => connected().listTargets(),
    async reconnect() {
      const outcome = await connected().reconnect();
      if (!outcome.ok) return outcome;
      current = outcome.connection;
      return { ok: true, handshake: current.handshake };
    },
    async disconnect() {
      await current?.disconnect();
      current = undefined;
    },
    onEvent(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    describeProfile: async () => connected().describeProfile(),
  };
}
