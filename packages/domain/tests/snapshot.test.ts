import * as v from "valibot";
import { describe, expect, test } from "vite-plus/test";
import { emptySnapshot, SnapshotSchema } from "../src/index.ts";
import { sampleSnapshot } from "./fixtures.ts";

function withFirstRecording(changes: Record<string, unknown>) {
  const snapshot = sampleSnapshot();
  const [first, ...rest] = snapshot.recordings;
  return { ...snapshot, recordings: [{ ...first, ...changes }, ...rest] };
}

describe("SnapshotSchema", () => {
  test("accepts the sample and the empty snapshot", () => {
    expect(v.is(SnapshotSchema, sampleSnapshot())).toBe(true);
    expect(v.is(SnapshotSchema, emptySnapshot())).toBe(true);
  });

  test("rejects an unknown schema version", () => {
    expect(v.is(SnapshotSchema, { ...emptySnapshot(), schemaVersion: 2 })).toBe(false);
  });

  test("rejects a blank name, an invalid start URL, and a date that is not ISO", () => {
    expect(v.is(SnapshotSchema, withFirstRecording({ name: "   " }))).toBe(false);
    expect(v.is(SnapshotSchema, withFirstRecording({ startUrl: "nope" }))).toBe(false);
    expect(v.is(SnapshotSchema, withFirstRecording({ createdAt: "yesterday" }))).toBe(false);
  });

  test("rejects negative or fractional counts", () => {
    expect(v.is(SnapshotSchema, withFirstRecording({ durationMs: -1 }))).toBe(false);
    expect(v.is(SnapshotSchema, withFirstRecording({ eventCount: 1.5 }))).toBe(false);
  });

  test("rejects two recordings with the same id", () => {
    expect(v.is(SnapshotSchema, withFirstRecording({ id: "rec-checkout" }))).toBe(false);
  });
});
