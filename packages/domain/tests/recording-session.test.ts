import * as v from "valibot";
import { expect, test } from "vite-plus/test";
import { elapsedSeconds, formatElapsed, RecordingSessionSchema, toggled } from "../src/index.ts";

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

test("elapsed time counts only the runs spent recording", () => {
  const started = { tabId: 3, status: "recording" as const, banked: 0, since: 1_000 };
  expect(elapsedSeconds(started, 4_500)).toBe(3);

  const paused = toggled(started, 4_500);
  expect(paused).toEqual({ tabId: 3, status: "paused", banked: 3_500, since: 4_500 });
  expect(elapsedSeconds(paused, 60_000)).toBe(3);

  const resumed = toggled(paused, 60_000);
  expect(resumed).toEqual({ tabId: 3, status: "recording", banked: 3_500, since: 60_000 });
  expect(elapsedSeconds(resumed, 62_000)).toBe(5);
});

test("a session another view started a moment ahead shows no negative time", () => {
  expect(elapsedSeconds({ tabId: 3, status: "recording", banked: 0, since: 5_000 }, 4_900)).toBe(0);
});

test("elapsed time reads as minutes and seconds", () => {
  expect(formatElapsed(0)).toBe("00:00");
  expect(formatElapsed(61)).toBe("01:01");
  expect(formatElapsed(3_600)).toBe("60:00");
});
