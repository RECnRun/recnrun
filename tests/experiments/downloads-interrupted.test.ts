import { describe, expect, test } from "vite-plus/test";
import { interruptionProblems, NETWORK, USER_CANCELED } from "./fixtures/downloads-interrupted.ts";
import type { Interruption } from "./fixtures/downloads-interrupted.ts";

// Codex P1 finding 6: an interruption verdict needs the partial, the state, the exact publication, and the cleanup.
const previous = { profileId: "p-1", displayName: "E2", createdAt: 1, expiresAt: 30_001 };
const kept = { publication: { ...previous }, reason: "fresh" };

/** A cancel as the committed lab samples saw it. */
const cancelled: Interruption = {
  during: ["Unconfirmed 288769.crdownload"],
  readDuring: kept,
  settledInWait: true,
  settled: {
    state: "interrupted",
    error: "USER_CANCELED",
    filename: "<root>/downloads/x/probe.json",
  },
  entries: ["probe.json"],
  strays: [],
  bytesKept: true,
  readAfter: kept,
};

describe("interruptionProblems", () => {
  test("a cancel that left a partial while running and nothing after holds", () => {
    expect(interruptionProblems(cancelled, previous, USER_CANCELED)).toEqual([]);
  });

  test("the review's control, no partial seen and the download already complete, fails", () => {
    const control = {
      ...cancelled,
      during: [],
      settled: { state: "complete", filename: "<root>/downloads/x/probe.json" },
    };
    const problems = interruptionProblems(control, previous, USER_CANCELED);
    expect(problems).toContain("no .crdownload was seen while the download ran");
    expect(problems).toContain("the item settled as complete, not interrupted");
  });

  test("a network hypothesis that needed the harness's cancel fails", () => {
    const fallback = { ...cancelled, settledInWait: false };
    const problems = interruptionProblems(fallback, previous, NETWORK);
    expect(problems).toContain("the download still ran after the wait; the harness cancelled it");
    expect(problems).toContain("the item settled with USER_CANCELED, not NETWORK_*");
  });

  test("a network interruption Chrome settled by itself, with nothing left behind, holds", () => {
    const network = {
      ...cancelled,
      settled: {
        state: "interrupted",
        error: "NETWORK_FAILED",
        filename: "<root>/downloads/x/probe.json",
      },
    };
    expect(interruptionProblems(network, previous, NETWORK)).toEqual([]);
  });

  test("a read with the same profile but another publication is not the retained one", () => {
    const other = { publication: { ...previous, createdAt: 2 }, reason: "fresh" };
    const problems = interruptionProblems(
      { ...cancelled, readAfter: other },
      previous,
      USER_CANCELED,
    );
    expect(problems).toContain(
      "the reader did not answer the exact previous publication after the stop",
    );
  });

  test("a partial left after the stop, or changed bytes, fails", () => {
    const left = {
      ...cancelled,
      entries: ["probe.json", "Unconfirmed 1.crdownload"],
      strays: ["stall.json"],
      bytesKept: false,
    };
    const problems = interruptionProblems(left, previous, USER_CANCELED);
    expect(problems).toContain("left after the stop: Unconfirmed 1.crdownload, stall.json");
    expect(problems).toContain("probe.json no longer holds the previous publication");
  });
});
