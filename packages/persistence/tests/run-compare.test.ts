import type { StepResult } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { compareRuns } from "../src/index.ts";
import { finished, gap, response, started, storedRun } from "./run-builders.ts";

const SAVE = "http://127.0.0.1:4600/api/save";
const passed = (...ids: string[]): StepResult[] =>
  ids.map((stepId) => ({ stepId, status: "passed" }));
const clean = [
  started("open"),
  finished("open", "passed"),
  started("submit"),
  response(SAVE, 200),
  finished("submit", "passed"),
];

describe("compareRuns", () => {
  test("a gap only the baseline has is a collector gap on the baseline's side", () => {
    const lossy = [...clean.slice(0, 4), gap({ reason: "connection-lost" }), ...clean.slice(4)];
    const result = compareRuns(
      storedRun("base", lossy, passed("open", "submit")),
      storedRun("now", clean, passed("open", "submit")),
    );
    expect(result.divergence).toMatchObject({
      kind: "collector-gap",
      stepId: "submit",
      index: 1,
      baseline: { gap: { reason: "connection-lost" } },
      run: {},
    });
    expect(result.divergence?.message).toMatch(/^The baseline lost events/);
  });

  test("a gap both runs have is no divergence, and a gap before any step has no step", () => {
    const both = [...clean, gap({ reason: "buffer-exhausted" })];
    expect(
      compareRuns(
        storedRun("base", both, passed("open", "submit")),
        storedRun("now", both, passed("open", "submit")),
      ).divergence,
    ).toBeNull();
    const early = compareRuns(
      storedRun("base", clean, passed("open", "submit")),
      storedRun("now", [gap({ reason: "target-unattached" }), ...clean], passed("open", "submit")),
    ).divergence;
    expect(early).toMatchObject({ kind: "collector-gap", run: { gap: {} } });
    expect(early?.stepId).toBeUndefined();
  });

  test("blames the replay for a code that is not the application's and the app for a timeout", () => {
    const failing = (code: string) =>
      compareRuns(
        storedRun("base", clean, passed("open", "submit")),
        storedRun(
          "now",
          [...clean.slice(0, 4), finished("submit", "failed", code)],
          [
            { stepId: "open", status: "passed" },
            { stepId: "submit", status: "failed", error: { code, message: `${code} at submit` } },
          ],
        ),
      ).divergence;
    expect(failing("driver-error")).toMatchObject({ kind: "replay", reason: "step-status" });
    expect(failing("timeout")).toMatchObject({
      kind: "application",
      reason: "step-status",
      run: { status: "failed", error: { code: "timeout" } },
    });
  });

  test("ignores nested results and reports a step one ended run never reached", () => {
    const nested: StepResult = { stepId: "open", stepPath: ["loop"], status: "failed" };
    const result = compareRuns(
      storedRun("base", clean, [...passed("open", "submit")], "b".repeat(64)),
      storedRun("now", clean.slice(0, 2), [...passed("open"), nested]),
    );
    expect(result.sameRevision).toBe(false);
    expect(result.steps).toEqual([
      { stepId: "open", index: 0, baseline: "passed", run: "passed" },
      { stepId: "submit", index: 1, baseline: "passed" },
    ]);
    expect(result.divergence).toMatchObject({ kind: "replay", stepId: "submit", run: {} });
    expect(result.divergence?.message).toContain("missing in this run");
  });

  test("an open run compares the steps its journal settled and skips running ones", () => {
    const open = storedRun("now", clean.slice(0, 4));
    const result = compareRuns(storedRun("base", clean, passed("open", "submit")), open);
    expect(result.steps.map(({ run }) => run)).toEqual(["passed", "running"]);
    expect(result.divergence).toBeNull();
    const short = storedRun("now", clean.slice(0, 2));
    expect(compareRuns(storedRun("base", clean, passed("open", "submit")), short).divergence).toBe(
      null,
    );
  });
});
