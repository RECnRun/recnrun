import * as v from "valibot";
import { CountSchema, NonEmptyStringSchema } from "./common.ts";
import { typedEvent } from "./events.ts";
import { BODY_ENCODINGS, BodyRefSchema, Sha256Schema } from "./network.ts";

/** When the replay captures the page: around each action, and when a step does not pass. */
export const SNAPSHOT_MILESTONES = ["before", "after", "failure"] as const;

/** Why a snapshot part holds no blob. */
export const SNAPSHOT_UNAVAILABLE_REASONS = ["no-tab", "over-cap", "capture-failed"] as const;

/** A DOM snapshot over this many bytes keeps its first bytes and is `truncated`. */
export const MAX_DOM_SNAPSHOT_BYTES = 2_097_152;

/** A screenshot over this many bytes is not stored: a cut PNG is no image. */
export const MAX_SCREENSHOT_BYTES = 8_388_608;

const UnavailablePartSchema = v.strictObject({
  condition: v.literal("unavailable"),
  reason: v.picklist(SNAPSHOT_UNAVAILABLE_REASONS),
});

/** The serialized HTML or the screenshot of a milestone: a blob, or why there is none. */
export const SnapshotPartSchema = v.union([BodyRefSchema, UnavailablePartSchema]);

export const SnapshotPayloadSchema = v.strictObject({
  milestone: v.picklist(SNAPSHOT_MILESTONES),
  // The page's URL when it was captured; absent when no tab was open.
  url: v.optional(v.string()),
  dom: SnapshotPartSchema,
  screenshot: SnapshotPartSchema,
});

/** One milestone of a step (`stepId` in the envelope), journaled by the replay. */
export const SnapshotEventSchema = typedEvent("snapshot", "captured", SnapshotPayloadSchema);

/** `run.getArtifact`: one blob a run's events reference. */
export const ArtifactRequestSchema = v.strictObject({
  runId: NonEmptyStringSchema,
  sha256: Sha256Schema,
});

export const ArtifactSchema = v.strictObject({
  sha256: Sha256Schema,
  mime: v.string(),
  encoding: v.picklist(BODY_ENCODINGS),
  // Bytes stored, which a truncated blob keeps fewer of than its event's `size`.
  size: CountSchema,
  // `utf8` blobs as text, `binary` blobs as base64.
  data: v.string(),
});

export type SnapshotMilestone = (typeof SNAPSHOT_MILESTONES)[number];
export type SnapshotPart = v.InferOutput<typeof SnapshotPartSchema>;
export type SnapshotPayload = v.InferOutput<typeof SnapshotPayloadSchema>;
export type SnapshotEvent = v.InferOutput<typeof SnapshotEventSchema>;
export type Artifact = v.InferOutput<typeof ArtifactSchema>;
