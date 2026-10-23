import { expect, test } from "vite-plus/test";
import { elapsedSeconds, formatElapsed, toggled } from "@/dashboard/panel/recording";

test("elapsed time counts only the runs spent recording", () => {
  const started = { status: "recording" as const, banked: 0, since: 1_000 };
  expect(elapsedSeconds(started, 4_500)).toBe(3);

  const paused = toggled(started, 4_500);
  expect(paused).toEqual({ status: "paused", banked: 3_500, since: 4_500 });
  expect(elapsedSeconds(paused, 60_000)).toBe(3);

  const resumed = toggled(paused, 60_000);
  expect(resumed).toEqual({ status: "recording", banked: 3_500, since: 60_000 });
  expect(elapsedSeconds(resumed, 62_000)).toBe(5);
});

test("an idle clock does not toggle and shows no time", () => {
  const idle = { status: "idle" as const, banked: 0, since: 0 };
  expect(toggled(idle, 5_000)).toBe(idle);
  expect(elapsedSeconds(idle, 5_000)).toBe(0);
});

test("elapsed time reads as minutes and seconds", () => {
  expect(formatElapsed(0)).toBe("00:00");
  expect(formatElapsed(61)).toBe("01:01");
  expect(formatElapsed(3_600)).toBe("60:00");
});
