import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { RecordingSessionSchema } from "../src/index.ts";

test("accepts a recording or paused session", () => {
  expect(v.is(RecordingSessionSchema, { status: "recording", banked: 0, since: 1_000 })).toBe(true);
  expect(v.is(RecordingSessionSchema, { status: "paused", banked: 3_500, since: 4_500 })).toBe(
    true,
  );
});

test("rejects an unknown status and negative or fractional times", () => {
  expect(v.is(RecordingSessionSchema, { status: "idle", banked: 0, since: 0 })).toBe(false);
  expect(v.is(RecordingSessionSchema, { status: "recording", banked: -1, since: 0 })).toBe(false);
  expect(v.is(RecordingSessionSchema, { status: "recording", banked: 0, since: 1.5 })).toBe(false);
});
