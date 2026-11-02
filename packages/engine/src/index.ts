import {
  PROTOCOL_SCHEMA_VERSION,
  type AdapterEvent,
  type BrowserHandshake,
  type CdpTarget,
  type ChromeChannel,
  type ConnectionSource,
  type DiscoveryResult,
  type ReconnectResult,
} from "@recnrun/protocol";

/** What the engine needs from a browser; packages/adapter implements it over CDP. */
export interface BrowserAdapter {
  /** Finds a running Chrome through its DevToolsActivePort. */
  discover(options?: { userDataDir?: string; channel?: ChromeChannel }): Promise<DiscoveryResult>;
  /** Connects to `endpoint`; `source` is the DevToolsActivePort a reconnection reads again. */
  connect(endpoint: string, options?: { source?: ConnectionSource }): Promise<BrowserHandshake>;
  listTargets(): Promise<CdpTarget[]>;
  /** Succeeds only when the same DevToolsActivePort names an endpoint that answers again. */
  reconnect(): Promise<ReconnectResult>;
  disconnect(): Promise<void>;
  /** Subscribes to `connection.lost` and `control.contested`; returns the unsubscribe function. */
  onEvent(listener: (event: AdapterEvent) => void): () => void;
}

export interface Engine {
  readonly version: number;
  connect(endpoint: string): Promise<BrowserHandshake>;
  disconnect(): Promise<void>;
}

/** Creates the engine over an adapter, so unit tests can pass a fake one. */
export function createEngine(adapter: BrowserAdapter): Engine {
  return {
    version: PROTOCOL_SCHEMA_VERSION,
    connect: (endpoint) => adapter.connect(endpoint),
    disconnect: () => adapter.disconnect(),
  };
}
