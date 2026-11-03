import type { GapPayload, StepResult } from "@recnrun/protocol";
import { describe, expect, test } from "vite-plus/test";
import { compareRuns } from "../src/index.ts";
import { finished, gap, request, response, started, storedRun } from "./run-builders.ts";

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

  test("a step the lost connection cut short is a collector gap, never the application's", () => {
    const cut = [
      ...clean.slice(0, 3),
      gap({ reason: "connection-lost" }),
      finished("submit", "indeterminate", "connection-lost"),
    ];
    const result = compareRuns(
      storedRun("base", clean, passed("open", "submit")),
      storedRun("now", cut, [
        { stepId: "open", status: "passed" },
        {
          stepId: "submit",
          status: "indeterminate",
          error: { code: "connection-lost", message: "The connection to Chrome was lost." },
        },
      ]),
    );
    expect(result.divergence).toMatchObject({
      kind: "collector-gap",
      reason: "collector-gap",
      stepId: "submit",
      run: { gap: { reason: "connection-lost" } },
    });
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

  test("gaps of one reason that lost another surface or extent are not the same loss", () => {
    const lossy = (payload: GapPayload) => [...clean.slice(0, 3), gap(payload), ...clean.slice(3)];
    const small: GapPayload = { reason: "buffer-exhausted", surface: "dom-events", lost: 1 };
    const large: GapPayload = { reason: "buffer-exhausted", surface: "network", lost: 100 };
    const baseline = storedRun("base", lossy(small), passed("open", "submit"));
    const result = compareRuns(baseline, storedRun("now", lossy(large), passed("open", "submit")));
    expect(result.divergence).toMatchObject({
      kind: "collector-gap",
      stepId: "submit",
      baseline: {},
      run: { gap: large },
    });
    expect(result.divergence?.message).toContain("lost 100 network events");
    const same = storedRun("now", lossy({ ...small, lastSeq: 9 }), passed("open", "submit"));
    expect(compareRuns(baseline, same).divergence).toBeNull();
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
});

describe("compareRuns network evidence", () => {
  test("pairs responses by origin and path, so a query that differs between runs still compares", () => {
    const withResponse = (url: string, status: number) => [
      ...clean.slice(0, 3),
      response(url, status),
      ...clean.slice(4),
    ];
    const result = compareRuns(
      storedRun("base", withResponse(`${SAVE}?v=1`, 200), passed("open", "submit")),
      storedRun("now", withResponse(`${SAVE}?fail=api-500`, 500), passed("open", "submit")),
    );
    expect(result.divergence).toMatchObject({
      kind: "application",
      reason: "network-status",
      stepId: "submit",
      baseline: { url: `${SAVE}?v=1`, httpStatus: 200 },
      run: { url: `${SAVE}?fail=api-500`, httpStatus: 500 },
    });
  });

  test("pairs responses through their requests, so completion order does not matter", () => {
    const ITEMS = "http://127.0.0.1:4600/api/items";
    const around = (...responses: ReturnType<typeof response>[]) => [
      ...clean.slice(0, 3),
      request("get", ITEMS, "GET"),
      request("post", ITEMS, "POST"),
      ...responses,
      ...clean.slice(4),
    ];
    const get = (status: number) => response(ITEMS, status, "work", "get");
    const post = (status: number) => response(ITEMS, status, "work", "post");
    const baseline = storedRun("base", around(get(200), post(201)), passed("open", "submit"));
    const reversed = storedRun("now", around(post(201), get(200)), passed("open", "submit"));
    expect(compareRuns(baseline, reversed).divergence).toBeNull();
    const failing = storedRun("now", around(post(500), get(200)), passed("open", "submit"));
    expect(compareRuns(baseline, failing).divergence).toMatchObject({
      kind: "application",
      reason: "network-status",
      stepId: "submit",
      baseline: { url: ITEMS, httpStatus: 201 },
      run: { url: ITEMS, httpStatus: 500 },
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
