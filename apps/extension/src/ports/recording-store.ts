import type { RecordingSession } from "@recnrun/domain";

/** Where the recording in progress lives, so the background and every extension view share one. */
export interface RecordingStore {
  read: () => Promise<RecordingSession | null>;
  write: (session: RecordingSession | null) => Promise<void>;
  /** Calls back after any page writes; returns the unsubscribe function. */
  watch: (onChange: () => void) => () => void;
}
