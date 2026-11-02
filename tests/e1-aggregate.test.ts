import { describe, expect, test } from "vite-plus/test";
import { aggregate } from "./experiments/e1-aggregate.ts";
import type { ProbeResult } from "./experiments/e1-aggregate.ts";

const CHROME = "Google Chrome 156.0.8078.79";

function sample(status: ProbeResult["status"], extra: Partial<ProbeResult> = {}): ProbeResult {
  return { id: "worker-close-target", status, ...extra };
}

describe("E1 aggregate", () => {
  test("keeps the detail of every sample, in order", () => {
    const { capability } = aggregate(
      "attach-dedicated-worker",
      [
        sample("allowed", { detail: { targetId: "A" } }),
        sample("allowed", { detail: { targetId: "B" } }),
        sample("allowed"),
      ],
      CHROME,
    );
    expect(capability).toEqual({
      status: "allowed",
      statuses: ["allowed", "allowed", "allowed"],
      details: [{ targetId: "A" }, { targetId: "B" }, null],
    });
  });

  test("a sample that differs makes the probe rejected with every error", () => {
    const { verdict, capability } = aggregate(
      "worker-close-target",
      [sample("allowed"), sample("rejected", { error: "worker still listed" }), sample("allowed")],
      CHROME,
    );
    expect(capability.status).toBe("rejected");
    expect(verdict).toMatchObject({
      experiment: "E1",
      hypothesis: "worker-close-target",
      verdict: "fail",
      error: "inconsistent across samples (allowed, rejected, allowed): worker still listed",
      chrome: CHROME,
      samples: 3,
    });
    expect(verdict.variants?.[1]).toEqual({
      name: "sample 2",
      verdict: "fail",
      error: "worker still listed",
    });
  });

  test("unavailable samples do not count as run", () => {
    const { verdict } = aggregate("tab-attach", [sample("unavailable")], CHROME);
    expect(verdict).toMatchObject({ verdict: "unavailable", samples: 0 });
  });
});
