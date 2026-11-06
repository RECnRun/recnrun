import { errorMessage } from "@recnrun/domain";

/*
 * P3.2 (POC PLAN.md): a POC profile pairs through Downloads with no page open and no gesture, so
 * every presence it writes once Chrome told it the root starts the folder flow, or starts it again.
 */

export interface DownloadsPairingDependencies {
  /** The Downloads transport's `available()`: whether Chrome told this profile its root. */
  available: () => Promise<boolean>;
  /** The folder flow's start, which keeps its state and pauses and asks the offscreen document to watch. */
  start: () => Promise<void>;
  log: (entry: string) => void;
}

/**
 * Starts pairing after a presence. Starting again is harmless and brings the watch back after
 * Chrome closed the offscreen document; one that fails waits for the next presence.
 */
export function createDownloadsPairing(deps: DownloadsPairingDependencies) {
  let running: Promise<void> | undefined;
  const attempt = async () => {
    if (await deps.available()) await deps.start();
  };
  return () => {
    running ??= attempt()
      .catch((error: unknown) => deps.log(`downloads pairing: ${errorMessage(error)}`))
      .finally(() => {
        running = undefined;
      });
    return running;
  };
}
