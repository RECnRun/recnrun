import { RecordingSessionSchema } from "@recnrun/domain";
import type { RecordingSession } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";

// Session storage ends with the browser, as a recording in progress does.
const sessionItem = storage.defineItem<unknown>("session:recording");

/** Reads the recording in progress, validating it like every stored value. */
async function read(): Promise<RecordingSession | null> {
  const stored = await sessionItem.getValue();
  if (stored === null) return null;
  const parsed = v.safeParse(RecordingSessionSchema, stored);
  if (!parsed.success) throw new Error("The stored recording does not match the current schema.");
  return parsed.output;
}

/** Shares the recording in progress between the dashboard tab, its frames, and the PiP panel. */
export const recordingSessionRepository = {
  read,
  write: (session: RecordingSession | null) => sessionItem.setValue(session),
  /** Calls back on every change from any extension page; read() gives the new value. */
  watch: (onChange: () => void) => sessionItem.watch(onChange),
};
