import { createCdpAdapter, startPicker, startRecording, type BodySink } from "@recnrun/adapter";
import type { ReplayDriver } from "@recnrun/engine";
import type { CapturedEvent, DiscoveryResult, DomTarget } from "@recnrun/protocol";
import { ServiceFailure } from "./dispatch.ts";

/** A recording's page and the calls that end it. */
export interface RecordingHandle {
  readonly targetId: string;
  settled(): Promise<void>;
  stop(): void;
}

export interface PickerHandle {
  stop(): Promise<void>;
}

/** A replay's own connection to Chrome. */
export interface DriverHandle {
  readonly driver: ReplayDriver;
  close(): Promise<void>;
}

/** What the service needs from Chrome; tests pass a fake, the service the CDP adapter. */
export interface BrowserPort {
  /** Finds the Chrome of the default profile, or of the profile folder of a binding. */
  discover(options?: { userDataDir?: string }): Promise<DiscoveryResult>;
  /** Opens the session's own page and captures it, the pages it opens, and their frames; bodies go to `blobs`. */
  record(
    endpoint: string,
    capture: { runId: string; onEvent: (event: CapturedEvent) => void; blobs?: BodySink },
  ): Promise<RecordingHandle>;
  /** Shows the picker overlay on `targetId`; a click reports the element instead of reaching the page. */
  pick(
    endpoint: string,
    targetId: string,
    onPicked: (target: DomTarget) => void,
  ): Promise<PickerHandle>;
  /** Connects a replay driver of its own. */
  replayDriver(endpoint: string): Promise<DriverHandle>;
}

export function createBrowserPort(): BrowserPort {
  return {
    discover: (options) => createCdpAdapter().discover(options),
    record: (endpoint, capture) => startRecording(endpoint, { capture }),
    pick: (endpoint, targetId, onPicked) => startPicker(endpoint, targetId, { onPicked }),
    async replayDriver(endpoint) {
      const adapter = createCdpAdapter();
      await adapter.connect(endpoint);
      return { driver: adapter, close: () => adapter.disconnect() };
    },
  };
}

/** The browser endpoint of the profile; no running Chrome is a refusal that carries the remedy. */
export async function endpointOf(browser: BrowserPort, userDataDir?: string): Promise<string> {
  const found = await browser.discover(userDataDir === undefined ? {} : { userDataDir });
  if (!found.ok) throw new ServiceFailure("capability-unavailable", found.remedy);
  return found.wsEndpoint;
}
