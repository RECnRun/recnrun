import * as v from "valibot";

const MillisecondsSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** The one recording in progress, shared by every extension view; absent when nothing records. */
export const RecordingSessionSchema = v.object({
  /** The browser tab it records. */
  tabId: v.pipe(v.number(), v.integer(), v.minValue(0)),
  status: v.picklist(["recording", "paused"]),
  /** Milliseconds recorded before the current run. */
  banked: MillisecondsSchema,
  /** When the current run started or paused, as epoch milliseconds. */
  since: MillisecondsSchema,
});

export type RecordingSession = v.InferOutput<typeof RecordingSessionSchema>;
