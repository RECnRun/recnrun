import {
  createCdpAdapter,
  shareChrome,
  startPicker,
  startRecording,
  type BodySink,
} from "@recnrun/adapter";
import type { ReplayDriver } from "@recnrun/engine";
import type { CapturedEvent, DiscoveryResult, DomTarget } from "@recnrun/protocol";
import { ServiceFailure } from "./dispatch.ts";

/** A recording's page and the calls that end it. */
export interface RecordingHandle {
  readonly targetId: string;
  /** Stops starting new reads and waits for capture under way, within the adapter's deadline. */
  drain(): Promise<void>;
  stop(): void;
}

export interface PickerHandle {
  stop(): Promise<void>;
}

/** A replay's own driver over the service's connection to Chrome. */
export interface DriverHandle {
  readonly driver: ReplayDriver;
  close(): Promise<void>;
}

/** What the service needs from Chrome; tests pass a fake, the service the CDP adapter. */
export interface BrowserPort {
  /** Finds the Chrome of the default profile, or of the profile folder of a binding. */
  discover(options?: { userDataDir?: string }): Promise<DiscoveryResult>;
  /**
   * Opens the session's own page and captures it, the pages it opens, and their frames; bodies go
   * to `blobs`. `onEvent` answers the event's journal write, so the hook is acknowledged after it.
   */
  record(
    endpoint: string,
    capture: {
      runId: string;
      onEvent: (event: CapturedEvent) => void | Promise<void>;
      blobs?: BodySink;
    },
  ): Promise<RecordingHandle>;
  /** Shows the picker overlay on `targetId`; a click reports the element instead of reaching the page. */
  pick(
    endpoint: string,
    targetId: string,
    onPicked: (target: DomTarget) => void,
  ): Promise<PickerHandle>;
  /** Connects a replay driver with tabs of its own. */
  replayDriver(endpoint: string): Promise<DriverHandle>;
  /** Closes every connection to Chrome, once sessions and replays have ended. */
  close(): Promise<void>;
}

/** One socket and one Playwright connection per Chrome, shared by every command (F3.11). */
export function createBrowserPort(): BrowserPort {
  const shared = shareChrome();
  const openChannel = (endpoint: string) => shared.lane(endpoint);
  return {
    discover: (options) => createCdpAdapter().discover(options),
    record: (endpoint, capture) => startRecording(endpoint, { capture, openChannel }),
    pick: (endpoint, targetId, onPicked) =>
      startPicker(endpoint, targetId, { onPicked, openChannel }),
    async replayDriver(endpoint) {
      // An adapter per run keeps each run's tabs its own over the shared connection.
      const adapter = createCdpAdapter({ transport: shared.transport, openChannel });
      await adapter.connect(endpoint);
      return { driver: adapter, close: () => adapter.disconnect() };
    },
    close: () => shared.close(),
  };
}

/** The browser endpoint of the profile; no running Chrome is a refusal that carries the remedy. */
export async function endpointOf(browser: BrowserPort, userDataDir?: string): Promise<string> {
  const found = await browser.discover(userDataDir === undefined ? {} : { userDataDir });
  if (!found.ok) throw new ServiceFailure("capability-unavailable", found.remedy);
  return found.wsEndpoint;
}
