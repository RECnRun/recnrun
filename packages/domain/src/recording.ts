import * as v from "valibot";
import { IdSchema, NameSchema } from "./ids.ts";

const CountSchema = v.pipe(v.number(), v.integer(), v.minValue(0));

/** One captured browser session: where it started, when, and how much it holds. */
export const RecordingSchema = v.object({
  id: IdSchema,
  name: NameSchema,
  startUrl: v.pipe(v.string(), v.url()),
  createdAt: v.pipe(v.string(), v.isoTimestamp()),
  durationMs: CountSchema,
  eventCount: CountSchema,
});

export type Recording = v.InferOutput<typeof RecordingSchema>;
