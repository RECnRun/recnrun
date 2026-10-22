import * as v from "valibot";
import { RecordingSchema } from "./recording.ts";

const SNAPSHOT_SCHEMA_VERSION = 1;

/** Everything the extension stores, as one versioned document. */
export const SnapshotSchema = v.object({
  schemaVersion: v.literal(SNAPSHOT_SCHEMA_VERSION),
  recordings: v.pipe(
    v.array(RecordingSchema),
    v.check(
      (recordings) =>
        new Set(recordings.map((recording) => recording.id)).size === recordings.length,
      "Recording ids must be unique.",
    ),
  ),
});

export type Snapshot = v.InferOutput<typeof SnapshotSchema>;

export function emptySnapshot(): Snapshot {
  return { schemaVersion: SNAPSHOT_SCHEMA_VERSION, recordings: [] };
}
