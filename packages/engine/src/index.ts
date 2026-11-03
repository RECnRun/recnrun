import {
  PROTOCOL_SCHEMA_VERSION,
  type AdapterEvent,
  type BrowserHandshake,
  type CdpTarget,
  type ChromeChannel,
  type ConnectionSource,
  type DiscoveryResult,
  type ProfileDescription,
  type ReconnectResult,
} from "@recnrun/protocol";
import type { ReplayDriver } from "./replay/index.ts";

/**
 * What the engine needs from a browser; packages/adapter implements it over CDP. The replay
 * methods (`inspect`, `readAttribute`, `tabs`, `act`) act on the replay's own tabs.
 */
export interface BrowserAdapter extends ReplayDriver {
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
  /** The profile behind the connection: its folder, the browser contexts seen, and Chrome's version. */
  describeProfile(): Promise<ProfileDescription>;
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

export {
  classifyBinding,
  detectDuplicateBinding,
  resolveActorBindings,
  type ActorResolution,
  type BindingConflict,
} from "./bindings.ts";
export {
  defineMachine,
  type IllegalTransition,
  type Transition,
  type TransitionTable,
} from "./machine.ts";
export * from "./machines.ts";
export * from "./session.ts";
export * from "./lease.ts";
export { normalize, type NormalizeOptions } from "./normalization/index.ts";
export { suggestLocators, type LocatorHints } from "./normalization/locators.ts";
export { replayableAssertion, toFlowSteps } from "./normalization/flow-steps.ts";
export * from "./replay/index.ts";
