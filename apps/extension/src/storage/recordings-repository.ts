import { IdSchema } from "@recnrun/domain";
import * as v from "valibot";
import { storage } from "wxt/utils/storage";

/** The workflow a tab group records, and the dashboard origin whose own events are skipped. */
const RecordingBindingSchema = v.object({
  workflowId: IdSchema,
  dashboardOrigin: v.optional(v.string()),
});

// Storage keys are strings, so group ids are stored as their decimal text.
const RecordingsSchema = v.record(v.pipe(v.string(), v.digits()), RecordingBindingSchema);

export type RecordingBinding = v.InferOutput<typeof RecordingBindingSchema>;
export type Recordings = Map<number, RecordingBinding>;

const recordingsItem = storage.defineItem<unknown>("local:recordings");

/** Reads every active recording by tab group, validating because storage outlives schema changes. */
export async function readRecordings(): Promise<Recordings> {
  const stored = await recordingsItem.getValue();
  if (stored === null) return new Map();
  const parsed = v.safeParse(RecordingsSchema, stored);
  if (!parsed.success) throw new Error("The stored recordings do not match the current schema.");
  return new Map(
    Object.entries(parsed.output).map(([groupId, binding]) => [Number(groupId), binding]),
  );
}

export async function bindRecording(groupId: number, binding: RecordingBinding): Promise<void> {
  const recordings = await readRecordings();
  recordings.set(groupId, binding);
  await write(recordings);
}

export async function unbindRecording(groupId: number): Promise<void> {
  const recordings = await readRecordings();
  if (!recordings.delete(groupId)) return;
  await write(recordings);
}

/** The tab group recording the workflow, if any. */
export async function findRecordingGroup(workflowId: string): Promise<number | undefined> {
  for (const [groupId, binding] of await readRecordings()) {
    if (binding.workflowId === workflowId) return groupId;
  }
  return undefined;
}

function write(recordings: Recordings): Promise<void> {
  const entries = [...recordings].map(([groupId, binding]) => [String(groupId), binding]);
  return recordingsItem.setValue(Object.fromEntries(entries));
}
