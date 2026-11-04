import { describe, expect, test } from "vite-plus/test";
import { historyProblems, uiProblems } from "./fixtures/downloads-traces.ts";

// Codex P1 finding 8: the traces verdicts rest on what was observed, not on the probe alone.
const PROBE = "/root/downloads/RECnRun/poc/e2-1/probe.json";
const written = { ok: true, filename: PROBE } as const;
const chromeWindow = "RECnRun diagnostics - Google Chrome";

describe("historyProblems", () => {
  test("one write on a fresh profile leaves exactly its own history entry", () => {
    expect(historyProblems(written, { ok: true, filenames: [PROBE] })).toEqual([]);
  });

  test("a history query that failed is not a trace", () => {
    expect(historyProblems(written, { ok: false, error: "search unavailable" })).toEqual([
      "the history query failed: search unavailable",
    ]);
  });

  test("no entry, or more than the one write, fails", () => {
    expect(historyProblems(written, { ok: true, filenames: [] })).toEqual([
      "0 history entries after one write on a fresh profile, not 1",
    ]);
    expect(historyProblems(written, { ok: true, filenames: ["/elsewhere/other.json"] })).toEqual([
      "the history entry is /elsewhere/other.json, not the probe",
    ]);
  });
});

describe("uiProblems", () => {
  const seen = { before: [chromeWindow], after: [chromeWindow], screenshotBytes: 2048 };

  test("Chrome's window listed before and after, with a screenshot, holds", () => {
    expect(uiProblems(written, seen)).toEqual([]);
  });

  test("an empty display, the review's in-memory control, fails", () => {
    const empty = { before: [], after: [], screenshotBytes: 0 };
    expect(uiProblems(written, empty)).toEqual([
      "the display listed no Google Chrome window before and after the write",
      "no screenshot of the display",
    ]);
  });

  test("a failed probe fails both", () => {
    const failed = { ok: false, error: "Invalid filename" } as const;
    expect(uiProblems(failed, seen)).toEqual(["the probe failed: Invalid filename"]);
    expect(historyProblems(failed, { ok: true, filenames: [] })[0]).toBe(
      "the probe failed: Invalid filename",
    );
  });
});
