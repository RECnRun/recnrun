import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { RecordingSessionSchema } from "../src/index.ts";

const session = { tabId: 7, status: "recording", banked: 0, since: 1_000 };

test("accepts a recording or paused session of a tab", () => {
  expect(v.is(RecordingSessionSchema, session)).toBe(true);
  expect(v.is(RecordingSessionSchema, { ...session, status: "paused", banked: 3_500 })).toBe(true);
});

test("rejects an unknown status and negative or fractional times", () => {
  expect(v.is(RecordingSessionSchema, { ...session, status: "idle" })).toBe(false);
  expect(v.is(RecordingSessionSchema, { ...session, banked: -1 })).toBe(false);
  expect(v.is(RecordingSessionSchema, { ...session, since: 1.5 })).toBe(false);
});

test("rejects a session without the tab it records", () => {
  const { tabId: _, ...untargeted } = session;
  expect(v.is(RecordingSessionSchema, untargeted)).toBe(false);
  expect(v.is(RecordingSessionSchema, { ...session, tabId: -1 })).toBe(false);
  expect(v.is(RecordingSessionSchema, { ...session, tabId: 1.5 })).toBe(false);
});
