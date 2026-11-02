import { PROTOCOL_SCHEMA_VERSION } from "@recnrun/protocol";

/** What the engine needs from a browser; packages/adapter implements it over CDP. */
export interface BrowserAdapter {
  connect(endpoint: string): Promise<void>;
  disconnect(): Promise<void>;
}

export interface Engine {
  readonly version: number;
  connect(endpoint: string): Promise<void>;
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
